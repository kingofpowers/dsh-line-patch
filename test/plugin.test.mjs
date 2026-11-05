/** Glue tests: the hash annotation and the `patch` tool against a stub host. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition) } },
    on: (eventName, handler) => {
      if (!listeners.has(eventName)) listeners.set(eventName, [])
      listeners.get(eventName).push(handler)
    },
    emit: (...args) => { emitted.push(args) },
    waterfall: async (_name, _target, _actor, next) => next(),
    fs: {
      async resolve(p) { return { targetKey: p, displayPath: p } },
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
  return { ctx, tools, listeners, emitted, intents }
}

/** Deliver one host waterfall event to its listeners, threading the continuation. */
async function fire(host, eventName, ...args) {
  const next = (decision) => decision
  for (const handler of host.listeners.get(eventName) ?? []) {
    const returned = await handler(...args, next)
    if (returned !== undefined) return returned
  }
  return next({ kind: 'accept' })
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
  const match = typeof last?.text === 'string' ? last.text.match(/^file_hash: ([0-9a-f]+)$/) : null
  return match?.[1]
}

test('the plugin exports the expected shape', () => {
  assert.equal(name, 'line-patch')
  assert.deepEqual(inject, ['tools', 'fs'])
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

test('a read result gains the current file hash', async () => {
  const { file, ...host } = await fixture('alpha\nbeta\n')
  const decision = await annotate(host, 'read', file, '1: alpha\n2: beta\n')
  assert.equal(hashOf(decision), fileHash('alpha\nbeta\n'))
  assert.equal(decision.content.length, 2, 'the annotation is appended, not substituted')
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
    /file_hash mismatch.*read it again/,
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
