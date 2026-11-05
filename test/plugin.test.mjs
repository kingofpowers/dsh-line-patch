/** Glue tests: the plugin's two tools against a stub host (no Harness needed). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'
import { LINE_SEPARATOR, endAnchorOf, fileHash, splitKeepEnds, startAnchorOf } from '../lib/core.js'

/** Build a stub plugin context exposing the host surface the plugin touches. */
function makeCtx() {
  const tools = new Map()
  const emitted = []
  const intents = []
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition) } },
    on: () => {},
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
  return { ctx, tools, emitted, intents }
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

/** Drive a registered tool with canonical arguments. */
async function call(tools, toolName, args) {
  return tools.get(toolName).execute(args, { signal: undefined })
}

/** Pull the text of one 1-based line out of a read_hash result, as a model would. */
function rowText(readOutput, lineNumber) {
  const prefix = `${lineNumber}${LINE_SEPARATOR}`
  const row = readOutput.content.split('\n').find(line => line.startsWith(prefix))
  assert.ok(row, `line ${lineNumber} missing from the read result`)
  return row.slice(prefix.length)
}

/** Build patch_hash arguments whose anchors repeat what the read result showed. */
function patchArgs(file, readOutput, lineStart, lineEnd = lineStart, replace = 'X') {
  return {
    file_path: file,
    file_hash: readOutput.file_hash,
    line_start: lineStart,
    start_anchor: startAnchorOf(rowText(readOutput, lineStart)),
    line_end: lineEnd,
    end_anchor: endAnchorOf(rowText(readOutput, lineEnd)),
    replace,
  }
}

test('the plugin exports the expected shape', () => {
  assert.equal(name, 'line-patch')
  assert.deepEqual(inject, ['tools', 'fs'])
})

test('read_hash numbers every line, hashes the file, and adds no per-line hash', async () => {
  const { file, tools } = await fixture('alpha\nbeta\ngamma\n')
  const out = await call(tools, 'read_hash', { file_path: file })
  assert.equal(out.file_hash, fileHash('alpha\nbeta\ngamma\n'))
  assert.equal(out.total_lines, 3)
  assert.equal(out.anchor_chars, 16)
  const rows = out.content.trimEnd().split('\n')
  assert.deepEqual(rows, [`1${LINE_SEPARATOR}alpha`, `2${LINE_SEPARATOR}beta`, `3${LINE_SEPARATOR}gamma`])
})

test('read_hash honours offset and limit with absolute numbering', async () => {
  const { file, tools } = await fixture('a\nb\nc\nd\n')
  const out = await call(tools, 'read_hash', { file_path: file, offset: 2, limit: 2 })
  const rows = out.content.trimEnd().split('\n')
  assert.equal(rows.length, 2)
  assert.equal(rows[0], `2${LINE_SEPARATOR}b`)
  assert.equal(out.truncated, true)
})

test('patch_hash rewrites a range whose anchors came from the read result', async () => {
  const content = 'alpha\nbeta\ngamma\n'
  const { file, tools } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  const out = await call(tools, 'patch_hash', patchArgs(file, read, 2, 2, 'BETA'))
  assert.deepEqual(out.replaced, [2, 2])
  assert.equal(out.line_shift, 0)
  const after = await readFile(file, 'utf8')
  assert.equal(after, 'alpha\nBETA\ngamma\n')
  assert.equal(out.new_file_hash, fileHash(after))
})

test('a multi-line patch uses both boundary lines', async () => {
  const content = 'alpha\nbeta\ngamma\ndelta\n'
  const { file, tools } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  const args = patchArgs(file, read, 2, 3, 'one\ntwo\nthree')
  const out = await call(tools, 'patch_hash', args)
  assert.equal(out.line_shift, 1)
  assert.equal(await readFile(file, 'utf8'), 'alpha\none\ntwo\nthree\ndelta\n')
})

test('patch_hash refuses a stale file hash and leaves the file untouched', async () => {
  const content = 'alpha\nbeta\n'
  const { file, tools } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  await assert.rejects(
    () => call(tools, 'patch_hash', { ...patchArgs(file, read, 2, 2, 'X'), file_hash: 'deadbeefdeadbeef' }),
    /file_hash mismatch/,
  )
  assert.equal(await readFile(file, 'utf8'), content)
})

test('a wrong line number is reported as an anchor error that says not to reread', async () => {
  const content = 'alpha\nbeta\n'
  const { file, tools } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  await assert.rejects(
    () => call(tools, 'patch_hash', { ...patchArgs(file, read, 2, 2, 'X'), start_anchor: 'gamma' }),
    error => {
      assert.match(error.message, /does not start with "gamma"/)
      assert.match(error.message, /Do not reread the file/)
      return true
    },
  )
  assert.equal(await readFile(file, 'utf8'), content)
})

test('total_lines rejects a wrong line number before any anchor check', async () => {
  const content = 'alpha\nbeta\n'
  const { file, tools } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  await assert.rejects(
    () => call(tools, 'patch_hash', { ...patchArgs(file, read, 2, 2, 'X'), total_lines: 7 }),
    /total_lines mismatch/,
  )
})

test('an empty replace deletes the range', async () => {
  const content = 'alpha\nbeta\ngamma\n'
  const { file, tools } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  const out = await call(tools, 'patch_hash', patchArgs(file, read, 2, 2, ''))
  assert.equal(out.line_shift, -1)
  assert.equal(await readFile(file, 'utf8'), 'alpha\ngamma\n')
})

test('writes reach the provider with a replaceIfVersion intent', async () => {
  const content = 'alpha\nbeta\n'
  const { file, tools, intents } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  await call(tools, 'patch_hash', patchArgs(file, read, 2, 2, 'Y'))
  assert.equal(intents.length, 1)
  assert.equal(intents[0].kind, 'replaceIfVersion')
})

test('reads emit an observation so the policy gate sees the file as read', async () => {
  const { file, tools, emitted } = await fixture('a\nb\n')
  await call(tools, 'read_hash', { file_path: file })
  const observed = emitted.find(([eventName]) => eventName === 'fs/observed')
  assert.ok(observed, 'expected an fs/observed emission')
  assert.equal(observed[2].kind, 'present')
})

test('a missing file fails with a clear message', async () => {
  const { tools } = await fixture('a\n')
  await assert.rejects(
    () => call(tools, 'read_hash', { file_path: join(tmpdir(), 'definitely-absent-file.txt') }),
    /file not found/,
  )
})

test('consecutive patches only need the hash the previous patch returned', async () => {
  const content = 'one\ntwo\nthree\n'
  const { file, tools } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  const first = await call(tools, 'patch_hash', patchArgs(file, read, 2, 2, 'TWO'))
  const second = await call(tools, 'patch_hash', {
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

test('splitKeepEnds is the line model the plugin exposes', () => {
  assert.equal(splitKeepEnds('a\r\nb').length, 2)
})
