/** Anchor revalidation: the per-request file check that keeps read results honest. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** Stub host that records listeners so tests can fire them deterministically. */
function makeHost() {
  const tools = new Map()
  const listeners = new Map()
  const emitted = []
  const appended = []
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
      async readText(target) { return readFile(target.targetKey, 'utf8') },
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
  return { ctx, tools, emitted, appended, session, fire }
}

/** Create a temp file bound to a stub host. */
async function fixture(content) {
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-rev-'))
  const file = join(dir, 'sample.txt')
  await writeFile(file, content)
  return { file, host: makeHost() }
}

/** Read a file through the plugin so an anchor is registered. */
async function readAnchor(host, file, callId = 'call-1') {
  const out = await host.tools.get('read_hash').execute({ file_path: file }, { callId, signal: undefined })
  // The host reports our own result sequence through session/event.
  await host.fire('session/event', host.session, {
    type: 'tool/result',
    seq: 42,
    data: { message: { toolCallId: callId } },
  })
  return out
}

test('an untouched file is not re-read and nothing is rewritten', async () => {
  const { file, host } = await fixture('a\nb\n')
  await readAnchor(host, file)
  const appendsBefore = host.appended.length
  await host.fire('agent/request', { turn: 1, step: 1, agent: {} }, () => 'next')
  assert.equal(host.appended.length, appendsBefore)
})

test('a stat change with identical content refreshes the observation and keeps the anchors', async () => {
  const { file, host } = await fixture('a\nb\n')
  await readAnchor(host, file)
  // Same bytes, newer mtime: exactly the rebuild/touch case the stat guard mishandles.
  const later = new Date(Date.now() + 5000)
  await utimes(file, later, later)
  const appendsBefore = host.appended.length
  await host.fire('agent/request', { turn: 1, step: 1, agent: {} }, () => 'next')
  assert.equal(host.appended.length, appendsBefore, 'no surface rewrite for unchanged content')
  const observed = host.emitted.filter(([eventName]) => eventName === 'fs/observed')
  assert.ok(observed.length >= 2, 'the refresh emits a second observation')
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
  assert.match(text, /read_hash again/)
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

test('patch_hash refreshes the anchor so its own write is not reported as external', async () => {
  const { file, host } = await fixture('a\nb\n')
  const read = await readAnchor(host, file)
  await host.tools.get('patch_hash').execute({
    file_path: file,
    file_hash: read.file_hash,
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
