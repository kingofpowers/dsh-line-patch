/** Glue tests: the hash annotation and the `patch` tool against a stub host. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'
import { ANCHOR_CHARS, endAnchorOf, fileHash, startAnchorOf } from '../lib/core.js'

/** Build a stub plugin context exposing the host surface the plugin touches. */
function makeCtx() {
  const tools = new Map()
  const listeners = new Map()
  const emitted = []
  const intents = []
  const resolveCalls = []
  let workingDirectory
  const ctx = {
    get: (name) => (name === 'workingDirectory' ? workingDirectory : undefined),
    tools: { register: (definition) => { tools.set(definition.name, definition) } },
    on: (eventName, handler) => {
      if (!listeners.has(eventName)) listeners.set(eventName, [])
      listeners.get(eventName).push(handler)
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
        if (!stats) return undefined // the provider contract: absent targets return undefined
        if (!stats.isFile()) return { type: 'directory', size: 0, version: 'dir' }
        return {
          type: 'file',
          size: stats.size,
          version: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`,
        }
      },
      async readText(target) { return readFile(target.targetKey, 'utf8') },
      async writeText(target, content, intent) {
        intents.push(intent)
        const stats = await import('node:fs/promises').then(m => m.stat(target.targetKey))
        const current = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`
        if (intent?.kind === 'replaceIfVersion' && intent.version !== current) {
          const error = new Error(`cannot write: file changed since it was read`)
          error.code = 'FS_STALE_VERSION'
          throw error
        }
        await writeFile(target.targetKey, content)
        const after = await import('node:fs/promises').then(m => m.stat(target.targetKey))
        return { operation: 'update', version: `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}` }
      },
      processPath(target) { return target.targetKey },
    },
  }
  return {
    ctx,
    tools,
    listeners,
    emitted,
    intents,
    resolveCalls,
    setWorkingDirectory: (service) => { workingDirectory = service },
  }
}

/**
 * Deliver one host waterfall event exactly as cordis does.
 *
 * `next()` takes NO arguments and returns the downstream decision; the
 * outermost listener's return value becomes the result the host applies. A
 * listener that never calls `next()` vetoes every listener beneath it.
 */
async function fire(host, eventName, ...args) {
  const handlers = [...(host.listeners.get(eventName) ?? [])]
  const inner = () => ({ kind: 'accept' })
  let nextCalls = 0
  const run = async (index) => {
    if (index >= handlers.length) return inner()
    const next = () => {
      nextCalls += 1
      return run(index + 1)
    }
    return handlers[index](...args, next)
  }
  const result = await run(0)
  host.lastNextCalls = nextCalls
  return result
}

/** Create a temp file and return its path plus a stub host bound to it. */
async function fixture(content) {
  const dir = await mkdtemp(join(tmpdir(), 'line-patch-'))
  const file = join(dir, 'sample.txt')
  await writeFile(file, content)
  const host = makeCtx()
  apply(host.ctx)
  return { file, ...host }
}

/** Drive the registered patch tool with canonical arguments. */
async function patch(tools, args) {
  return tools.get('patch').execute(args, { signal: undefined })
}

/** Ask the post-execute hook to annotate a result, as the host would. */
async function annotate(host, toolName, file, content, extra = {}) {
  const exec = { name: toolName, arguments: { file_path: file }, callId: 'call-1', ...extra }
  const result = { content: [{ type: 'text', text: content }], isError: false }
  const decision = await fire(host, 'tools/post-execute', exec, result)
  return decision
}

/** The `file_hash: …` value out of an annotated decision, or undefined. */
function hashOf(decision) {
  const last = decision.content?.at(-1)
  const match = typeof last?.text === 'string' ? last.text.match(/(?:^|\n)file_hash: ([0-9a-f]+)$/) : null
  return match?.[1]
}

test('the plugin exports the expected shape', () => {
  assert.equal(name, 'line-patch')
  assert.deepEqual(inject, ['tools', 'fs', 'workingDirectory'])
})

test('only the patch tool is registered — there is no read_hash', async () => {
  const { tools } = await fixture('a\n')
  assert.deepEqual([...tools.keys()], ['patch'])
})

test('the patch schema marks the anchor fields required and has no total_lines', async () => {
  const { tools } = await fixture('a\n')
  const spec = tools.get('patch').parameters
  for (const key of ['file_path', 'file_hash', 'line_start', 'start_anchor', 'line_end', 'end_anchor', 'replace']) {
    assert.equal(spec[key]?.required, true, `${key} must be required`)
  }
  assert.equal(spec.total_lines, undefined)
})

test('the hook always continues the waterfall instead of vetoing it', async () => {
  const { file, ...host } = await fixture('alpha\n')
  await annotate(host, 'read', file, '1: alpha')
  assert.equal(host.lastNextCalls, 1, 'the annotation listener must call next()')
  await annotate(host, 'grep', file, 'x')
  assert.equal(host.lastNextCalls, 1, 'an unrelated tool must still continue the chain')
})

test('a downstream listener keeps running and its content is what gets annotated', async () => {
  const { file, ...host } = await fixture('alpha\n')
  host.listeners.get('tools/post-execute').push((exec, result, next) =>
    next().then(downstream => ({ ...downstream, content: [{ type: 'text', text: 'edited downstream' }] })))
  const decision = await annotate(host, 'read', file, '1: alpha')
  assert.deepEqual(decision.content.map(block => block.text), [`edited downstream\nfile_hash: ${fileHash('alpha\n')}`])
})

test('a downstream block wins and is not annotated', async () => {
  const { file, ...host } = await fixture('alpha\n')
  host.listeners.get('tools/post-execute').push(() => ({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }))
  const decision = await annotate(host, 'read', file, '1: alpha')
  assert.equal(decision.kind, 'block')
  assert.equal(decision.content, undefined)
})

test('a downstream value replacement is left alone', async () => {
  const { file, ...host } = await fixture('alpha\n')
  host.listeners.get('tools/post-execute').push(() => ({ kind: 'accept', value: { replaced: true } }))
  const decision = await annotate(host, 'read', file, '1: alpha')
  assert.deepEqual(decision.value, { replaced: true })
  assert.equal(decision.content, undefined)
})

test('a read result gains the current file hash in its existing block', async () => {
  const { file, ...host } = await fixture('alpha\nbeta\n')
  const decision = await annotate(host, 'read', file, '1: alpha\n2: beta\n')
  assert.equal(hashOf(decision), fileHash('alpha\nbeta\n'))
  assert.equal(decision.content.length, 1, 'the line joins the existing block; plugins that need one block still work')
  assert.equal(decision.content[0].text, `1: alpha\n2: beta\nfile_hash: ${fileHash('alpha\nbeta\n')}`)
})

test('a relative path resolves against the session working directory', async () => {
  const { file, ...host } = await fixture('alpha\n')
  const ensureCalls = []
  const signal = new AbortController().signal
  host.setWorkingDirectory({
    ensure: async (agent, given) => { ensureCalls.push({ agent, signal: given }); return '/session/dir' },
  })
  await annotate(host, 'read', file, '1: alpha', { agent: { id: 'agent-1' }, signal })
  const call = host.resolveCalls.at(-1)
  assert.equal(call.options.cwd, '/session/dir', 'the hash must describe the file the tool resolved')
  assert.equal(call.options.signal, signal, 'cancellation must reach the provider')
  assert.deepEqual(ensureCalls, [{ agent: { id: 'agent-1' }, signal }], 'the agent must be forwarded')
})

test('a file that moved between the tool and the hook is not annotated', async () => {
  const { file, ...host } = await fixture('alpha\n')
  await fire(host, 'fs/observed', { targetKey: file }, { kind: 'present', version: 'the-version-the-tool-saw' })
  const decision = await annotate(host, 'read', file, '1: alpha')
  assert.equal(decision.content, undefined, 'a hash for unseen bytes must not be handed out')
})

test('a matching observation still annotates, as it does in the real host', async () => {
  const { file, ...host } = await fixture('alpha\n')
  const stats = await stat(file)
  const version = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`
  await fire(host, 'fs/observed', { targetKey: file }, { kind: 'present', version })
  const decision = await annotate(host, 'read', file, '1: alpha')
  assert.equal(hashOf(decision), fileHash('alpha\n'), 'the normal path must not be suppressed')
})

test('a patch emits an observation for the file it wrote', async () => {
  const content = 'alpha\nbeta\n'
  const { file, ...host } = await fixture(content)
  const hash = hashOf(await annotate(host, 'read', file, content))
  await patch(host.tools, {
    file_path: file,
    file_hash: hash,
    line_start: 2,
    start_anchor: 'beta',
    line_end: 2,
    end_anchor: 'beta',
    replace: 'BETA',
  })
  const observed = host.emitted.filter(([eventName]) => eventName === 'fs/observed')
  assert.ok(observed.length >= 1, 'the policy gate must see the write')
})

test('write and edit results gain the hash of the file as it now is', async () => {
  const { file, ...host } = await fixture('changed\n')
  for (const toolName of ['write', 'edit']) {
    const decision = await annotate(host, toolName, file, 'ok')
    assert.equal(hashOf(decision), fileHash('changed\n'), `${toolName} must carry the new hash`)
  }
})

test('results without text, failed results and unrelated tools are left alone', async () => {
  const { file, ...host } = await fixture('a\n')
  const binary = await fire(host, 'tools/post-execute',
    { name: 'read', arguments: { file_path: file }, callId: 'c' },
    { content: [{ type: 'image', data: 'x' }], isError: false })
  assert.equal(binary.content, undefined)
  const failed = await fire(host, 'tools/post-execute',
    { name: 'write', arguments: { file_path: file }, callId: 'c' },
    { content: [{ type: 'text', text: 'boom' }], isError: true })
  assert.equal(failed.content, undefined)
  const other = await fire(host, 'tools/post-execute',
    { name: 'grep', arguments: { file_path: file }, callId: 'c' },
    { content: [{ type: 'text', text: 'x' }], isError: false })
  assert.equal(other.content, undefined)
})

test('an already annotated result is not annotated twice', async () => {
  const { file, ...host } = await fixture('a\n')
  const already = { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'file_hash: abc123' }], isError: false }
  const decision = await fire(host, 'tools/post-execute',
    { name: 'read', arguments: { file_path: file }, callId: 'c' }, already)
  assert.equal(decision.content, undefined)
})

test('a vanished file simply gets no hash instead of failing the tool call', async () => {
  const { ...host } = await fixture('a\n')
  const decision = await annotate(host, 'read', join(tmpdir(), 'definitely-absent-file.txt'), 'x')
  assert.equal(decision.content, undefined)
})

test('patch rewrites a range using the hash the read result showed', async () => {
  const content = 'alpha\nbeta\ngamma\n'
  const { file, ...host } = await fixture(content)
  const hash = hashOf(await annotate(host, 'read', file, content))
  const out = await patch(host.tools, {
    file_path: file,
    file_hash: hash,
    line_start: 2,
    start_anchor: startAnchorOf('beta'),
    line_end: 2,
    end_anchor: endAnchorOf('beta'),
    replace: 'BETA',
  })
  assert.deepEqual(out.replaced, [2, 2])
  assert.equal(out.line_shift, 0)
  assert.equal(await readFile(file, 'utf8'), 'alpha\nBETA\ngamma\n')
  assert.equal(out.new_file_hash, fileHash('alpha\nBETA\ngamma\n'))
})

test('anchors are copied literally from what read displayed', async () => {
  const line = '    const total = compute(alpha, beta)'
  const content = `${line}\nsecond\n`
  const { file, ...host } = await fixture(content)
  const hash = hashOf(await annotate(host, 'read', file, content))
  const out = await patch(host.tools, {
    file_path: file,
    file_hash: hash,
    line_start: 1,
    start_anchor: line.slice(0, ANCHOR_CHARS),
    line_end: 1,
    end_anchor: line.trimEnd().slice(-ANCHOR_CHARS),
    replace: 'const total = 0',
  })
  assert.equal(out.line_shift, 0)
  assert.equal(await readFile(file, 'utf8'), 'const total = 0\nsecond\n')
})

test('patch refuses a stale hash and leaves the file untouched', async () => {
  const content = 'alpha\nbeta\n'
  const { file, ...host } = await fixture(content)
  await assert.rejects(
    () => patch(host.tools, {
      file_path: file,
      file_hash: '000000',
      line_start: 2,
      start_anchor: 'beta',
      line_end: 2,
      end_anchor: 'beta',
      replace: 'X',
    }),
    (error) => {
      assert.match(error.message, /file_hash mismatch.*read it again/)
      // Echoing the current hash would let a retry pair fresh bytes with the
      // caller's stale line numbers.
      assert.doesNotMatch(error.message, /[0-9a-f]{6}/, 'the message must not disclose any hash')
      return true
    },
  )
  assert.equal(await readFile(file, 'utf8'), content)
})

test('a wrong line number is an anchor error that says not to reread', async () => {
  const content = 'alpha\nbeta\n'
  const { file, ...host } = await fixture(content)
  const hash = hashOf(await annotate(host, 'read', file, content))
  await assert.rejects(
    () => patch(host.tools, {
      file_path: file,
      file_hash: hash,
      line_start: 2,
      start_anchor: 'gamma gamma gamm',
      line_end: 2,
      end_anchor: 'beta',
      replace: 'X',
    }),
    error => {
      assert.match(error.message, /does not match line 2/)
      assert.match(error.message, /do not reread the file/)
      return true
    },
  )
})

test('writes reach the provider with a replaceIfVersion intent', async () => {
  const content = 'alpha\nbeta\n'
  const { file, ...host } = await fixture(content)
  const hash = hashOf(await annotate(host, 'read', file, content))
  await patch(host.tools, {
    file_path: file,
    file_hash: hash,
    line_start: 2,
    start_anchor: 'beta',
    line_end: 2,
    end_anchor: 'beta',
    replace: 'Y',
  })
  assert.equal(host.intents.length, 1)
  assert.equal(host.intents[0].kind, 'replaceIfVersion')
})

test('the hash changes after a patch and the next patch can chain on it', async () => {
  const content = 'one\ntwo\nthree\n'
  const { file, ...host } = await fixture(content)
  const first = await patch(host.tools, {
    file_path: file,
    file_hash: hashOf(await annotate(host, 'read', file, content)),
    line_start: 2,
    start_anchor: 'two',
    line_end: 2,
    end_anchor: 'two',
    replace: 'TWO',
  })
  const second = await patch(host.tools, {
    file_path: file,
    file_hash: first.new_file_hash,
    line_start: 2,
    start_anchor: 'TWO',
    line_end: 2,
    end_anchor: 'TWO',
    replace: 'TWO!',
  })
  assert.equal(second.new_file_hash, fileHash('one\nTWO!\nthree\n'))
  assert.equal(await readFile(file, 'utf8'), 'one\nTWO!\nthree\n')
})

test('a missing file is reported by patch', async () => {
  const { tools } = await fixture('a\n')
  await assert.rejects(
    () => patch(tools, {
      file_path: join(tmpdir(), 'definitely-absent-file.txt'),
      file_hash: 'abcdef',
      line_start: 1,
      start_anchor: 'a',
      line_end: 1,
      end_anchor: 'a',
      replace: 'b',
    }),
    /file not found/,
  )
})
