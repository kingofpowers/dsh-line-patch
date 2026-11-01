/**
 * dsh-line-patch — pure anchoring logic.
 *
 * No I/O and no host API lives here: every function takes text in and returns
 * text out, so the whole editing contract is unit-testable without a Harness.
 */
import { createHash } from 'node:crypto'

/** Characters kept from a line's md5 — enough to spot a changed boundary line. */
export const LINE_HASH_CHARS = 4

/** Characters kept from the whole-file sha256 — enough to spot a changed file. */
export const FILE_HASH_CHARS = 16

/** Fixed hash a blank line carries, so every line has an anchor. */
export const EMPTY_LINE_HASH = lineHashOf('')

function lineHashOf(text) {
  return createHash('md5').update(text, 'utf8').digest('hex').slice(0, LINE_HASH_CHARS)
}

/**
 * The anchor shown next to one line.
 * @param {string} text - the line with its line ending already stripped.
 * @returns {string} a stable 4-character hash.
 */
export function lineHash(text) {
  return lineHashOf(text)
}

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

/** Strip a line's ending terms before hashing it. */
function bareLine(line) {
  return line.replace(/[\r\n]+$/, '')
}

/**
 * Render the model-facing view of a line range.
 *
 * Each line is prefixed with `<number>/<hash>: ` so the model never counts
 * lines itself and can copy the hash straight into `patch_hash`.
 * @param {string} content - the text to annotate.
 * @param {number} [startLine] - absolute number for the first line.
 * @returns {string} annotated text.
 */
export function annotateLines(content, startLine = 1) {
  const lines = splitKeepEnds(content)
  return lines
    .map((line, index) => {
      const text = bareLine(line)
      const hash = text.length === 0 ? EMPTY_LINE_HASH : lineHash(text)
      return `${startLine + index}/${hash}: ${text}\n`
    })
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
 * All three anchors are checked before anything is written, and the returned
 * text is the complete new file: callers never splice in place themselves.
 * @param {object} input - the guarded edit request.
 * @param {string} input.content - current file text.
 * @param {string} input.expectedFileHash - `file_hash` the model was shown.
 * @param {number} input.lineStart - 1-based first line to replace.
 * @param {string} input.hashStart - hash of that line.
 * @param {number} input.lineEnd - 1-based last line to replace (inclusive).
 * @param {string} input.hashEnd - hash of that line.
 * @param {string} input.replace - replacement text; '' deletes the range.
 * @returns {{ok: true, content: string, fileHash: string, lineShift: number, removedLines: number}
 *   | {ok: false, code: string, message: string}}
 */
export function applyPatch(input) {
  const { content, expectedFileHash, lineStart, hashStart, lineEnd, hashEnd, replace } = input

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
  if (lineStart < 1 || lineStart > total) {
    return {
      ok: false,
      code: 'RANGE_INVALID',
      message: `line_start ${lineStart} is out of range (file has ${total} lines).`,
    }
  }
  if (lineEnd < lineStart || lineEnd > total) {
    return {
      ok: false,
      code: 'RANGE_INVALID',
      message: `line_end ${lineEnd} is out of range (line_start ${lineStart}, file has ${total} lines).`,
    }
  }

  const startActual = lineHash(bareLine(lines[lineStart - 1]))
  if (startActual !== hashStart) {
    return {
      ok: false,
      code: 'LINE_HASH_MISMATCH',
      message: `line ${lineStart} hash mismatch: expected ${hashStart}, actual ${startActual} — the line numbers shifted; read the file again.`,
    }
  }
  const endActual = lineHash(bareLine(lines[lineEnd - 1]))
  if (endActual !== hashEnd) {
    return {
      ok: false,
      code: 'LINE_HASH_MISMATCH',
      message: `line ${lineEnd} hash mismatch: expected ${hashEnd}, actual ${endActual} — the line numbers shifted; read the file again.`,
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
