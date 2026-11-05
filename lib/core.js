/**
 * dsh-line-patch — pure anchoring logic.
 *
 * No I/O and no host API lives here: every function takes text in and returns
 * text out, so the whole editing contract is unit-testable without a Harness.
 *
 * The anchors a model copies are *content* slices, not hashes: the first and
 * last characters of the boundary lines are visible in a normal read, so
 * nothing has to be recomputed to write them back.
 */
import { createHash } from 'node:crypto'

/** Characters kept from a boundary line — enough to identify it, cheap to copy. */
export const ANCHOR_CHARS = 16

/** Characters kept from the whole-file sha256 — enough to spot a changed file. */
export const FILE_HASH_CHARS = 6

/**
 * The hash shown underneath a read/write/edit result.
 * @param {string|Buffer} content - raw file content.
 * @returns {string} a 6-character sha256 prefix.
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
 * Reduce an anchor or a line to a canonical comparison form.
 *
 * Indentation drops away, runs of whitespace collapse to one space, and the
 * ends are trimmed, so a model may copy an anchor with or without the layout
 * whitespace around the code.
 * @param {unknown} text - an anchor candidate or a real line.
 * @returns {string} whitespace-collapsed text.
 */
export function normalizeAnchor(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Canonical form that keeps the line's own indentation.
 *
 * A model that copies the indentation it was shown gets a stricter comparison:
 * `if (err) {` and `    if (err) {` are different lines, which is exactly the
 * pair that a nesting mistake confuses. Inner whitespace still collapses.
 * @param {unknown} text - an anchor candidate or a real line.
 * @returns {string} indentation-preserving text.
 */
export function normalizeIndented(text) {
  const raw = String(text ?? '')
  const lead = raw.match(/^\s+/)?.[0] ?? ''
  const rest = raw.slice(lead.length).replace(/\s+/g, ' ')
  return `${lead}${rest}`.replace(/\s+$/, '')
}

/** Anchors that start with whitespace are compared with indentation kept. */
function keepsIndent(given) {
  return /^\s/.test(String(given ?? ''))
}

/**
 * The anchor a line offers at its start: its first `ANCHOR_CHARS` characters.
 *
 * Whitespace is collapsed and the leading indentation dropped, so this is the
 * *shortest* anchor the contract accepts — a model that copies the read display
 * including indentation sends a stricter (indented) one. Used for error text and
 * for generating anchors in tests, never for matching.
 * @param {string} line - the line without its ending.
 * @returns {string} the start anchor.
 */
export function startAnchorOf(line) {
  return normalizeAnchor(line).slice(0, ANCHOR_CHARS)
}

/**
 * The anchor a line offers at its end: its last `ANCHOR_CHARS` characters.
 *
 * Whitespace is collapsed the same way; the whitespace itself is not part of a
 * comparable end anchor.
 * @param {string} line - the line without its ending.
 * @returns {string} the end anchor.
 */
export function endAnchorOf(line) {
  return normalizeAnchor(line).slice(-ANCHOR_CHARS)
}

/**
 * Does a model-supplied anchor identify this line's start?
 *
 * An empty anchor means "this line is blank". A start anchor is a slice of the
 * line's first characters, so leading whitespace in it *is* the indentation:
 * when the model carries it, the comparison keeps indentation and `if (err) {`
 * stops matching `    if (err) {`. A copy without the indentation still matches
 * the collapsed form — the length contract is enforced by `applyPatch`.
 * @param {string} line - the line without its ending.
 * @param {string} given - the anchor the model sent.
 * @returns {boolean} true when the anchor identifies the line.
 */
export function matchesStart(line, given) {
  const strict = keepsIndent(given)
  const actual = strict ? normalizeIndented(line) : normalizeAnchor(line)
  const want = strict ? normalizeIndented(given) : normalizeAnchor(given)
  if (want.length === 0) return actual.length === 0
  return actual.startsWith(want)
}

/**
 * Does a model-supplied anchor identify this line's end?
 *
 * An end anchor is a slice of the line's *last* characters, so whitespace at
 * its edge is content, not indentation; both sides are compared collapsed.
 * @param {string} line - the line without its ending.
 * @param {string} given - the anchor the model sent.
 * @returns {boolean} true when the anchor identifies the line.
 */
export function matchesEnd(line, given) {
  const actual = normalizeAnchor(line)
  const want = normalizeAnchor(given)
  if (want.length === 0) return actual.length === 0
  return actual.endsWith(want)
}

/**
 * Is the anchor as long as the contract requires?
 *
 * The model is told to copy a whole anchor (16 characters, or the whole line
 * when it is shorter). A shorter copy still identifies a line by prefix, which
 * would quietly turn a 16-character check into a two-character one.
 * @param {string} line - the line the anchor should identify.
 * @param {string} given - the anchor the model sent.
 * @returns {boolean} true when the anchor is shorter than the contract allows.
 */
export function anchorTooShort(line, given) {
  const raw = String(given ?? '')
  if (raw.length >= ANCHOR_CHARS) return false
  if (normalizeAnchor(given).length === 0) return false
  return normalizeAnchor(given) !== normalizeAnchor(line)
}

/** Render an anchor for an error message, naming the blank case. */
function shown(anchor) {
  return anchor.length === 0 ? '(blank)' : JSON.stringify(anchor)
}

/** Longest suggestion an ambiguity message will print. */
const SUGGESTION_CHARS = 80

/** Every 1-based line number whose text matches the anchor on that boundary. */
function matchingLines(lines, given, boundary) {
  const found = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = bareLine(lines[index])
    const matched = boundary === 'start' ? matchesStart(line, given) : matchesEnd(line, given)
    if (matched) found.push(index + 1)
  }
  return found
}

/** Render a short line-number list for an error message. */
function describeLines(numbers) {
  const head = numbers.slice(0, 8).join(', ')
  return numbers.length > 8 ? `lines ${head}, …` : `lines ${head}`
}

/**
 * Would this anchor silently point at more than one line, and can widening fix it?
 *
 * Two lines sharing their first (or last) 16 characters are indistinguishable
 * from those two slices alone; if the line is longer, the model can copy more
 * of it and be exact, so that is worth one corrective turn. When even the whole
 * line repeats, no anchor can disambiguate it — the line number is the only
 * signal, and rejecting would block edits that are in fact unambiguous.
 * @param {string[]} lines - the file's lines, endings included.
 * @param {number} lineNumber - the line the model named.
 * @param {string} given - the anchor the model sent.
 * @param {'start'|'end'} boundary - which end of the line the anchor covers.
 * @returns {{matches: number[], suggestion: string}|null} the ambiguity, or null.
 */
function ambiguousAnchor(lines, lineNumber, given, boundary) {
  const matches = matchingLines(lines, given, boundary)
  if (matches.length <= 1) return null
  const full = normalizeAnchor(bareLine(lines[lineNumber - 1]))
  if (full.length <= normalizeAnchor(given).length) return null
  // If the whole line text repeats too, every anchor is ambiguous; allow it.
  if (matchingLines(lines, full, boundary).length > 1) return null
  const suggestion = full.length <= SUGGESTION_CHARS
    ? full
    : boundary === 'start' ? full.slice(0, SUGGESTION_CHARS) : full.slice(-SUGGESTION_CHARS)
  return { matches, suggestion }
}

/** A non-empty anchor that carries no characters at all. */
function isWhitespaceOnly(anchor) {
  const raw = String(anchor ?? '')
  return raw.length > 0 && raw.trim().length === 0
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

/** Reject an argument the tool cannot act on, instead of throwing later. */
function badArgument(message) {
  return { ok: false, code: 'BAD_ARGUMENT', message }
}

/**
 * Apply an anchored line-range replacement.
 *
 * The whole-file hash is checked first: matching it proves the file is exactly
 * the one the model read, so a later anchor mismatch cannot be a stale read —
 * the model fixes the anchor or the line number without rereading.
 * @param {object} input - the guarded edit request.
 * @param {string} input.content - current file text.
 * @param {string} input.expectedFileHash - `file_hash` the model was shown.
 * @param {number} input.lineStart - 1-based first line to replace.
 * @param {string} input.startAnchor - start anchor of that line.
 * @param {number} input.lineEnd - 1-based last line to replace (inclusive).
 * @param {string} input.endAnchor - end anchor of that line.
 * @param {string} input.replace - replacement text; '' deletes the range.
 * @returns {{ok: true, content: string, fileHash: string, lineShift: number, removedLines: number}
 *   | {ok: false, code: string, message: string}}
 */
export function applyPatch(input) {
  const { content, expectedFileHash, lineStart, startAnchor, lineEnd, endAnchor, replace } = input

  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) {
    return badArgument(
      `line_start and line_end must be whole line numbers (got ${String(lineStart)} and ${String(lineEnd)}).`,
    )
  }
  if (typeof replace !== 'string') {
    return badArgument(`replace must be a string (got ${typeof replace}); pass "" to delete the range.`)
  }
  // A hash of the wrong shape is a different mistake from a stale file: saying
  // "the file changed" would send the model to reread for nothing.
  if (typeof expectedFileHash !== 'string' || !new RegExp(`^[0-9a-f]{${FILE_HASH_CHARS}}$`).test(expectedFileHash)) {
    return badArgument(
      `file_hash must be the ${FILE_HASH_CHARS}-character lowercase hex hash printed on the line under a read/write/edit result ` +
      `(got ${JSON.stringify(expectedFileHash)}). If you were never shown such a line, this plugin's annotation is not active — use edit or write instead.`,
    )
  }

  const actualFileHash = fileHash(content)
  if (expectedFileHash !== actualFileHash) {
    return {
      ok: false,
      code: 'FILE_HASH_MISMATCH',
      message: `file_hash mismatch: expected ${expectedFileHash}, actual ${actualFileHash} — the file changed since it was read; read it again.`,
    }
  }

  const lines = splitKeepEnds(content)
  const total = lines.length
  if (total === 0) {
    return {
      ok: false,
      code: 'RANGE_INVALID',
      message: 'the file is empty, so there is no line to patch — use the write tool to add content instead.',
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
  const startWant = normalizeAnchor(startAnchor)
  if (isWhitespaceOnly(startAnchor)) {
    const blankLine = normalizeAnchor(startLine).length === 0
    return {
      ok: false,
      code: 'ANCHOR_TOO_SHORT',
      message: blankLine
        ? `start_anchor is only whitespace and line ${lineStart} is blank — pass "" to address a blank line. Do not reread the file.`
        : `start_anchor is only whitespace — line ${lineStart} is indented past ${ANCHOR_CHARS} characters. ` +
          `Copy ${ANCHOR_CHARS} characters starting at its first non-blank character (or the whole line). Do not reread the file.`,
    }
  }
  if (anchorTooShort(startLine, startAnchor)) {
    return {
      ok: false,
      code: 'ANCHOR_TOO_SHORT',
      message: `start_anchor ${shown(startWant)} is too short to identify a line — copy the first ${ANCHOR_CHARS} ` +
        `characters of line ${lineStart} from the read result (the whole line when it is shorter). Do not reread the file.`,
    }
  }
  if (!matchesStart(startLine, startAnchor)) {
    return {
      ok: false,
      code: 'LINE_ANCHOR_MISMATCH',
      message: `start_anchor ${shown(String(startAnchor ?? ''))} does not match line ${lineStart}, ` +
        `which starts with ${shown(startLine.slice(0, ANCHOR_CHARS))}. ` +
        'Copy it exactly, including the indentation; then fix start_anchor or line_start and retry — ' +
        'do not reread the file (file_hash still matches).',
    }
  }
  const startAmbiguity = ambiguousAnchor(lines, lineStart, startAnchor, 'start')
  if (startAmbiguity) {
    return {
      ok: false,
      code: 'ANCHOR_AMBIGUOUS',
      message: `start_anchor ${shown(startWant)} matches ${describeLines(startAmbiguity.matches)} — ` +
        `line ${lineStart} is longer than ${ANCHOR_CHARS} characters, so copy more of it, ` +
        `for example ${JSON.stringify(startAmbiguity.suggestion)}. Do not reread the file (file_hash still matches).`,
    }
  }

  const endLine = bareLine(lines[lineEnd - 1])
  const endWant = normalizeAnchor(endAnchor)
  if (isWhitespaceOnly(endAnchor)) {
    const blankLine = normalizeAnchor(endLine).length === 0
    return {
      ok: false,
      code: 'ANCHOR_TOO_SHORT',
      message: blankLine
        ? `end_anchor is only whitespace and line ${lineEnd} is blank — pass "" to address a blank line. Do not reread the file.`
        : `end_anchor is only whitespace — line ${lineEnd} is padded with trailing whitespace. ` +
          `Copy the last ${ANCHOR_CHARS} characters before that padding (or the whole line). Do not reread the file.`,
    }
  }
  if (anchorTooShort(endLine, endAnchor)) {
    return {
      ok: false,
      code: 'ANCHOR_TOO_SHORT',
      message: `end_anchor ${shown(endWant)} is too short to identify a line — copy the last ${ANCHOR_CHARS} ` +
        `characters of line ${lineEnd} from the read result (the whole line when it is shorter). Do not reread the file.`,
    }
  }
  // A single-line range carries both anchors on one physical line, so a model
  // that copied the head into both slots is right, not wrong.
  const endOk = lineStart === lineEnd
    ? matchesEnd(endLine, endAnchor) || matchesStart(endLine, endAnchor)
    : matchesEnd(endLine, endAnchor)
  if (!endOk) {
    return {
      ok: false,
      code: 'LINE_ANCHOR_MISMATCH',
      message: `end_anchor ${shown(String(endAnchor ?? ''))} does not match line ${lineEnd}, ` +
        `which ends with ${shown(endAnchorOf(endLine))}. ` +
        'Fix end_anchor or line_end and retry; do not reread the file (file_hash still matches).',
    }
  }
  const endAmbiguity = ambiguousAnchor(lines, lineEnd, endAnchor, 'end')
  if (endAmbiguity) {
    return {
      ok: false,
      code: 'ANCHOR_AMBIGUOUS',
      message: `end_anchor ${shown(endWant)} matches ${describeLines(endAmbiguity.matches)} — ` +
        `line ${lineEnd} is longer than ${ANCHOR_CHARS} characters, so copy more of it, ` +
        `for example ${JSON.stringify(endAmbiguity.suggestion)}. Do not reread the file (file_hash still matches).`,
    }
  }

  const eol = detectEol(content)
  const hadTrailingNewline = content.endsWith('\n')
  let body = normalizeEol(replace, eol)
  if (body.length > 0 && !body.endsWith('\n')) body += eol

  const before = lines.slice(0, lineStart - 1)
  const after = lines.slice(lineEnd)
  if (after.length === 0 && !hadTrailingNewline) {
    // Keep the "no trailing newline" shape, but never strip away the only line
    // a `replace` of just a line terminator asked to insert.
    const stripped = body.replace(/\r?\n$/, '')
    if (stripped.length > 0 && countLines(stripped) === countLines(body)) body = stripped
  }

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
