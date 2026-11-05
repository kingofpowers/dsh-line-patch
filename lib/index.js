/**
 * dsh-line-patch — anchored file editing for DeepSeek Harness.
 *
 * `read_hash` shows `<number>│<text>` for every line plus one whole-file hash.
 * `patch_hash` replaces a line range only when the file hash and both boundary
 * anchors still match, so a stale read can never silently overwrite newer
 * content. Anchors are plain character slices of the boundary lines, so a model
 * copies them out of what it already read instead of hashing anything.
 *
 * The tools never touch `node:fs`: reads and writes go through `ctx.fs` so the
 * mounted filesystem (sandbox, remote, policy gate) stays authoritative.
 */
import {
  ANCHOR_CHARS,
  FILE_HASH_CHARS,
  applyPatch,
  fileHash,
  renderNumbered,
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

/** Cap on tracked anchors so a read-heavy turn cannot grow the registry without bound. */
const MAX_ANCHORS = 32

const READ_DESCRIPTION = [
  'Read a UTF-8 text file with a whole-file hash and numbered lines.',
  'Every line comes back as `<number>│<text>`; the result also carries `file_hash` and `total_lines`.',
  'Copy the first 16 characters of a boundary line into patch_hash.start_anchor and the last 16 into end_anchor.',
  'Use this instead of read when you intend to modify the file afterwards.',
].join(' ')

const PATCH_DESCRIPTION = [
  'Replace an inclusive line range after verifying the whole file and both boundary lines.',
  'file_hash, start_anchor and end_anchor come from a read_hash result, or from the previous patch new_file_hash:',
  'start_anchor is the first 16 characters of line_start, end_anchor the last 16 of line_end (surrounding whitespace is ignored).',
  'Optional total_lines (the `of N` total in the read header) cross-checks the line numbers.',
  'replace is the new text; pass an empty string to delete the range.',
  'If file_hash matches but an anchor does not, fix the anchor or the line number and retry without rereading the file.',
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

/**
 * Record the model-facing anchor so later turns can revalidate it.
 * @param {object} registry - the plugin's anchor registry.
 * @param {object} entry - anchor facts.
 */
function rememberAnchor(registry, entry) {
  const key = entry.targetKey ?? entry.path
  registry.anchors.set(key, entry)
  registry.order.push(key)
  while (registry.order.length > MAX_ANCHORS) {
    const dropped = registry.order.shift()
    if (dropped !== undefined && dropped !== key) registry.anchors.delete(dropped)
  }
}

/**
 * Replace the tool result that carried a now-void anchor with a notice.
 *
 * The surface is append-only, so "editing history" means appending a
 * replacement event that shadows the original sequence.
 * @param {object} registry - the plugin's anchor registry.
 * @param {object} anchor - the anchor whose read result is stale.
 * @param {string} freshHash - the file hash as it is now.
 */
function replaceStaleRead(registry, anchor, freshHash) {
  const session = anchor.session ?? registry.session
  if (!session || typeof session.append !== 'function' || typeof anchor.seq !== 'number') return
  const event = session.eventAt?.(anchor.seq)
  const data = event?.data
  if (!data || !data.message) return
  const text = `[line-patch] ${anchor.displayPath} was modified after it was read ` +
    `(file_hash ${anchor.fileHash} -> ${freshHash}). The content and line numbers above are void; ` +
    'call read_hash again before patching.'
  try {
    session.append(
      'tool/result',
      { ...data, message: { ...data.message, content: [{ type: 'text', text }] } },
      { surfaceOp: { op: 'replace', startSeq: anchor.seq, endSeq: anchor.seq }, sourceEventSeqs: [anchor.seq] },
    )
  } catch {
    // A already-shadowed or foreign sequence is not ours to rewrite; the patch-time hashes still protect.
  }
}

/**
 * Re-check every live anchor against the file it came from.
 *
 * `stat` is the cheap prefilter: an unchanged stat version means nothing moved
 * and no read happens. A changed version then splits into the two cases that
 * matter — same content (refresh bookkeeping, keep the model's anchors) and
 * different content (void the old result).
 * @param {object} ctx - the plugin context.
 * @param {object} registry - the plugin's anchor registry.
 * @param {object} actor - the request's step context, used as the observation owner.
 */
async function revalidateAnchors(ctx, registry, actor) {
  const fs = ctx?.fs
  if (!fs || registry.anchors.size === 0) return
  for (const [key, anchor] of [...registry.anchors]) {
    if (registry.turn - anchor.turn > ANCHOR_TURNS) {
      registry.anchors.delete(key)
      continue
    }
    const target = anchor.target ?? { targetKey: key, displayPath: anchor.displayPath }
    let info
    try {
      info = await fs.stat(target)
    } catch {
      continue
    }
    if (!info) {
      registry.anchors.delete(key)
      continue
    }
    if (info.version === anchor.version) continue
    let content
    try {
      content = await fs.readText(target)
    } catch {
      continue
    }
    const fresh = fileHash(content)
    if (fresh === anchor.fileHash) {
      // Byte-identical: a rebuild or a touch moved the stat, not the content.
      anchor.version = info.version
      try {
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, actor)
      } catch {
        // no observation gate mounted
      }
      continue
    }
    replaceStaleRead(registry, anchor, fresh)
    registry.anchors.delete(key)
  }
}

/**
 * Register both tools plus the anchor bookkeeping on a plugin context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const registry = { anchors: new Map(), order: [], turn: 0, session: undefined }

  /** Record an observation so `fs/write-intent` sees this file as read. */
  const observe = (target, version, actor) => {
    try {
      ctx.emit('fs/observed', target, { kind: 'present', version }, actor)
    } catch {
      // The gate is optional; a bare provider simply has no listener.
    }
  }

  // A tool-mediated write refreshes its own observation, so the anchor it
  // invalidates must not later read back as an "external" change.
  try {
    ctx.on('fs/observed', (target, observation) => {
      if (!target || observation?.kind !== 'present') return
      const anchor = registry.anchors.get(target.targetKey)
      if (anchor && anchor.version !== observation.version) registry.anchors.delete(target.targetKey)
    })
  } catch {
    // Hosts without the observation gate simply skip this bookkeeping.
  }

  // One session/event listener carries three facts the revalidation needs: the
  // live session, the user-turn counter, and the sequence of our own results.
  try {
    ctx.on('session/event', (session, event) => {
      if (session) registry.session = session
      if (!event) return
      if (event.type === 'turn/start') {
        registry.turn += 1
        return
      }
      if (event.type !== 'tool/result') return
      const callId = event.data?.message?.toolCallId
      if (typeof callId !== 'string') return
      for (const anchor of registry.anchors.values()) {
        if (anchor.callId === callId && typeof anchor.seq !== 'number') {
          anchor.seq = event.seq
          anchor.session = session
        }
      }
    })
  } catch {
    // A host without session events still gets working tools; anchors just never expire by age.
  }

  // `agent/request` runs with an open step and before the model call: the one
  // place where a surface replacement is legal and still useful.
  try {
    ctx.on('agent/request', (...args) => {
      const next = typeof args.at(-1) === 'function' ? args.at(-1) : undefined
      const stepContext = args[0]
      const settled = revalidateAnchors(ctx, registry, stepContext).catch(() => {})
      return next ? settled.then(() => next()) : settled
    })
  } catch {
    // Without the hook, anchors are only checked at patch time.
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
          offset: { type: 'integer', required: true },
          line_count: { type: 'integer', required: true },
          total_lines: { type: 'integer', required: true },
          content: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.total_lines === 0
          ? `file_hash: ${value.file_hash}\nfile is empty (0 lines)`
          : `file_hash: ${value.file_hash}\n` +
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
        target,
        session: registry.session,
        callId: exec?.callId,
      })
      return {
        path: fs.processPath ? fs.processPath(target) : String(args.file_path),
        file_hash: fileHash(content),
        offset,
        line_count: Math.max(0, end - offset + 1),
        total_lines: total,
        content: renderNumbered(window, offset),
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
      start_anchor: { type: 'string', required: true, description: `First ${ANCHOR_CHARS} characters of line_start, without its indentation.` },
      line_end: { type: 'number', required: true, description: '1-based last line to replace, inclusive. Equal to line_start for one line.' },
      end_anchor: { type: 'string', required: true, description: `Last ${ANCHOR_CHARS} characters of line_end, without trailing whitespace.` },
      replace: { type: 'string', required: true, description: 'Replacement text. An empty string deletes the range.' },
      total_lines: { type: 'number', description: 'Optional `of N` total from the read header; rejects a wrong line number early.' },
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
        lineStart: args.line_start,
        startAnchor: args.start_anchor,
        lineEnd: args.line_end,
        endAnchor: args.end_anchor,
        replace: args.replace,
        totalLines: args.total_lines,
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
        target,
        // No callId: a patch result is never rewritten, it is only bookkeeping.
      })

      return {
        path: fs.processPath ? fs.processPath(target) : String(args.file_path),
        replaced: [args.line_start, args.line_end],
        line_shift: result.lineShift,
        new_file_hash: result.fileHash,
      }
    },
  }))
}
