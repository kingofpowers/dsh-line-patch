/**
 * dsh-line-patch — anchored file editing for DeepSeek Harness.
 *
 * `read_hash` shows every line as `<number>/<hash>: <text>` plus a whole-file
 * hash. `patch_hash` replaces a line range only when the file hash and both
 * boundary-line hashes still match, so a stale read can never silently
 * overwrite newer content.
 *
 * The tools never touch `node:fs`: reads and writes go through `ctx.fs` so the
 * mounted filesystem (sandbox, remote, policy gate) stays authoritative.
 */
import {
  LINE_HASH_CHARS,
  FILE_HASH_CHARS,
  annotateLines,
  applyPatch,
  fileHash,
  splitKeepEnds,
} from './core.js'

/** Plugin name used by loader diagnostics. */
export const name = 'line-patch'

/**
 * `defineTool` types and validates arguments in the host. When the package is
 * absent — a plain `node --test` checkout — the identity fallback keeps the
 * module loadable so the pure logic and tool glue stay testable offline.
 */
const { defineTool } = await import('@deepseek-ai/dsh-tools')
  .catch(() => {
    console.warn('[line-patch] @deepseek-ai/dsh-tools not resolvable; running without argument validation')
    return { defineTool: definition => definition }
  })

/** The tool registry and the filesystem service must be ready before either tool registers. */
export const inject = ['tools', 'fs']

/** Largest file this plugin will read or rewrite in one call. */
const MAX_FILE_BYTES = 5 * 1024 * 1024

/** Default and maximum lines one `read_hash` call returns. */
const DEFAULT_READ_LIMIT = 2000

/** How many user turns an anchor stays eligible for revalidation. */
const ANCHOR_TURNS = 3

const READ_DESCRIPTION = [
  'Read a UTF-8 text file with per-line and whole-file hashes.',
  'Every line comes back as `<number>/<hash>: <text>`; the result also carries `file_hash`.',
  'Copy those values into patch_hash — they are the only anchors it accepts.',
  'Use this instead of read when you intend to modify the file afterwards.',
].join(' ')

const PATCH_DESCRIPTION = [
  'Replace an inclusive line range after verifying the whole file and both boundary lines.',
  'file_hash, hash_start and hash_end are all required and must come from a read_hash result.',
  'replace is the new text; pass an empty string to delete the range.',
  'Cheaper than edit for large rewrites: you send line numbers instead of quoting the old text.',
].join(' ')

/**
 * Resolve the filesystem service or explain why the tool cannot run.
 * @param {object} ctx - the plugin context.
 * @returns {object} the `ctx.fs` service.
 */
function requireFs(ctx) {
  const fs = ctx?.fs
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') {
    throw new Error('line-patch requires the ctx.fs service; mount @deepseek-ai/dsh-fs-local (or another provider).')
  }
  return fs
}

/**
 * Read a file that fits the plugin's single-call budget.
 * @param {object} ctx - the plugin context.
 * @param {string} filePath - model-supplied path.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{target: object, content: string, version: string, size: number}>} the read result.
 */
async function readWholeFile(ctx, filePath, signal) {
  const fs = requireFs(ctx)
  const target = await fs.resolve(filePath, { signal })
  const info = await fs.stat(target, signal)
  if (!info) throw new Error(`file not found: ${filePath}`)
  if (info.type !== 'file') throw new Error(`not a regular file: ${filePath}`)
  if (typeof info.size === 'number' && info.size > MAX_FILE_BYTES) {
    throw new Error(`file is larger than the ${MAX_FILE_BYTES} byte limit: ${filePath}`)
  }
  const content = await fs.readText(target, signal)
  return { target, content, version: info.version, size: info.size ?? content.length }
}

/** Wrap a numeric line count into the canonical `total_lines` value. */
function totalLinesOf(content) {
  return splitKeepEnds(content).length
}

/**
 * Record the model-facing anchor so later turns can revalidate it.
 * @param {object} registry - the plugin's anchor registry.
 * @param {object} entry - anchor facts.
 */
function rememberAnchor(registry, entry) {
  registry.anchors.set(entry.targetKey ?? entry.path, entry)
  registry.order.push(entry.targetKey ?? entry.path)
  while (registry.order.length > 64) {
    const dropped = registry.order.shift()
    if (dropped !== undefined) registry.anchors.delete(dropped)
  }
}

/**
 * Register both tools plus the anchor bookkeeping on a plugin context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const registry = { anchors: new Map(), order: [], turn: 0 }

  // Turn counter: one `turn/start` per user turn, which is the window anchors live in.
  try {
    ctx.on('session/event', (_session, event) => {
      if (event?.type === 'turn/start') registry.turn += 1
    })
  } catch {
    // A host without session events still gets working tools; anchors just never expire by age.
  }

  /** Record an observation so `fs/write-intent` sees this file as read. */
  const observe = (target, version, exec) => {
    try {
      ctx.emit('fs/observed', target, { kind: 'present', version }, exec)
    } catch {
      // The gate is optional; a bare provider simply has no listener.
    }
  }

  ctx.tools.register(defineTool({
    name: 'read_hash',
    description: READ_DESCRIPTION,
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to show. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum lines to show. Defaults to and is capped at ${DEFAULT_READ_LIMIT}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          file_hash: { type: 'string', required: true },
          line_hash_chars: { type: 'integer', required: true },
          offset: { type: 'integer', required: true },
          line_count: { type: 'integer', required: true },
          total_lines: { type: 'integer', required: true },
          content: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `file_hash: ${value.file_hash}\n` +
          `lines ${value.offset}-${value.offset + value.line_count - 1} of ${value.total_lines}\n` +
          `${value.content}` +
          (value.truncated ? `\n... [showing ${value.line_count} lines; narrow the range with offset/limit]` : ''),
      }],
    },
    async execute(args, exec) {
      const fs = requireFs(ctx)
      const offset = Math.max(1, Math.trunc(args.offset ?? 1))
      const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? DEFAULT_READ_LIMIT)), DEFAULT_READ_LIMIT)
      const { target, content, version } = await readWholeFile(ctx, args.file_path, exec.signal)
      const all = splitKeepEnds(content)
      const total = all.length
      const end = Math.min(total, offset + limit - 1)
      const window = end >= offset ? all.slice(offset - 1, end).join('') : ''
      observe(target, version, exec)
      rememberAnchor(registry, {
        path: fs.processPath ? fs.processPath(target) : String(args.file_path),
        targetKey: target.targetKey ?? target.key ?? String(args.file_path),
        displayPath: String(args.file_path),
        fileHash: fileHash(content),
        version,
        turn: registry.turn,
      })
      return {
        path: fs.processPath ? fs.processPath(target) : String(args.file_path),
        file_hash: fileHash(content),
        line_hash_chars: LINE_HASH_CHARS,
        offset,
        line_count: Math.max(0, end - offset + 1),
        total_lines: total,
        content: annotateLines(window, offset),
        truncated: end < total,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'patch_hash',
    description: PATCH_DESCRIPTION,
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
      file_hash: { type: 'string', required: true, description: `Whole-file hash from read_hash (${FILE_HASH_CHARS} hex chars).` },
      line_start: { type: 'number', required: true, description: '1-based first line to replace.' },
      hash_start: { type: 'string', required: true, description: `Hash of line_start as shown by read_hash (${LINE_HASH_CHARS} hex chars).` },
      line_end: { type: 'number', required: true, description: '1-based last line to replace, inclusive. Equal to line_start for one line.' },
      hash_end: { type: 'string', required: true, description: `Hash of line_end as shown by read_hash (${LINE_HASH_CHARS} hex chars).` },
      replace: { type: 'string', required: true, description: 'Replacement text. An empty string deletes the range.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          replaced: { type: 'array', required: true, items: { type: 'number' } },
          line_shift: { type: 'integer', required: true },
          new_file_hash: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `patched ${value.path}: lines ${value.replaced[0]}-${value.replaced[1]} replaced ` +
          `(line shift ${value.line_shift >= 0 ? '+' : ''}${value.line_shift}). ` +
          `new file_hash: ${value.new_file_hash}`,
      }],
      presentationMeta: (args, value) => ({ replaced: value.replaced, path: value.path }),
    },
    async execute(args, exec) {
      const fs = requireFs(ctx)
      const { target, content, version } = await readWholeFile(ctx, args.file_path, exec.signal)
      const result = applyPatch({
        content,
        expectedFileHash: args.file_hash,
        lineStart: Math.trunc(args.line_start),
        hashStart: args.hash_start,
        lineEnd: Math.trunc(args.line_end),
        hashEnd: args.hash_end,
        replace: args.replace,
      })
      if (!result.ok) {
        const error = new Error(result.message)
        error.code = result.code
        throw error
      }

      // Mirror the built-in write tool: ask the policy gate for the intent, then
      // hand it to the provider so the version CAS (and read-before-write) apply.
      const fallback = { kind: 'replaceIfVersion', version }
      let intent = fallback
      try {
        const decided = await ctx.waterfall('fs/write-intent', target, exec, () => fallback)
        if (decided) intent = decided
      } catch {
        intent = fallback
      }

      const outcome = await fs.writeText(target, result.content, intent, exec.signal)
      observe(target, outcome?.version ?? version, exec)

      rememberAnchor(registry, {
        path: fs.processPath ? fs.processPath(target) : String(args.file_path),
        targetKey: target.targetKey ?? target.key ?? String(args.file_path),
        displayPath: String(args.file_path),
        fileHash: result.fileHash,
        version: outcome?.version ?? version,
        turn: registry.turn,
      })

      return {
        path: fs.processPath ? fs.processPath(target) : String(args.file_path),
        replaced: [Math.trunc(args.line_start), Math.trunc(args.line_end)],
        line_shift: result.lineShift,
        new_file_hash: result.fileHash,
      }
    },
  }))

  // Anchor revalidation lands here once the host hook shape is verified; see README.
  registry.anchorTurns = ANCHOR_TURNS
}
