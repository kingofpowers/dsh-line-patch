/** Drift detection: the single pre-step notice that is replaced as state changes. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** Stub host that records listeners and the session's append stream. */
function makeHost() {
  const tools = new Map()
  const listeners = new Map()
  const emitted = []
  const appended = []
  const resolveCalls = []
  let reads = 0
  let seq = 0
  const session = {
    append: (type, data, meta = {}) => {
      seq += 1
      const event = { seq, type, data, ...meta }
      appended.push(event)
      return event
    },
  }
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition) } },
    on: (name, handler) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
    },
    emit: (...args) => { emitted.push(args) },
    waterfall: async (_name, _target, _actor, next) => next(),
    fs: {
      async resolve(p, options = {}) {
        resolveCalls.push({ path: p, options })
        return { targetKey: p, displayPath: p }
      },
      async stat(target) {
        const stats = await import('node:fs/promises').then(m => m.stat(target.targetKey)).catch(() => undefined)
        if (!stats) return undefined
        return { type: 'file', size: stats.size, version: `${stats.size}:${stats.mtimeMs}` }
      },
      async readText(target) { reads += 1; return readFile(target.targetKey, 'utf8') },
      async writeText(target, content) {
        await writeFile(target.targetKey, content)
        const after = await import('node:fs/promises').then(m => m.stat(target.targetKey))
        return { operation: 'update', version: `${after.size}:${after.mtimeMs}` }
      },
      processPath(target) { return target.targetKey },
    },
  }
  apply(ctx)

  /** Deliver one host event to every registered listener. */
  const fire = async (name, ...args) => {
    let result
    for (const handler of listeners.get(name) ?? []) result = await handler(...args)
    return result
  }

  /**
   * Run one `agent/pre-step` waterfall the way the host does: the listener
   * returns a decision whose `messages` the host then appends to the session.
   */
  const preStep = async (override = {}) => {
    const payload = { agent: { id: 'agent-1' }, messages: [], signal: { aborted: false }, step: 1, ...override }
    let decision
    for (const handler of listeners.get('agent/pre-step') ?? []) {
      decision = await handler(payload, () => ({ kind: 'accept', messages: [] }))
    }
    decision ??= { kind: 'accept', messages: [] }
    for (const message of decision.messages ?? []) {
      // The host appends and then emits the event our listener uses to track the notice.
      const event = session.append('user/message', message, { surfaceOp: 'append' })
      await fire('session/event', session, event)
    }
    return decision
  }

  return { ctx, tools, emitted, appended, session, fire, preStep, reads: () => reads, resolveCalls }
}

/** Create a temp file bound to a stub host. */
async function fixture(content) {
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-rev-'))
  const file = join(dir, 'sample.txt')
  await writeFile(file, content)
  return { file, host: makeHost() }
}

/** Annotate one tool result, which is what registers an anchor. */
async function anchorFrom(host, file, toolName = 'read', callId = 'call-1') {
  return host.fire('tools/post-execute',
    { name: toolName, arguments: { file_path: file }, callId, agent: { id: 'agent-1' } },
    { content: [{ type: 'text', text: '1: a' }], isError: false },
    () => ({ kind: 'accept' }))
}

/** The texts the session actually appended. */
function appendedTexts(host) {
  return host.appended.map(event => event.data.content[0].text)
}

test('an untouched file produces no notice and is not re-read', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  const readsBefore = host.reads()
  await host.preStep()
  assert.deepEqual(appendedTexts(host), [])
  assert.equal(host.reads(), readsBefore, 'the stat prefilter must skip the file read')
})

test('a touch with identical content refreshes the observation without a notice', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  const later = new Date(Date.now() + 5000)
  await utimes(file, later, later)
  await host.preStep()
  assert.deepEqual(appendedTexts(host), [], 'same bytes are not a change')
  const observed = host.emitted.filter(([eventName]) => eventName === 'fs/observed')
  assert.ok(observed.length >= 1, 'the refresh emits an observation')
  const readsAfterRefresh = host.reads()
  await host.preStep()
  assert.equal(host.reads(), readsAfterRefresh, 'the refreshed version must be remembered')
})

test('a real change appends one notice naming the file and no hashes', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 1)
  assert.match(texts[0], /\[line-patch\] 1 file has changed since you last read or wrote it/)
  assert.match(texts[0], new RegExp(file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
  assert.match(texts[0], /Re-read a file before patching it/)
  // Handing over the new hash would let a model pair it with stale line numbers.
  assert.doesNotMatch(texts[0], /[0-9a-f]{6}/, 'the notice must not print any hash at all')
  assert.equal(host.appended[0].surfaceOp, 'append')
})

test('the notice is not repeated while the stale set is unchanged', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  await host.preStep()
  await host.preStep()
  assert.equal(appendedTexts(host).length, 1, 'one live notice, not one per step')
})

test('a second change to the same file needs no new message', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  await writeFile(file, 'a\nCHANGED AGAIN\n')
  await host.preStep()
  assert.equal(appendedTexts(host).length, 1, 'the stale set is unchanged, so the notice still holds')
})

test('a newly stale file replaces the live notice instead of appending another', async () => {
  const { file, host } = await fixture('a\nb\n')
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-rev3-'))
  const second = join(dir, 'second.txt')
  await writeFile(second, 'x\ny\n')
  await anchorFrom(host, file)
  await anchorFrom(host, second)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  const first = host.appended[0]
  await writeFile(second, 'x\nCHANGED\n')
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 2)
  assert.match(texts[1], /2 files have changed/)
  const replacement = host.appended[1]
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: first.seq, endSeq: first.seq })
  assert.equal(replacement.sourceEventSeqs[0], first.seq)
})

test('re-reading the file closes the notice out', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  // The agent re-reads: a fresh anchor replaces the old one.
  await anchorFrom(host, file, 'read', 'call-2')
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 2)
  assert.match(texts[1], /No files changed since your last read; earlier line-patch notices no longer apply/)
  assert.deepEqual(host.appended[1].surfaceOp, { op: 'replace', startSeq: host.appended[0].seq, endSeq: host.appended[0].seq })
  // Nothing left to say afterwards.
  await host.preStep()
  assert.equal(appendedTexts(host).length, 2)
})

test('an older anchor is dropped without a notice', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  for (let index = 0; index < 4; index += 1) {
    await host.fire('session/event', host.session, { seq: 100 + index, type: 'turn/start' })
  }
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  assert.deepEqual(appendedTexts(host), [])
})

test('a write result is tracked too, so its stale hash is announced', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file, 'write')
  await writeFile(file, 'a\nREWRITTEN\n')
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 1)
  assert.match(texts[0], new RegExp(file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
  assert.doesNotMatch(texts[0], /[0-9a-f]{6}/, 'no hash is disclosed')
})

test('an aborted step adds no notice', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep({ signal: { aborted: true } })
  assert.deepEqual(appendedTexts(host), [])
})

test('one line per file even when read and patched both touched it', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file, 'read')
  await anchorFrom(host, file, 'patch')
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  const lines = appendedTexts(host)[0].split('\n').filter(line => line.startsWith('- '))
  assert.equal(lines.length, 1, 'the file list is deduplicated')
})

test('two changed files are reported in one notice', async () => {
  const { file, host } = await fixture('a\nb\n')
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-rev2-'))
  const second = join(dir, 'second.txt')
  await writeFile(second, 'x\ny\n')
  await anchorFrom(host, file)
  await anchorFrom(host, second)
  await writeFile(file, 'a\nCHANGED\n')
  await writeFile(second, 'x\nCHANGED\n')
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 1)
  assert.match(texts[0], /2 files have changed/)
  assert.match(texts[0], /second\.txt/)
})
