/** Unit tests for the pure anchoring logic — no Harness required. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANCHOR_CHARS,
  LINE_SEPARATOR,
  applyPatch,
  detectEol,
  endAnchorOf,
  fileHash,
  matchesEnd,
  matchesStart,
  normalizeAnchor,
  renderNumbered,
  splitKeepEnds,
  startAnchorOf,
} from '../lib/core.js'

const SAMPLE = 'alpha\nbeta\ngamma\ndelta\n'

/** The bare text of one 1-based line; out-of-range numbers yield an empty anchor. */
function lineAt(content, number) {
  const line = splitKeepEnds(content)[number - 1]
  return line === undefined ? '' : line.replace(/[\r\n]+$/, '')
}

/** Build a patch request that should succeed, letting tests override fields. */
function request(overrides = {}) {
  const content = overrides.content ?? SAMPLE
  const lineStart = overrides.lineStart ?? 2
  const lineEnd = overrides.lineEnd ?? lineStart
  return {
    content,
    expectedFileHash: overrides.expectedFileHash ?? fileHash(content),
    lineStart,
    startAnchor: overrides.startAnchor ?? startAnchorOf(lineAt(content, lineStart)),
    lineEnd,
    endAnchor: overrides.endAnchor ?? endAnchorOf(lineAt(content, lineEnd)),
    replace: overrides.replace ?? 'BETA',
    totalLines: overrides.totalLines,
  }
}

test('file hash is a 16 char sha256 prefix and tracks content', () => {
  assert.equal(fileHash(SAMPLE).length, 16)
  assert.notEqual(fileHash(SAMPLE), fileHash(`${SAMPLE}x`))
  assert.equal(fileHash(SAMPLE), fileHash(Buffer.from(SAMPLE)))
})

test('splitKeepEnds rejoins to the exact input', () => {
  for (const text of ['', 'a', 'a\n', 'a\nb', 'a\r\nb\r\n', '\n\n']) {
    assert.equal(splitKeepEnds(text).join(''), text)
  }
})

test('renderNumbered numbers from the requested start and keeps the text verbatim', () => {
  const out = renderNumbered('alpha\n  beta\n', 10)
  const rows = out.trimEnd().split('\n')
  assert.equal(rows.length, 2)
  assert.equal(rows[0], `10${LINE_SEPARATOR}alpha`)
  assert.equal(rows[1], `11${LINE_SEPARATOR}  beta`)
})

test('renderNumbered carries no per-line hash', () => {
  const row = renderNumbered('alpha\n').trimEnd()
  assert.equal(row, `1${LINE_SEPARATOR}alpha`)
})

test('normalizeAnchor collapses whitespace and trims both ends', () => {
  assert.equal(normalizeAnchor('   const  foo\t=  bar   '), 'const foo = bar')
  assert.equal(normalizeAnchor(''), '')
  assert.equal(normalizeAnchor(undefined), '')
})

test('anchors are 16 characters, or the whole line when it is shorter', () => {
  const long = '  const value = compute(input)  '
  const normalized = normalizeAnchor(long)
  assert.equal(startAnchorOf(long), normalized.slice(0, ANCHOR_CHARS))
  assert.equal(endAnchorOf(long), normalized.slice(-ANCHOR_CHARS))
  assert.equal(startAnchorOf(long).length, ANCHOR_CHARS)
  assert.equal(startAnchorOf('  }'), '}')
  assert.equal(endAnchorOf('  }'), '}')
})

test('start anchors match by prefix, ignoring indentation on either side', () => {
  assert.equal(matchesStart('  const foo = bar', 'const foo'), true)
  assert.equal(matchesStart('const foo = bar', '  const foo = ba'), true)
  assert.equal(matchesStart('const foo = bar', 'CONST'), false)
})

test('end anchors match by suffix, and exactly once the line is short', () => {
  assert.equal(matchesEnd('  return compute(x)', 'compute(x)'), true)
  assert.equal(matchesEnd('  return compute(x)', 'return'), false)
  assert.equal(matchesEnd('  }', '}'), true)
})

test('an empty anchor means "this line is blank" and nothing else', () => {
  assert.equal(matchesStart('   ', ''), true)
  assert.equal(matchesEnd('   ', ''), true)
  assert.equal(matchesStart('x', ''), false)
  assert.equal(matchesEnd('x', ''), false)
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

test('a stale file hash is rejected before any anchor check', () => {
  const result = applyPatch(request({ expectedFileHash: 'deadbeefdeadbeef', startAnchor: 'nonsense' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FILE_HASH_MISMATCH')
  assert.match(result.message, /read it again/)
})

test('a matching file hash plus a wrong anchor is a line-number error, not a stale read', () => {
  const badStart = applyPatch(request({ startAnchor: 'zzzz' }))
  assert.equal(badStart.ok, false)
  assert.equal(badStart.code, 'LINE_ANCHOR_MISMATCH')
  assert.match(badStart.message, /line 2 does not start with "zzzz"/)
  assert.match(badStart.message, /it starts with "beta"/)
  assert.match(badStart.message, /Do not reread the file/)

  const badEnd = applyPatch(request({ lineStart: 1, lineEnd: 2, endAnchor: 'zzzz' }))
  assert.equal(badEnd.ok, false)
  assert.equal(badEnd.code, 'LINE_ANCHOR_MISMATCH')
  assert.match(badEnd.message, /line 2 does not end with "zzzz"/)
  assert.match(badEnd.message, /it ends with "beta"/)
})

test('anchors written with the file indentation still match', () => {
  const content = 'function f() {\n    return 1\n}\n'
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: '    return 1',
    lineEnd: 2,
    endAnchor: '    return 1',
    replace: '    return 2',
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, 'function f() {\n    return 2\n}\n')
})

test('a single-line patch accepts the head anchor in both slots', () => {
  const result = applyPatch(request({ startAnchor: 'be', endAnchor: 'be' }))
  assert.equal(result.ok, true)
  assert.equal(result.content, 'alpha\nBETA\ngamma\ndelta\n')
})

test('a short symbol line is identified by its whole text', () => {
  const content = 'if (x) {\n  go()\n}\n'
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 3,
    startAnchor: '}',
    lineEnd: 3,
    endAnchor: '}',
    replace: '};',
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, 'if (x) {\n  go()\n};\n')
})

test('total_lines cross-checks the line numbers', () => {
  const bad = applyPatch(request({ totalLines: 99 }))
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'TOTAL_LINES_MISMATCH')
  assert.match(bad.message, /you passed 99 but the file has 4 lines/)
  assert.equal(applyPatch(request({ totalLines: 4 })).ok, true)
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

test('deleting a blank line needs the empty anchor', () => {
  const content = 'alpha\n\nbeta\n'
  const deleted = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: '',
    lineEnd: 2,
    endAnchor: '',
    replace: '',
  })
  assert.equal(deleted.ok, true)
  assert.equal(deleted.content, 'alpha\nbeta\n')
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

test('the end anchor of the last line needs no EOF sentinel', () => {
  const content = 'alpha\nomega'
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: 'omega',
    lineEnd: 2,
    endAnchor: 'omega',
    replace: 'omega2',
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, 'alpha\nomega2')
})
