/** Drift detection: the pre-step check that tells the model its hashes went stale. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** Stub host that records listeners so tests can fire them deterministically. */
function makeHost() {
  const tools = new Map()
  const listeners = new Map()
  const emitted = []
  const resolveCalls = []
  let reads = 0
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
   * Run one `agent/pre-step` waterfall the way the host does: `next()` takes no
   * arguments and returns the downstream decision, whose `messages` array is
   * where a listener appends its notice.
   */
  const preStep = async (step = {}) => {
    let result
    for (const handler of listeners.get('agent/pre-step') ?? []) {
      result = await handler(
        { agent: { id: 'agent-1' }, messages: [], signal: { aborted: false }, step: 1, ...step },
        () => ({ kind: 'accept', messages: [] }),
      )
    }
    return result ?? { kind: 'accept', messages: [] }
  }

  return { ctx, tools, emitted, fire, preStep, reads: () => reads, resolveCalls }
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

/** The texts a pre-step decision would add to the request. */
function noticesOf(decision) {
  return (decision.messages ?? []).map(message => message.content[0].text)
}

test('an untouched file produces no notice and is not re-read', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  const readsBefore = host.reads()
  const decision = await host.preStep()
  assert.deepEqual(noticesOf(decision), [])
  assert.equal(host.reads(), readsBefore, 'the stat prefilter must skip the file read')
})

test('a touch with identical content refreshes the observation without a notice', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  const later = new Date(Date.now() + 5000)
  await utimes(file, later, later)
  const decision = await host.preStep()
  assert.deepEqual(noticesOf(decision), [], 'same bytes are not a change')
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
  const decision = await host.preStep()
  const notices = noticesOf(decision)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /\[line-patch\] 1 file has changed since you last read or wrote it/)
  assert.match(notices[0], new RegExp(file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
  assert.match(notices[0], /Re-read a file before patching it/)
  // Handing over the new hash would let a model pair it with stale line numbers.
  assert.doesNotMatch(notices[0], /file_hash\s+[0-9a-f]{6}\s*->/, 'the notice must not print a hash transition')
  assert.doesNotMatch(notices[0], /[0-9a-f]{6}/, 'the notice must not print any hash at all')
})

test('the notice is not repeated until the content changes again', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  assert.equal(noticesOf(await host.preStep()).length, 1)
  assert.equal(noticesOf(await host.preStep()).length, 0, 'the same new content must not notify twice')
  await writeFile(file, 'a\nCHANGED AGAIN\n')
  assert.equal(noticesOf(await host.preStep()).length, 1, 'a second change notifies again')
})

test('an older anchor is dropped without a notice', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  for (let index = 0; index < 4; index += 1) {
    await host.fire('session/event', null, { type: 'turn/start' })
  }
  await writeFile(file, 'a\nCHANGED\n')
  assert.deepEqual(noticesOf(await host.preStep()), [])
})

test('a write result is tracked too, so its stale hash is announced', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file, 'write')
  await writeFile(file, 'a\nREWRITTEN\n')
  const notices = noticesOf(await host.preStep())
  assert.equal(notices.length, 1)
  assert.match(notices[0], new RegExp(file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
  assert.doesNotMatch(notices[0], /[0-9a-f]{6}/, 'no hash is disclosed')
})

test('an aborted step adds no notice', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  const decision = await host.preStep({ signal: { aborted: true } })
  assert.deepEqual(noticesOf(decision), [])
})

test('one line per file even when read and patched both touched it', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file, 'read')
  await anchorFrom(host, file, 'patch')
  await writeFile(file, 'a\nCHANGED\n')
  const notices = noticesOf(await host.preStep())
  assert.equal(notices.length, 1)
  const lines = notices[0].split('\n').filter(line => line.startsWith('- '))
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
  const notices = noticesOf(await host.preStep())
  assert.equal(notices.length, 1)
  assert.match(notices[0], /2 files have changed/)
  assert.match(notices[0], /second\.txt/)
})
