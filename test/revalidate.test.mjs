/** Anchor revalidation: the per-request file check that keeps read results honest. */
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
  const appended = []
  let reads = 0
  const session = {
    append: (...args) => { appended.push(args); return { seq: 999 } },
    eventAt: (seq) => ({ seq, data: { turn: 1, step: 1, message: { id: 'm', role: 'tool', content: [] } } }),
    surface: { nodes: new Set() },
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
      async resolve(p) { return { targetKey: p, displayPath: p } },
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
  return { ctx, tools, emitted, appended, session, fire, reads: () => reads }
}

/** Create a temp file bound to a stub host. */
async function fixture(content) {
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-rev-'))
  const file = join(dir, 'sample.txt')
  await writeFile(file, content)
  return { file, host: makeHost() }
}

/** Annotate one `read` result, which is what registers an anchor. */
async function readAnchor(host, file, callId = 'call-1', downstream = () => ({ kind: 'accept' })) {
  const decision = await host.fire('tools/post-execute',
    { name: 'read', arguments: { file_path: file }, callId },
    { content: [{ type: 'text', text: '1: a' }], isError: false },
    // Cordis waterfall: `next()` takes no arguments and returns the downstream decision.
    downstream)
  // The host reports our own result sequence through session/event.
  await host.fire('session/event', host.session, {
    type: 'tool/result',
    seq: 42,
    data: { message: { toolCallId: callId } },
  })
  return decision
}

test('a blocked read is not tracked and is never rewritten', async () => {
  const { file, host } = await fixture('a\nb\n')
  await readAnchor(host, file, 'call-1', () => ({ kind: 'block', feedback: [{ type: 'text', text: 'denied by policy' }] }))
  await writeFile(file, 'a\nCHANGED\n')
  await host.fire('agent/request', { turn: 1, step: 1, agent: {} }, () => 'next')
  assert.equal(host.appended.length, 0, 'a policy block must not be replaced by a stale-read notice')
})

test('an untouched file is not re-read and nothing is rewritten', async () => {
  const { file, host } = await fixture('a\nb\n')
  await readAnchor(host, file)
  const appendsBefore = host.appended.length
  const readsBefore = host.reads()
  await host.fire('agent/request', { turn: 1, step: 1, agent: {} }, () => 'next')
  assert.equal(host.appended.length, appendsBefore)
  assert.equal(host.reads(), readsBefore, 'the stat prefilter must skip the file read')
})

test('a stat change with identical content refreshes the observation exactly once', async () => {
  const { file, host } = await fixture('a\nb\n')
  await readAnchor(host, file)
  const later = new Date(Date.now() + 5000)
  await utimes(file, later, later)
  const appendsBefore = host.appended.length
  await host.fire('agent/request', { turn: 1, step: 1, agent: {} }, () => 'next')
  assert.equal(host.appended.length, appendsBefore, 'no surface rewrite for unchanged content')
  const observed = host.emitted.filter(([eventName]) => eventName === 'fs/observed')
  assert.ok(observed.length >= 1, 'the refresh emits an observation')
  // The stored version must have moved, or the next turn would re-read and re-emit.
  const readsAfterRefresh = host.reads()
  await host.fire('agent/request', { turn: 1, step: 1, agent: {} }, () => 'next')
  assert.equal(host.reads(), readsAfterRefresh, 'the refreshed version must be remembered')
})

test('a real content change rewrites the stale read result', async () => {
  const { file, host } = await fixture('a\nb\n')
  await readAnchor(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.fire('agent/request', { turn: 1, step: 1, agent: {} }, () => 'next')
  assert.equal(host.appended.length, 1, 'the stale result is replaced exactly once')
  const [type, data, meta] = host.appended[0]
  assert.equal(type, 'tool/result')
  assert.deepEqual(meta.surfaceOp, { op: 'replace', startSeq: 42, endSeq: 42 })
  assert.deepEqual(meta.sourceEventSeqs, [42])
  const text = data.message.content[0].text
  assert.match(text, /was modified after it was read/)
  assert.match(text, /read it again/)
})

test('a tool-mediated write clears the anchor so no stale notice follows', async () => {
  const { file, host } = await fixture('a\nb\n')
  await readAnchor(host, file)
  await writeFile(file, 'a\nB\n')
  // The built-in write reports the new version on the observation channel.
  const stats = await stat(file)
  await host.fire('fs/observed', { targetKey: file, displayPath: file },
    { kind: 'present', version: `${stats.size}:${stats.mtimeMs}` })
  const appendsBefore = host.appended.length
  await host.fire('agent/request', { turn: 1, step: 1, agent: {} }, () => 'next')
  assert.equal(host.appended.length, appendsBefore, 'the write already carries the new hash')
})

test('a stale read result is replaced once, not on every turn', async () => {
  const { file, host } = await fixture('a\nb\n')
  await readAnchor(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.fire('agent/request', { turn: 1, step: 1, agent: {} }, () => 'next')
  assert.equal(host.appended.length, 1)
  await host.fire('agent/request', { turn: 1, step: 1, agent: {} }, () => 'next')
  assert.equal(host.appended.length, 1, 'the replaced anchor must be dropped')
})

test('an anchor older than the turn window is dropped without any I/O', async () => {
  const { file, host } = await fixture('a\nb\n')
  await readAnchor(host, file)
  for (let index = 0; index < 4; index += 1) {
    await host.fire('session/event', host.session, { type: 'turn/start', seq: 100 + index })
  }
  await writeFile(file, 'a\nCHANGED\n')
  const appendsBefore = host.appended.length
  await host.fire('agent/request', { turn: 5, step: 1, agent: {} }, () => 'next')
  assert.equal(host.appended.length, appendsBefore, 'expired anchors are not revalidated')
})

test('patch refreshes the anchor so its own write is not reported as external', async () => {
  const { file, host } = await fixture('a\nb\n')
  const decision = await readAnchor(host, file)
  const hash = /(?:^|\n)file_hash: ([0-9a-f]+)$/.exec(decision.content.at(-1).text)?.[1]
  await host.tools.get('patch').execute({
    file_path: file,
    file_hash: hash,
    line_start: 2,
    start_anchor: 'b',
    line_end: 2,
    end_anchor: 'b',
    replace: 'B',
  }, { callId: 'call-2', signal: undefined })
  const appendsBefore = host.appended.length
  await host.fire('agent/request', { turn: 1, step: 1, agent: {} }, () => 'next')
  assert.equal(host.appended.length, appendsBefore, 'our own edit must not trigger a stale notice')
})
