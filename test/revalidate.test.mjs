/** Drift detection: one live notice per session, replaced as the stale set changes. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/**
 * Stub host that records listeners and models the session surface.
 *
 * `session.append` enforces the host's replace rules (dsh-session): the cited
 * seq must still be visible, and the replacement must cite it. Sessions keep
 * their own surface, so a replacement can only shadow a seq of that session.
 */
function makeHost() {
  const tools = new Map()
  const listeners = new Map()
  const emitted = []
  const appended = []
  const sessions = new Map()
  let reads = 0
  let seq = 0

  const openSession = (id) => {
    const visible = new Set()
    const session = {
      id,
      append: (type, data, meta = {}) => {
        if (meta.surfaceOp !== undefined && typeof meta.surfaceOp === 'object') {
          const { startSeq, endSeq } = meta.surfaceOp
          if (!visible.has(startSeq) || !visible.has(endSeq)) {
            throw new Error(`surface replace: start seq ${startSeq} not found in surface`)
          }
          if (!Array.isArray(meta.sourceEventSeqs) || !meta.sourceEventSeqs.includes(startSeq)) {
            throw new Error('surface replace must cite the replaced seq')
          }
          visible.delete(startSeq)
        }
        seq += 1
        const event = { seq, type, data, sessionId: id, ...meta }
        appended.push(event)
        visible.add(seq)
        // The host commits and emits synchronously; the plugin tracks its own
        // notice from this stream, so the stub must do the same.
        queueMicrotask(() => { listeners.get('session/event')?.forEach(handler => handler(session, event)) })
        return event
      },
      /** Test helper: model a compaction that shadows an existing message. */
      shadow: (target) => { visible.delete(target) },
    }
    sessions.set(id, session)
    return session
  }

  openSession('s1')
  const sessionOf = (id) => sessions.get(id) ?? openSession(id)
  const agentOf = (id = 's1') => ({ id: `agent-${id}`, session: sessionOf(id) })

  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition) } },
    on: (name, handler) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
    },
    emit: (...args) => { emitted.push(args) },
    waterfall: async (_name, _target, _actor, next) => next(),
    fs: {
      async resolve(p, options = {}) { return { targetKey: p, displayPath: p.split(/[\\/]/).pop() } },
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
   * returns a decision whose `messages` the host then appends to that session.
   */
  const preStep = async (sessionId = 's1', override = {}, downstream) => {
    const session = sessionOf(sessionId)
    const payload = { agent: agentOf(sessionId), messages: [], signal: { aborted: false }, step: 1, ...override }
    const next = downstream ?? (() => ({ kind: 'accept', messages: [] }))
    let decision
    for (const handler of listeners.get('agent/pre-step') ?? []) {
      decision = await handler(payload, next)
    }
    decision ??= { kind: 'accept', messages: [] }
    for (const message of decision.messages ?? []) {
      session.append('user/message', message, { surfaceOp: 'append' })
    }
    // Let the queued session/event callbacks settle before assertions run.
    await new Promise(resolve => setTimeout(resolve, 0))
    return decision
  }

  return { ctx, tools, emitted, appended, sessions, fire, preStep, reads: () => reads }
}

/** Create a temp file bound to a stub host. */
async function fixture(content) {
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-rev-'))
  const file = join(dir, 'sample.txt')
  await writeFile(file, content)
  return { file, host: makeHost() }
}

/** Annotate one tool result, which is what registers an anchor. */
async function anchorFrom(host, file, toolName = 'read', sessionId = 's1', callId = 'call-1') {
  return host.fire('tools/post-execute',
    { name: toolName, arguments: { file_path: file }, callId, agent: host.sessions.get(sessionId) ? { id: `agent-${sessionId}`, session: host.sessions.get(sessionId) } : undefined },
    { content: [{ type: 'text', text: '1: a' }], isError: false },
    () => ({ kind: 'accept' }))
}

/** The texts the sessions actually appended. */
function appendedTexts(host, sessionId) {
  return host.appended
    .filter(event => sessionId === undefined || event.sessionId === sessionId)
    .map(event => event.data.content[0].text)
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
  await anchorFrom(host, file, 'read', 's1', 'call-2')
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 2)
  assert.match(texts[1], /No files changed since your last read; earlier line-patch notices no longer apply/)
  assert.deepEqual(host.appended[1].surfaceOp, { op: 'replace', startSeq: host.appended[0].seq, endSeq: host.appended[0].seq })
  await host.preStep()
  assert.equal(appendedTexts(host).length, 2)
})

test('an aged-out anchor never claims the file is fine again', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  for (let index = 0; index < 4; index += 1) {
    await host.fire('session/event', host.sessions.get('s1'), { seq: 200 + index, type: 'turn/start' })
  }
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 1, 'the warning stays; expiry is not evidence of a re-read')
  assert.doesNotMatch(texts[0], /No files changed/)
})

test('a shadowed live notice falls back to a fresh append', async () => {
  const { file, host } = await fixture('a\nb\n')
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-rev5-'))
  const second = join(dir, 'second.txt')
  await writeFile(second, 'x\ny\n')
  await anchorFrom(host, file)
  await anchorFrom(host, second)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  const notice = host.appended[0]
  // Model a compaction that shadows the notice's span, then a drift that would
  // have to rewrite it.
  host.sessions.get('s1').shadow(notice.seq)
  await writeFile(second, 'x\nCHANGED\n')
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 2, 'the plugin must not go silent after a failed replace')
  assert.equal(host.appended[1].surfaceOp, 'append')
  assert.match(texts[1], /2 files have changed/)
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
  await host.preStep('s1', { signal: { aborted: true } })
  assert.deepEqual(appendedTexts(host), [])
})

test('one line per file even when two results tracked it', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file, 'read')
  await anchorFrom(host, file, 'write')
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

test('an anchor is still live at the third turn and gone at the fourth', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  const turn = (n) => host.fire('session/event', host.sessions.get('s1'), { seq: 300 + n, type: 'turn/start' })
  await turn(1)
  await turn(2)
  await turn(3)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  assert.equal(appendedTexts(host).length, 1, 'three turns is still inside the window')
  await turn(4)
  await host.preStep()
  assert.equal(appendedTexts(host).length, 1, 'an aged-out anchor adds nothing')
})

test('a downstream reject adds no notice', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep('s1', {}, () => ({ kind: 'reject', reason: 'archived' }))
  assert.deepEqual(appendedTexts(host), [])
})

test('the notice keeps the messages the downstream decision added', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  const pending = { role: 'user', content: [{ type: 'text', text: 'claimed message' }], source: { kind: 'user' } }
  const decision = await host.preStep('s1', {}, () => ({ kind: 'enter', messages: [pending] }))
  assert.equal(decision.messages.length, 2, 'the claimed message survives and the notice is appended after it')
  assert.equal(decision.messages[0], pending)
  assert.match(decision.messages[1].content[0].text, /line-patch/)
})

test('a patch result registers an anchor too', async () => {
  const content = 'alpha\nbeta\n'
  const { file, host } = await fixture(content)
  const annotated = await anchorFrom(host, file)
  const hash = /(?:^|\n)file_hash: ([0-9a-f]+)$/.exec(annotated.content.at(-1).text)[1]
  const tools = host.tools.get('patch')
  await tools.execute({
    file_path: file,
    file_hash: hash,
    line_start: 2,
    start_anchor: 'beta',
    line_end: 2,
    end_anchor: 'beta',
    replace: 'BETA',
  }, { agent: { id: 'agent-s1', session: host.sessions.get('s1') }, signal: undefined })
  // The patch registers a fresh anchor at the rewritten content.
  await writeFile(file, 'alpha\nBETA\nCHANGED\n')
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 1)
  assert.match(texts[0], /1 file has changed/)
})

test('files that share a basename stay separate anchors', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'line-patch-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'line-patch-b-'))
  const fileA = join(dirA, 'same.txt')
  const fileB = join(dirB, 'same.txt')
  await writeFile(fileA, 'a\nb\n')
  await writeFile(fileB, 'x\ny\n')
  const { host } = await fixture('unused\n')
  await anchorFrom(host, fileA)
  await anchorFrom(host, fileB)
  await writeFile(fileA, 'a\nCHANGED\n')
  await host.preStep()
  const lines = appendedTexts(host)[0].split('\n').filter(line => line.startsWith('- '))
  assert.equal(lines.length, 1, 'only the changed file is reported, even though both are named same.txt')
})

test('sessions never see each other\'s anchors or notices', async () => {
  const { file, host } = await fixture('a\nb\n')
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-rev4-'))
  const other = join(dir, 'other.txt')
  await writeFile(other, 'x\ny\n')
  await anchorFrom(host, file, 'read', 's1')
  await anchorFrom(host, other, 'read', 's2')
  await writeFile(file, 'a\nCHANGED\n')
  // s2 changed nothing; its step must stay quiet.
  await host.preStep('s2')
  assert.deepEqual(appendedTexts(host, 's2'), [])
  // s1 sees only its own file.
  await host.preStep('s1')
  const texts = appendedTexts(host, 's1')
  assert.equal(texts.length, 1)
  assert.match(texts[0], /1 file has changed/)
  assert.match(texts[0], /sample\.txt/)
  assert.doesNotMatch(texts[0], /other\.txt/)
})
