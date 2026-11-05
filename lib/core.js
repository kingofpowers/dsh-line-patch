/**
 * dsh-line-patch — pure anchoring logic.
 *
 * No I/O and no host API lives here: every function takes text in and returns
 * text out, so the whole editing contract is unit-testable without a Harness.
 *
 * The anchors a model copies are *content* slices, not hashes: the line number
 * plus the first and last characters of the boundary lines are visible in the
 * read result, so nothing has to be recomputed to write them back.
 */
import { createHash } from 'node:crypto'

/** Characters kept from a boundary line — enough to identify it, cheap to copy. */
export const ANCHOR_CHARS = 16

/** Characters kept from the whole-file sha256 — enough to spot a changed file. */
export const FILE_HASH_CHARS = 16

/** Longest slice of a mismatching line echoed back in an error message. */
const PREVIEW_CHARS = 60

/** Separator between a line number and its text: one token, and unmistakable. */
export const LINE_SEPARATOR = '│'

/**
 * The anchor shown for a whole file.
 * @param {string|Buffer} content - raw file content.
 * @returns {string} a 16-character sha256 prefix.
 */
export function fileHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, FILE_HASH_CHARS)
}

/**
 * Detect the line ending a file is written in so replacements keep it.
 * @param {string} content - the file text.
 * @returns {string} '\r\n' or '\n'.
 */
export function detectEol(content) {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Split text into lines while keeping each line's own ending.
 *
 * Rejoining the result must reproduce the input byte for byte; a final line
 * without a newline therefore stays without one.
 * @param {string} content - the file text.
 * @returns {string[]} lines, each ending in '\n' except possibly the last.
 */
export function splitKeepEnds(content) {
  const out = []
  let start = 0
  while (start < content.length) {
    const nl = content.indexOf('\n', start)
    if (nl < 0) {
      out.push(content.slice(start))
      break
    }
    out.push(content.slice(start, nl + 1))
    start = nl + 1
  }
  return out
}

/** Strip a line's ending terms before comparing or showing it. */
function bareLine(line) {
  return line.replace(/[\r\n]+$/, '')
}

/**
 * Reduce both sides of an anchor comparison to one canonical form.
 *
 * Indentation, trailing spaces, tabs and alignment padding all collapse away,
 * so a model may copy an anchor with or without the surrounding whitespace.
 * @param {unknown} text - an anchor candidate or a real line.
 * @returns {string} whitespace-collapsed text.
 */
export function normalizeAnchor(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The anchor a line offers at its start: its first `ANCHOR_CHARS` characters.
 * @param {string} line - the line without its ending.
 * @returns {string} the start anchor.
 */
export function startAnchorOf(line) {
  return normalizeAnchor(line).slice(0, ANCHOR_CHARS)
}

/**
 * The anchor a line offers at its end: its last `ANCHOR_CHARS` characters.
 * @param {string} line - the line without its ending.
 * @returns {string} the end anchor.
 */
export function endAnchorOf(line) {
  return normalizeAnchor(line).slice(-ANCHOR_CHARS)
}

/**
 * Does a model-supplied anchor identify this line's start?
 *
 * An empty anchor means "this line is blank". A supplied anchor is accepted as
 * a prefix of the real line, so a shortened copy still matches.
 * @param {string} line - the line without its ending.
 * @param {string} given - the anchor the model sent.
 * @returns {boolean} true when the anchor identifies the line.
 */
export function matchesStart(line, given) {
  const actual = normalizeAnchor(line)
  const want = normalizeAnchor(given)
  if (want.length === 0) return actual.length === 0
  return actual.startsWith(want)
}

/**
 * Does a model-supplied anchor identify this line's end?
 *
 * Lines no longer than one anchor are wholly identified by any equal copy, so
 * they match exactly rather than by suffix.
 * @param {string} line - the line without its ending.
 * @param {string} given - the anchor the model sent.
 * @returns {boolean} true when the anchor identifies the line.
 */
export function matchesEnd(line, given) {
  const actual = normalizeAnchor(line)
  const want = normalizeAnchor(given)
  if (want.length === 0) return actual.length === 0
  if (actual.length <= ANCHOR_CHARS) return actual === want
  return actual.endsWith(want)
}

/** Short, single-line rendering of a line for an error message. */
function preview(line) {
  const text = normalizeAnchor(line)
  if (text.length === 0) return '(blank)'
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`
}

/**
 * Render the model-facing view of a line range.
 *
 * Each line is prefixed with `<number>│` so the model never counts lines
 * itself; the text after the separator is the line as stored, indentation
 * included. No per-line hashes appear here — the whole-file hash covers them.
 * @param {string} content - the text to number.
 * @param {number} [startLine] - absolute number for the first line.
 * @returns {string} numbered text.
 */
export function renderNumbered(content, startLine = 1) {
  return splitKeepEnds(content)
    .map((line, index) => `${startLine + index}${LINE_SEPARATOR}${bareLine(line)}\n`)
    .join('')
}

/** Normalise every line ending in a replacement to the file's own style. */
function normalizeEol(text, eol) {
  const unified = text.replace(/\r\n|[\r\n]/g, '\n')
  return eol === '\n' ? unified : unified.replace(/\n/g, eol)
}

/** Count the lines a replacement text occupies. */
function countLines(text) {
  if (text.length === 0) return 0
  const parts = text.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

/**
 * Apply an anchored line-range replacement.
 *
 * The whole-file hash is checked first: matching it proves the file is exactly
 * the one the model read, so a later anchor mismatch can only mean a wrong line
 * number — which the model can fix without rereading.
 * @param {object} input - the guarded edit request.
 * @param {string} input.content - current file text.
 * @param {string} input.expectedFileHash - `file_hash` the model was shown.
 * @param {number} input.lineStart - 1-based first line to replace.
 * @param {string} input.startAnchor - start anchor of that line.
 * @param {number} input.lineEnd - 1-based last line to replace (inclusive).
 * @param {string} input.endAnchor - end anchor of that line.
 * @param {string} input.replace - replacement text; '' deletes the range.
 * @param {number} [input.totalLines] - `total_lines` from the same read.
 * @returns {{ok: true, content: string, fileHash: string, lineShift: number, removedLines: number}
 *   | {ok: false, code: string, message: string}}
 */
export function applyPatch(input) {
  const { content, expectedFileHash, lineStart, startAnchor, lineEnd, endAnchor, replace, totalLines } = input

  const actualFileHash = fileHash(content)
  if (expectedFileHash !== actualFileHash) {
    return {
      ok: false,
      code: 'FILE_HASH_MISMATCH',
      message: `file_hash mismatch: expected ${expectedFileHash}, actual ${actualFileHash} — the file changed since read_hash; read it again.`,
    }
  }

  const lines = splitKeepEnds(content)
  const total = lines.length
  if (typeof totalLines === 'number' && totalLines !== total) {
    return {
      ok: false,
      code: 'TOTAL_LINES_MISMATCH',
      message: `total_lines mismatch: you passed ${totalLines} but the file has ${total} lines. ` +
        'The file itself is unchanged — fix your line numbers and retry; do not reread the file.',
    }
  }
  if (lineStart < 1 || lineStart > total) {
    return {
      ok: false,
      code: 'RANGE_INVALID',
      message: `line_start ${lineStart} is out of range (file has ${total} lines). ` +
        'The file itself is unchanged — fix the line number and retry; do not reread the file.',
    }
  }
  if (lineEnd < lineStart || lineEnd > total) {
    return {
      ok: false,
      code: 'RANGE_INVALID',
      message: `line_end ${lineEnd} is out of range (line_start ${lineStart}, file has ${total} lines). ` +
        'The file itself is unchanged — fix the line number and retry; do not reread the file.',
    }
  }

  const startLine = bareLine(lines[lineStart - 1])
  if (!matchesStart(startLine, startAnchor)) {
    return {
      ok: false,
      code: 'LINE_ANCHOR_MISMATCH',
      message: `line ${lineStart} does not start with ${JSON.stringify(normalizeAnchor(startAnchor))} — ` +
        `it starts with ${JSON.stringify(preview(startLine))}. The file is unchanged (file_hash matched), ` +
        'so the line number is wrong: fix line_start and retry. Do not reread the file.',
    }
  }

  const endLine = bareLine(lines[lineEnd - 1])
  // A single-line range carries both anchors on one physical line, so either
  // slice identifies it: copying the head twice is not punished.
  const endOk = lineStart === lineEnd
    ? matchesEnd(endLine, endAnchor) || matchesStart(endLine, endAnchor)
    : matchesEnd(endLine, endAnchor)
  if (!endOk) {
    return {
      ok: false,
      code: 'LINE_ANCHOR_MISMATCH',
      message: `line ${lineEnd} does not end with ${JSON.stringify(normalizeAnchor(endAnchor))} — ` +
        `it ends with ${JSON.stringify(preview(endLine))}. The file is unchanged (file_hash matched), ` +
        'so the line number is wrong: fix line_end and retry. Do not reread the file.',
    }
  }

  const eol = detectEol(content)
  const hadTrailingNewline = content.endsWith('\n')
  let body = normalizeEol(replace, eol)
  if (body.length > 0 && !body.endsWith('\n')) body += eol

  const before = lines.slice(0, lineStart - 1)
  const after = lines.slice(lineEnd)
  if (after.length === 0 && !hadTrailingNewline) body = body.replace(/\r?\n$/, '')

  const next = before.join('') + body + after.join('')
  const removedLines = lineEnd - lineStart + 1
  return {
    ok: true,
    content: next,
    fileHash: fileHash(next),
    lineShift: countLines(body) - removedLines,
    removedLines,
  }
}
