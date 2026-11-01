/** Glue tests: the plugin's two tools against a stub host (no Harness needed). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'
import { fileHash, lineHash, splitKeepEnds } from '../lib/core.js'

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

test('the plugin exports the expected shape', () => {
  assert.equal(name, 'line-patch')
  assert.deepEqual(inject, ['tools', 'fs'])
})

test('read_hash annotates every line and reports the file hash', async () => {
  const { file, tools } = await fixture('alpha\nbeta\ngamma\n')
  const out = await call(tools, 'read_hash', { file_path: file })
  assert.equal(out.file_hash, fileHash('alpha\nbeta\ngamma\n'))
  assert.equal(out.total_lines, 3)
  const rows = out.content.trimEnd().split('\n')
  assert.equal(rows.length, 3)
  assert.match(rows[0], /^1\/[0-9a-f]{4}: alpha$/)
  assert.match(rows[2], /^3\/[0-9a-f]{4}: gamma$/)
})

test('read_hash honours offset and limit with absolute numbering', async () => {
  const { file, tools } = await fixture('a\nb\nc\nd\n')
  const out = await call(tools, 'read_hash', { file_path: file, offset: 2, limit: 2 })
  const rows = out.content.trimEnd().split('\n')
  assert.equal(rows.length, 2)
  assert.match(rows[0], /^2\/[0-9a-f]{4}: b$/)
  assert.equal(out.truncated, true)
})

test('patch_hash rewrites the range and reports the new file hash', async () => {
  const content = 'alpha\nbeta\ngamma\n'
  const { file, tools } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  const lines = splitKeepEnds(content).map(l => l.replace(/\n$/, ''))
  const out = await call(tools, 'patch_hash', {
    file_path: file,
    file_hash: read.file_hash,
    line_start: 2,
    hash_start: lineHash(lines[1]),
    line_end: 2,
    hash_end: lineHash(lines[1]),
    replace: 'BETA',
  })
  assert.deepEqual(out.replaced, [2, 2])
  assert.equal(out.line_shift, 0)
  const after = await readFile(file, 'utf8')
  assert.equal(after, 'alpha\nBETA\ngamma\n')
  assert.equal(out.new_file_hash, fileHash(after))
})

test('patch_hash refuses a stale file hash and leaves the file untouched', async () => {
  const content = 'alpha\nbeta\n'
  const { file, tools } = await fixture(content)
  const lines = splitKeepEnds(content).map(l => l.replace(/\n$/, ''))
  await assert.rejects(
    () => call(tools, 'patch_hash', {
      file_path: file,
      file_hash: 'deadbeefdeadbeef',
      line_start: 2,
      hash_start: lineHash(lines[1]),
      line_end: 2,
      hash_end: lineHash(lines[1]),
      replace: 'X',
    }),
    /file_hash mismatch/,
  )
  assert.equal(await readFile(file, 'utf8'), content)
})

test('patch_hash refuses a stale boundary hash and leaves the file untouched', async () => {
  const content = 'alpha\nbeta\n'
  const { file, tools } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  await assert.rejects(
    () => call(tools, 'patch_hash', {
      file_path: file,
      file_hash: read.file_hash,
      line_start: 1,
      hash_start: 'zzzz',
      line_end: 2,
      hash_end: 'zzzz',
      replace: 'X',
    }),
    /line 1 hash mismatch/,
  )
  assert.equal(await readFile(file, 'utf8'), content)
})

test('an empty replace deletes the range', async () => {
  const content = 'alpha\nbeta\ngamma\n'
  const { file, tools } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  const lines = splitKeepEnds(content).map(l => l.replace(/\n$/, ''))
  const out = await call(tools, 'patch_hash', {
    file_path: file,
    file_hash: read.file_hash,
    line_start: 2,
    hash_start: lineHash(lines[1]),
    line_end: 2,
    hash_end: lineHash(lines[1]),
    replace: '',
  })
  assert.equal(out.line_shift, -1)
  assert.equal(await readFile(file, 'utf8'), 'alpha\ngamma\n')
})

test('writes reach the provider with a replaceIfVersion intent', async () => {
  const content = 'alpha\nbeta\n'
  const { file, tools, intents } = await fixture(content)
  const read = await call(tools, 'read_hash', { file_path: file })
  const lines = splitKeepEnds(content).map(l => l.replace(/\n$/, ''))
  await call(tools, 'patch_hash', {
    file_path: file,
    file_hash: read.file_hash,
    line_start: 2,
    hash_start: lineHash(lines[1]),
    line_end: 2,
    hash_end: lineHash(lines[1]),
    replace: 'Y',
  })
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
