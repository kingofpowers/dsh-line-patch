/** Unit tests for the pure anchoring logic — no Harness required. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANCHOR_CHARS,
  anchorTooShort,
  applyPatch,
  detectEol,
  endAnchorOf,
  fileHash,
  matchesEnd,
  matchesStart,
  normalizeAnchor,
  normalizeIndented,
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
  }
}

test('file hash is a 16 char sha256 prefix and tracks content', () => {
  assert.equal(fileHash(SAMPLE).length, 6)
  assert.notEqual(fileHash(SAMPLE), fileHash(`${SAMPLE}x`))
  assert.equal(fileHash(SAMPLE), fileHash(Buffer.from(SAMPLE)))
})

test('file hash is the sha256 prefix, pinned literally', () => {
  assert.equal(fileHash('alpha\nbeta\ngamma\n'), '4fdbc4')
  assert.equal(fileHash(''), 'e3b0c4')
})

test('splitKeepEnds rejoins to the exact input', () => {
  for (const text of ['', 'a', 'a\n', 'a\nb', 'a\r\nb\r\n', '\n\n']) {
    assert.equal(splitKeepEnds(text).join(''), text)
  }
})

test('normalizeAnchor collapses whitespace and trims both ends', () => {
  assert.equal(normalizeAnchor('   const  foo\t=  bar   '), 'const foo = bar')
  assert.equal(normalizeAnchor(''), '')
  assert.equal(normalizeAnchor(undefined), '')
})

test('normalizeIndented keeps the indentation but still collapses inner runs', () => {
  assert.equal(normalizeIndented('    const  foo\t=  bar   '), '    const foo = bar')
  assert.equal(normalizeIndented('x'), 'x')
  assert.equal(normalizeIndented(''), '')
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

test('start anchors match by prefix and ignore layout whitespace', () => {
  assert.equal(matchesStart('  const foo = bar', 'const foo'), true)
  assert.equal(matchesStart('const  foo\t= bar', 'const foo = b'), true)
  assert.equal(matchesStart('const foo = bar', 'CONST'), false)
  assert.equal(matchesStart('const foo = bar', 'foo'), false)
})

test('an anchor that carries indentation is compared with indentation kept', () => {
  assert.equal(matchesStart('    if (err) {', '    if (err) {'), true)
  assert.equal(matchesStart('    if (err) {', '  if (err) {'), false)
  // The nesting mistake this protects against: line 1 is not line 2.
  assert.equal(matchesStart('if (err) {', '    if (err) {'), false)
})

test('end anchors match by suffix', () => {
  assert.equal(matchesEnd('  return compute(x)', 'compute(x)'), true)
  assert.equal(matchesEnd('  return compute(x)', 'return'), false)
  assert.equal(matchesEnd('beta', 'eta'), true)
  assert.equal(matchesEnd('  }', '}'), true)
})

test('an empty anchor means "this line is blank" and nothing else', () => {
  assert.equal(matchesStart('   ', ''), true)
  assert.equal(matchesEnd('   ', ''), true)
  assert.equal(matchesStart('x', ''), false)
  assert.equal(matchesEnd('x', ''), false)
})

test('anchorTooShort separates a sloppy copy from a whole short line', () => {
  const long = 'const total = compute(a, b)'
  assert.equal(anchorTooShort(long, 'const to'), true)
  assert.equal(anchorTooShort(long, 'const total = com'), false)
  assert.equal(anchorTooShort('}', '}'), false)
  assert.equal(anchorTooShort('beta', 'beta'), false)
  assert.equal(anchorTooShort('beta', 'be'), true)
  assert.equal(anchorTooShort('beta', ''), false)
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
  const result = applyPatch(request({ expectedFileHash: 'deadbe', startAnchor: 'nonsense' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FILE_HASH_MISMATCH')
  assert.match(result.message, /read it again/)
})

test('a 16-character hash from an older session is an argument error, not a stale file', () => {
  const result = applyPatch(request({ expectedFileHash: fileHash(SAMPLE).padEnd(16, '0') }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BAD_ARGUMENT')
  assert.match(result.message, /6-character lowercase hex/)
  assert.match(result.message, /use edit or write instead/)
})

test('a truncated file hash is an argument error, not a prefix match', () => {
  const full = fileHash(SAMPLE)
  const result = applyPatch(request({ expectedFileHash: full.slice(0, 4) }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BAD_ARGUMENT')
})

test('an anchor that occurs mid-line is not a start anchor', () => {
  const content = 'aaaa bbbb cccc dddd foo\nbar\n'
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 1,
    startAnchor: 'bbbb cccc dddd foo',
    lineEnd: 1,
    endAnchor: 'bbbb cccc dddd foo',
    replace: 'x',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'LINE_ANCHOR_MISMATCH')
})

test('a wrong 16 character anchor names the real one and says not to reread', () => {
  const result = applyPatch(request({ startAnchor: 'gamma gamma gamm' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'LINE_ANCHOR_MISMATCH')
  assert.match(result.message, /does not match line 2/)
  assert.match(result.message, /which starts with "beta"/)
  assert.match(result.message, /do not reread the file/)
})

test('a wrong end anchor names the real one and says not to reread', () => {
  const result = applyPatch(request({ lineStart: 1, lineEnd: 2, endAnchor: 'zzzz zzzz zzzz z' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'LINE_ANCHOR_MISMATCH')
  assert.match(result.message, /does not match line 2/)
  assert.match(result.message, /which ends with "beta"/)
  assert.match(result.message, /do not reread the file/)
})

test('a short anchor is rejected with the length hint', () => {
  const result = applyPatch(request({ startAnchor: 'be' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ANCHOR_TOO_SHORT')
  assert.match(result.message, /is too short/)
  assert.match(result.message, /Do not reread the file/)
})

test('anchors copied verbatim with the file indentation still match', () => {
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

test('a nesting mistake is caught when the anchor carries its indentation', () => {
  const content = 'if (err) {\n    if (err) {\n        log(err)\n    }\n}\n'
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 1,
    startAnchor: '    if (err) {',
    lineEnd: 1,
    endAnchor: '    if (err) {',
    replace: 'if (fatal) {',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'LINE_ANCHOR_MISMATCH')
  assert.match(result.message, /does not match line 1/)
})

test('a single-line patch accepts the head anchor in both slots', () => {
  const result = applyPatch(request({ startAnchor: 'beta', endAnchor: 'beta' }))
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

test('out-of-range requests are rejected', () => {
  const start = applyPatch(request({ lineStart: 9, lineEnd: 9 }))
  assert.equal(start.code, 'RANGE_INVALID')
  assert.match(start.message, /do not reread the file/)

  const end = applyPatch(request({ lineStart: 2, lineEnd: 99 }))
  assert.equal(end.code, 'RANGE_INVALID')
  assert.match(end.message, /line_end 99 is out of range/)
  assert.match(end.message, /do not reread the file/)

  const inverted = applyPatch(request({ content: SAMPLE, lineStart: 3, lineEnd: 2 }))
  assert.equal(inverted.ok, false)
  assert.equal(inverted.code, 'RANGE_INVALID')
})

test('a line number below 1 is rejected too', () => {
  const result = applyPatch(request({ lineStart: 0, lineEnd: 0 }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'RANGE_INVALID')
  assert.match(result.message, /line_start 0 is out of range/)
})

test('non-integer line numbers and a non-string replace are bad arguments', () => {
  const nan = applyPatch(request({ lineStart: Number.NaN, lineEnd: Number.NaN }))
  assert.equal(nan.ok, false)
  assert.equal(nan.code, 'BAD_ARGUMENT')
  const float = applyPatch(request({ lineStart: 1.9, lineEnd: 2 }))
  assert.equal(float.code, 'BAD_ARGUMENT')
  const replace = applyPatch({ ...request(), replace: undefined })
  assert.equal(replace.ok, false)
  assert.equal(replace.code, 'BAD_ARGUMENT')
})

test('an empty file cannot be patched', () => {
  const result = applyPatch({
    content: '',
    expectedFileHash: fileHash(''),
    lineStart: 1,
    startAnchor: '',
    lineEnd: 1,
    endAnchor: '',
    replace: 'x',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'RANGE_INVALID')
  assert.match(result.message, /the file is empty/)
})

test('a single-line patch still rejects an anchor that matches nothing', () => {
  const result = applyPatch(request({ startAnchor: 'beta', endAnchor: 'zzzz zzzz zzzz z' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'LINE_ANCHOR_MISMATCH')
  assert.match(result.message, /does not match line 2/)
})

test('a wrong end anchor that shares the tail of the line is still rejected', () => {
  const content = 'const value = zzzzzzzz\nnext\n'
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 1,
    startAnchor: startAnchorOf('const value = zzzzzzzz'),
    lineEnd: 1,
    endAnchor: 'yyyyyyyyzzzzzzzz',
    replace: 'x',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'LINE_ANCHOR_MISMATCH')
})

test('an anchor shared by two long lines is rejected with a widening suggestion', () => {
  const first = 'const value = computeAlpha(input)'
  const second = 'const value = computeBeta_(input)'
  const content = `${first}\n${second}\n`
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: 'const value = co',
    lineEnd: 2,
    endAnchor: endAnchorOf(second),
    replace: 'x',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ANCHOR_AMBIGUOUS')
  assert.match(result.message, /start_anchor/)
  assert.match(result.message, /lines 1, 2/)
  assert.match(result.message, /copy more of it/)
  assert.match(result.message, /Do not reread the file/)
})

test('a shared end anchor is rejected too', () => {
  const first = 'const alpha = compute(input) // trailing tail here'
  const second = 'const beta_ = compute(input) // trailing tail here'
  const content = `${first}\n${second}\n`
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: second,
    lineEnd: 2,
    endAnchor: 'trailing tail here',
    replace: 'x',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ANCHOR_AMBIGUOUS')
  assert.match(result.message, /end_anchor/)
  assert.match(result.message, /do not reread/i)
})

test('widening the anchor resolves the ambiguity', () => {
  const first = 'const value = computeAlpha(input)'
  const second = 'const value = computeBeta_(input)'
  const content = `${first}\n${second}\n`
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: second,
    lineEnd: 2,
    endAnchor: second,
    replace: 'x',
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, `${first}\nx\n`)
})

test('a repeated whole line stays editable because no anchor could separate it', () => {
  const line = 'repeat this exact same line of text'
  const content = `${line}\n${line}\n`
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: 'repeat this exac',
    lineEnd: 2,
    endAnchor: 'same line of text',
    replace: 'changed',
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, `${line}\nchanged\n`)
})

test('repeated short symbols stay editable', () => {
  const content = 'if (x) {\n  go()\n}\nif (y) {\n  stop()\n}\n'
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
})

test('the suggested widening is itself unique, even past the old 80-character cap', () => {
  const shared = 'x'.repeat(100)
  const first = `${shared}-alpha-tail-${'y'.repeat(60)}`
  const second = `${shared}-omega-tail-${'z'.repeat(60)}`
  const content = `${first}\n${second}\n`
  const firstTry = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: shared.slice(0, 16),
    lineEnd: 2,
    endAnchor: second.slice(-16),
    replace: 'x',
  })
  assert.equal(firstTry.code, 'ANCHOR_AMBIGUOUS')
  const suggestion = /for example (".*?")\./.exec(firstTry.message)?.[1]
  assert.ok(suggestion, 'the message must print a copyable anchor')
  const widened = JSON.parse(suggestion)
  const secondTry = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: widened,
    lineEnd: 2,
    endAnchor: second.slice(-16),
    replace: 'x',
  })
  assert.equal(secondTry.ok, true, 'following the suggestion must succeed without a reread')
})

test('an ambiguity that is only resolvable past the visible line length is allowed', () => {
  // The read display truncates at 2,000 characters, so a unique prefix beyond
  // that is text the model never saw; suggesting it would be a trap.
  const shared = 'x'.repeat(2500)
  const first = `${shared}-alpha`
  const second = `${shared}-omega`
  const content = `${first}\n${second}\n`
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: shared.slice(0, 16),
    lineEnd: 2,
    endAnchor: second.slice(-16),
    replace: 'y',
  })
  assert.equal(result.ok, true, 'no suggestion is possible, so the line number decides')
})

test('a short end anchor is rejected with the length hint', () => {
  const result = applyPatch(request({ lineStart: 1, lineEnd: 1, endAnchor: 'lpha' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ANCHOR_TOO_SHORT')
  assert.match(result.message, /end_anchor/)
  assert.match(result.message, /is too short/)
  assert.match(result.message, /Do not reread the file/)
})

test('a single-line patch on a long line accepts the head slice in both slots', () => {
  const content = 'const total = compute(a, b, c)\nnext\n'
  const anchor = 'const total = com'
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 1,
    startAnchor: anchor,
    lineEnd: 1,
    endAnchor: anchor,
    replace: 'const total = 0',
  })
  assert.equal(result.ok, true)
  assert.equal(result.content, 'const total = 0\nnext\n')
})

test('an end mismatch on a long line echoes its real end anchor', () => {
  const line = 'aaaa bbbb cccc dddd eeee'
  const content = `${line}\nnext\n`
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 1,
    startAnchor: startAnchorOf(line),
    lineEnd: 1,
    endAnchor: 'xxxx xxxx xxxx xxxx',
    replace: 'x',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'LINE_ANCHOR_MISMATCH')
  assert.ok(
    result.message.includes(JSON.stringify(endAnchorOf(line))),
    `message must echo ${JSON.stringify(endAnchorOf(line))}: ${result.message}`,
  )
  assert.ok(!result.message.includes(JSON.stringify(startAnchorOf(line))))
})

test('a blank anchor on a non-blank line is named as blank', () => {
  const result = applyPatch(request({ startAnchor: '' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'LINE_ANCHOR_MISMATCH')
  assert.match(result.message, /start_anchor \(blank\) does not match line 2/)
  assert.match(result.message, /which starts with "beta"/)
})

test('a start anchor that is only whitespace asks for a slice with content', () => {
  const content = `${' '.repeat(20)}return value\nnext\n`
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 1,
    startAnchor: ' '.repeat(16),
    lineEnd: 1,
    endAnchor: endAnchorOf('return value'),
    replace: 'x',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ANCHOR_TOO_SHORT')
  assert.match(result.message, /only whitespace/)
  assert.match(result.message, /Do not reread the file/)
})

test('an end anchor that is only whitespace asks for a slice with content', () => {
  const content = `return value${' '.repeat(20)}\nnext\n`
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 1,
    startAnchor: 'return value',
    lineEnd: 1,
    endAnchor: ' '.repeat(16),
    replace: 'x',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ANCHOR_TOO_SHORT')
  assert.match(result.message, /only whitespace/)
  assert.match(result.message, /Do not reread the file/)
})

test('a whitespace-only anchor on a blank line points at the empty anchor', () => {
  const content = 'a\n    \nb\n'
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: '   ',
    lineEnd: 2,
    endAnchor: '   ',
    replace: 'X',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ANCHOR_TOO_SHORT')
  assert.match(result.message, /line 2 is blank/)
  assert.match(result.message, /pass ""/)
  assert.match(result.message, /Do not reread the file/)

  const withEmpty = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 2,
    startAnchor: '',
    lineEnd: 2,
    endAnchor: '',
    replace: 'X',
  })
  assert.equal(withEmpty.ok, true)
  assert.equal(withEmpty.content, 'a\nX\nb\n')
})

test('an indentation mismatch echoes the line exactly as shown', () => {
  const content = '    if (err) {\n        log()\n}\n'
  const result = applyPatch({
    content,
    expectedFileHash: fileHash(content),
    lineStart: 1,
    startAnchor: '        if (err) {',
    lineEnd: 1,
    endAnchor: endAnchorOf('    if (err) {'),
    replace: '    if (fatal) {',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'LINE_ANCHOR_MISMATCH')
  // The echoed anchor must keep the indentation the model is told to copy.
  assert.ok(
    result.message.includes(JSON.stringify('    if (err) {')),
    `message must echo the indented anchor: ${result.message}`,
  )
  assert.match(result.message, /including the indentation/)
})

test('inner whitespace runs on the line side are still matched', () => {
  assert.equal(matchesStart('const   value\t=  1', 'const value = 1'), true)
  assert.equal(matchesEnd('return   value\t;', 'value ;'), true)
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

test('a replacement of just a line terminator still inserts its blank line at EOF', () => {
  const result = applyPatch(request({ content: 'alpha\nbeta', lineStart: 2, lineEnd: 2, replace: '\n' }))
  assert.equal(result.ok, true)
  assert.equal(result.content, 'alpha\n\n')
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
