/** Unit tests for the pure anchoring logic — no Harness required. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_LINE_HASH,
  annotateLines,
  applyPatch,
  detectEol,
  fileHash,
  lineHash,
  splitKeepEnds,
} from '../lib/core.js'

const SAMPLE = 'alpha\nbeta\ngamma\ndelta\n'

/** Build a patch request that should succeed, letting tests override fields. */
function request(overrides = {}) {
  const content = overrides.content ?? SAMPLE
  const lines = splitKeepEnds(content).map(l => l.replace(/[\r\n]+$/, ''))
  const lineStart = overrides.lineStart ?? 2
  const lineEnd = overrides.lineEnd ?? 2
  return {
    content,
    expectedFileHash: overrides.expectedFileHash ?? fileHash(content),
    lineStart,
    hashStart: overrides.hashStart ?? lineHash(lines[lineStart - 1] ?? ''),
    lineEnd,
    hashEnd: overrides.hashEnd ?? lineHash(lines[lineEnd - 1] ?? ''),
    replace: overrides.replace ?? 'BETA',
  }
}

test('line hashes are 4 hex chars and stable', () => {
  assert.equal(lineHash('alpha').length, 4)
  assert.match(lineHash('alpha'), /^[0-9a-f]{4}$/)
  assert.equal(lineHash('alpha'), lineHash('alpha'))
  assert.notEqual(lineHash('alpha'), lineHash('beta'))
})

test('a blank line has a hash too', () => {
  assert.equal(lineHash(''), EMPTY_LINE_HASH)
  assert.match(EMPTY_LINE_HASH, /^[0-9a-f]{4}$/)
})

test('file hash is a 16 char sha256 prefix and tracks content', () => {
  assert.equal(fileHash(SAMPLE).length, 16)
  assert.notEqual(fileHash(SAMPLE), fileHash(SAMPLE + 'x'))
  assert.equal(fileHash(SAMPLE), fileHash(Buffer.from(SAMPLE)))
})

test('splitKeepEnds rejoins to the exact input', () => {
  for (const text of ['', 'a', 'a\n', 'a\nb', 'a\r\nb\r\n', '\n\n']) {
    assert.equal(splitKeepEnds(text).join(''), text)
  }
})

test('annotateLines numbers from the requested start', () => {
  const out = annotateLines('alpha\nbeta\n', 10)
  const rows = out.trimEnd().split('\n')
  assert.equal(rows.length, 2)
  assert.match(rows[0], /^10\/[0-9a-f]{4}: alpha$/)
  assert.match(rows[1], /^11\/[0-9a-f]{4}: beta$/)
})

test('annotateLines marks blank lines with the fixed hash', () => {
  const out = annotateLines('a\n\nb\n')
  assert.match(out.split('\n')[1], new RegExp(`^2/${EMPTY_LINE_HASH}: $`))
})

test('detectEol reports the file style', () => {
  assert.equal(detectEol('a\nb\n'), '\n')
  assert.equal(detectEol('a\r\nb\r\n'), '\r\n')
})

test('a matching request replaces exactly the range', () => {
  const result = applyPatch(request())
  assert.equal(result.ok, true)
  assert.equal(result.content, 'alpha\nBETA\ngamma\ndelta\n')
  assert.equal(result.removedLines, 1)
  assert.equal(result.lineShift, 0)
  assert.equal(result.fileHash, fileHash(result.content))
})

test('a multi-line range is replaced as one block', () => {
  const result = applyPatch(request({ lineStart: 2, lineEnd: 3, replace: 'one\ntwo\nthree' }))
  assert.equal(result.ok, true)
  assert.equal(result.content, 'alpha\none\ntwo\nthree\ndelta\n')
  assert.equal(result.removedLines, 2)
  assert.equal(result.lineShift, 1)
})

test('a whole-file range is replaced', () => {
  const result = applyPatch(request({ lineStart: 1, lineEnd: 4, replace: 'only' }))
  assert.equal(result.ok, true)
  assert.equal(result.content, 'only\n')
})

test('a stale file hash is rejected before any line check', () => {
  const result = applyPatch(request({ expectedFileHash: 'deadbeefdeadbeef' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FILE_HASH_MISMATCH')
  assert.match(result.message, /read it again/)
})

test('a stale boundary hash is rejected with its line number', () => {
  const badStart = applyPatch(request({ hashStart: 'zzzz' }))
  assert.equal(badStart.ok, false)
  assert.equal(badStart.code, 'LINE_HASH_MISMATCH')
  assert.match(badStart.message, /line 2 hash mismatch/)

  const badEnd = applyPatch(request({ lineStart: 1, lineEnd: 2, hashEnd: 'zzzz' }))
  assert.equal(badEnd.ok, false)
  assert.match(badEnd.message, /line 2 hash mismatch/)
})

test('out-of-range requests are rejected', () => {
  assert.equal(applyPatch(request({ lineStart: 9, lineEnd: 9 })).code, 'RANGE_INVALID')
  const inverted = applyPatch(request({ content: SAMPLE, lineStart: 3, lineEnd: 2 }))
  assert.equal(inverted.ok, false)
  assert.equal(inverted.code, 'RANGE_INVALID')
})

test('an empty replacement deletes the range instead of leaving a blank line', () => {
  const result = applyPatch(request({ lineStart: 2, lineEnd: 3, replace: '' }))
  assert.equal(result.ok, true)
  assert.equal(result.content, 'alpha\ndelta\n')
  assert.equal(result.lineShift, -2)
})

test('CRLF files stay CRLF through a replacement', () => {
  const content = 'alpha\r\nbeta\r\ngamma\r\n'
  const result = applyPatch(request({ content, lineStart: 2, lineEnd: 2, replace: 'BETA\nEXTRA' }))
  assert.equal(result.ok, true)
  assert.equal(result.content, 'alpha\r\nBETA\r\nEXTRA\r\ngamma\r\n')
  assert.equal(detectEol(result.content), '\r\n')
})

test('a final line without a newline keeps that shape', () => {
  const content = 'alpha\nbeta'
  const result = applyPatch(request({ content, lineStart: 2, lineEnd: 2, replace: 'BETA' }))
  assert.equal(result.ok, true)
  assert.equal(result.content, 'alpha\nBETA')
})

test('replacing the last line of a newline-terminated file keeps the terminator', () => {
  const result = applyPatch(request({ lineStart: 4, lineEnd: 4, replace: 'delta2' }))
  assert.equal(result.ok, true)
  assert.equal(result.content, 'alpha\nbeta\ngamma\ndelta2\n')
})
