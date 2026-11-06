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
    const events = new Map()
    // The host exposes surface.nodes as a readonly array, not a Set: the stub
    // keeps an index for membership but hands the production code the real
    // shape, so a Set-only implementation cannot pass here.
    const nodes = []
    let rejectReplace = false
    const session = {
      id,
      surface: { get nodes() { return [...nodes] } },
      eventAt: (target) => events.get(target),
      append: (type, data, meta = {}) => {
        if (meta.surfaceOp !== undefined && typeof meta.surfaceOp === 'object') {
          if (rejectReplace) throw new Error('session rejected the replacement')
          const { startSeq, endSeq } = meta.surfaceOp
          if (!visible.has(startSeq) || !visible.has(endSeq)) {
            throw new Error(`surface replace: start seq ${startSeq} not found in surface`)
          }
          if (!Array.isArray(meta.sourceEventSeqs) || !meta.sourceEventSeqs.includes(startSeq)) {
            throw new Error('surface replace must cite the replaced seq')
          }
          visible.delete(startSeq)
          const index = nodes.indexOf(startSeq)
          if (index !== -1) nodes.splice(index, 1)
        }
        seq += 1
        const event = { seq, type, data, sessionId: id, ...meta }
        events.set(seq, event)
        appended.push(event)
        visible.add(seq)
        nodes.push(seq)
        // The host commits and emits synchronously; the plugin tracks its own
        // notice from this stream, so the stub must do the same.
        queueMicrotask(() => { listeners.get('session/event')?.forEach(handler => handler(session, event)) })
        return event
      },
      /** Test helper: make every surface replacement fail. */
      failReplaces: (value = true) => { rejectReplace = value },
      /** Test helper: model a compaction that shadows an existing message. */
      shadow: (target) => {
        visible.delete(target)
        const index = nodes.indexOf(target)
        if (index !== -1) nodes.splice(index, 1)
      },
      /** Test helper: put an older line-patch notice on the surface (reload/resume). */
      seedNotice: (text) => {
        seq += 1
        const event = { seq, type: 'user/message', sessionId: id, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'line-patch', form: 'notice' } }, surfaceOp: 'append' }
        events.set(seq, event)
        visible.add(seq)
        nodes.push(seq)
        return event
      },
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
    // The host dispatches emitted events to the listeners registered for them;
    // the plugin's own `fs/observed` bookkeeping depends on that.
    emit: (...args) => {
      emitted.push(args)
      for (const handler of listeners.get(args[0]) ?? []) handler(...args.slice(1))
    },
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

  return { ctx, tools, emitted, appended, sessions, fire, preStep, reads: () => reads, listeners }
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

test('a reload adopts the notice a previous instance left behind', async () => {
  const { file, host } = await fixture('a\nb\n')
  const seeded = host.sessions.get('s1').seedNotice('[line-patch] 1 file has changed since you last read or wrote it:\n- old.txt\nvoid.')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  // The old notice is rewritten in place, not duplicated.
  assert.equal(appendedTexts(host).length, 1)
  const replacement = host.appended[0]
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: seeded.seq, endSeq: seeded.seq })
  assert.match(replacement.data.content[0].text, /sample\.txt/)
})

test('adoption ignores a user message that is not a notice', async () => {
  const { file, host } = await fixture('a\nb\n')
  const session = host.sessions.get('s1')
  // A plain user message from the model side must never be adopted (and then
  // rewritten) as if it were our notice.
  const userMessage = { role: 'user', content: [{ type: 'text', text: 'do not touch me' }], source: { kind: 'user' } }
  session.append('user/message', userMessage, { surfaceOp: 'append' })
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  const notices = host.appended.filter(event => event.data?.source?.kind === 'line-patch')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].surfaceOp, 'append', 'the user message must not be replaced')
  assert.ok(host.sessions.get('s1').surface.nodes.includes(1), 'the user message is still on the surface')
})

test('a host without session events does not repeat the notice every step', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  host.listeners.delete('session/event')
  await host.preStep()
  await host.preStep()
  await host.preStep()
  assert.equal(appendedTexts(host).length, 1)
})

test('re-reading a file keeps its anchor alive past the eviction window', async () => {
  const { file, host } = await fixture('a\nb\n')
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-evict-'))
  await anchorFrom(host, file)
  // Fill the anchor window with other files, re-read the target, then evict one.
  for (let index = 0; index < 30; index += 1) {
    const other = join(dir, `f${index}.txt`)
    await writeFile(other, `${index}\n`)
    await anchorFrom(host, other)
  }
  await anchorFrom(host, file, 'read', 's1', 'call-reread')
  const extra = join(dir, 'f31.txt')
  await writeFile(extra, 'x\n')
  await anchorFrom(host, extra)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  assert.equal(appendedTexts(host).length, 1, 'the re-read anchor must not be evicted by its own stale queue entry')
  assert.match(appendedTexts(host)[0], /sample\.txt/)
})

test('a shadowed notice is re-announced even when the notice text would be identical', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  const notice = host.appended[0]
  host.sessions.get('s1').shadow(notice.seq)
  // Same stale set, so the notice text would be byte-identical — but the
  // message the model can see is gone, so silence here is a false all-clear.
  await writeFile(file, 'a\nCHANGED\nAGAIN\n')
  await host.preStep()
  assert.equal(appendedTexts(host).length, 2)
  assert.equal(host.appended[1].surfaceOp, 'append')
})

test('an aged-out anchor never clears the warning, even on later steps', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  for (let index = 0; index < 4; index += 1) {
    await host.fire('session/event', host.sessions.get('s1'), { seq: 200 + index, type: 'turn/start' })
  }
  await host.preStep()
  await host.preStep()
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 1, 'the warning must survive every later step, not just one')
  assert.doesNotMatch(texts[0], /No files changed/)
})

test('an adopted notice is not cleared while it has no evidence', async () => {
  const { host } = await fixture('a\nb\n')
  host.sessions.get('s1').seedNotice('[line-patch] 1 file has changed since you last read or wrote it:\n- old.txt\nvoid.')
  await host.preStep()
  await host.preStep()
  assert.deepEqual(appendedTexts(host), [], 'a fork seed is not evidence the file was re-read')
})

test('evicting an anchor does not clear the warning', async () => {
  const { file, host } = await fixture('a\nb\n')
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-evict2-'))
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  for (let index = 0; index < 40; index += 1) {
    const other = join(dir, `e${index}.txt`)
    await writeFile(other, `${index}\n`)
    await anchorFrom(host, other)
  }
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 1, 'losing the anchor is not the same as the file being re-read')
  assert.doesNotMatch(texts[0], /No files changed/)
})

test('a write in another session leaves the warning intact', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file, 'read', 's1')
  await writeFile(file, 'a\nEXTERNAL\n')
  await host.preStep('s1')
  assert.equal(appendedTexts(host, 's1').length, 1)
  // Session s2 writes the same file: s1 must still be able to report the
  // change, so its anchor must not be dropped by another session's write.
  const post = host.listeners.get('tools/post-execute')[0]
  await post(
    { name: 'write', arguments: { file_path: file }, callId: 'w1', agent: { id: 'agent-s2', session: host.sessions.get('s2') } },
    { content: [{ type: 'text', text: 'written' }], isError: false },
    () => ({ kind: 'accept' }),
  )
  await host.preStep('s1')
  assert.equal(appendedTexts(host, 's1').length, 1, 'no false all-clear for the other session')
})

test('an expired anchor does not silence another file that is still stale', async () => {
  const { file, host } = await fixture('a\nb\n')
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-mixed-'))
  const second = join(dir, 'second.txt')
  await writeFile(second, 'x\ny\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  // The first anchor ages out while a freshly read second file is changed.
  for (let index = 0; index < 4; index += 1) {
    await host.fire('session/event', host.sessions.get('s1'), { seq: 400 + index, type: 'turn/start' })
  }
  await anchorFrom(host, second)
  await writeFile(second, 'x\nCHANGED\n')
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 2)
  assert.match(texts[1], /1 file has changed/)
  assert.doesNotMatch(texts[1], /No files changed/)
})

test('a deleted file never triggers the all-clear', async () => {
  const { file, host } = await fixture('a\nb\n')
  await anchorFrom(host, file)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  const { rm } = await import('node:fs/promises')
  await rm(file)
  await host.preStep()
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 1, 'a vanished file is not a re-read')
  assert.doesNotMatch(texts[0], /No files changed/)
})

test('a same-named file in another directory is not evidence of a re-read', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'line-patch-ev-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'line-patch-ev-b-'))
  const fileA = join(dirA, 'same.txt')
  const fileB = join(dirB, 'same.txt')
  await writeFile(fileA, 'a\nb\n')
  await writeFile(fileB, 'x\ny\n')
  const { host } = await fixture('unused\n')
  await anchorFrom(host, fileA)
  await writeFile(fileA, 'a\nCHANGED\n')
  await host.preStep()
  // The first anchor ages out; the model then reads the *other* same-named
  // file. That is not evidence that the first one was re-read.
  for (let index = 0; index < 4; index += 1) {
    await host.fire('session/event', host.sessions.get('s1'), { seq: 500 + index, type: 'turn/start' })
  }
  await anchorFrom(host, fileB)
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 1, 'the warning must not be closed out by a different file')
  assert.doesNotMatch(texts[0], /No files changed/)
})

test('a stale queue entry cannot evict the anchor that replaced it', async () => {
  const { file, host } = await fixture('a\nb\n')
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-ev2-'))
  await anchorFrom(host, file)
  // Age the anchor out; it leaves `anchors` but keeps its queue entry.
  for (let index = 0; index < 4; index += 1) {
    await host.fire('session/event', host.sessions.get('s1'), { seq: 600 + index, type: 'turn/start' })
  }
  // Push the stale entry away from the head, then re-read the file so a fresh
  // anchor sits behind it.
  for (let index = 0; index < 20; index += 1) {
    const other = join(dir, `o${index}.txt`)
    await writeFile(other, `${index}\n`)
    await anchorFrom(host, other)
  }
  await anchorFrom(host, file, 'read', 's1', 'call-fresh')
  for (let index = 0; index < 14; index += 1) {
    const other = join(dir, `g${index}.txt`)
    await writeFile(other, `${index}\n`)
    await anchorFrom(host, other)
  }
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  assert.equal(appendedTexts(host).length, 1, 'the live anchor must survive its own stale queue entry')
  assert.match(appendedTexts(host)[0], /sample\.txt/)
})

test('a rejected replacement falls back to a fresh append', async () => {
  const { file, host } = await fixture('a\nb\n')
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-rej-'))
  const second = join(dir, 'second.txt')
  await writeFile(second, 'x\ny\n')
  await anchorFrom(host, file)
  await anchorFrom(host, second)
  await writeFile(file, 'a\nCHANGED\n')
  await host.preStep()
  // The host refuses the in-place rewrite for a reason other than shadowing
  // (the node is still on the surface, so noticeStillLive passes).
  host.sessions.get('s1').failReplaces()
  await writeFile(second, 'x\nCHANGED\n')
  await host.preStep()
  const texts = appendedTexts(host)
  assert.equal(texts.length, 2, 'the plugin must not go silent when the rewrite is refused')
  assert.equal(host.appended[1].surfaceOp, 'append')
  assert.match(texts[1], /2 files have changed/)
})

test('another session writing the file does not silence this session', async () => {
  const { file, host } = await fixture('a\nb\n')
  const annotated = await anchorFrom(host, file)
  const hash = /(?:^|\n)file_hash: ([0-9a-f]+)$/.exec(annotated.content.at(-1).text)[1]
  const tools = host.tools.get('patch')
  // Session s2 rewrites the file through the tool: its own result re-registers
  // an anchor, and its fs/observed must not delete s1's.
  await writeFile(file, 'a\nBETA\n')
  await tools.execute({
    file_path: file,
    file_hash: (await import('../lib/core.js')).fileHash('a\nBETA\n'),
    line_start: 2,
    start_anchor: 'BETA',
    line_end: 2,
    end_anchor: 'BETA',
    replace: 'GAMMA',
  }, { agent: { id: 'agent-s2', session: host.sessions.get('s2') }, signal: undefined }).catch(() => {})
  await host.preStep('s1')
  const texts = appendedTexts(host, 's1')
  assert.equal(texts.length, 1, 'the other session\'s write must not drop this session\'s warning')
  assert.match(texts[0], /sample\.txt/)
  assert.ok(hash)
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
