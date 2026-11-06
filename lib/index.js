/**
 * dsh-line-patch — anchored file editing for DeepSeek Harness.
 *
 * The plugin adds no read tool. Instead every `read`, `write` and `edit`
 * result is annotated with a short `file_hash` line, and one new `patch` tool
 * replaces a line range only when that hash and both boundary anchors still
 * match. A model therefore keeps using the filesystem tools it already knows.
 *
 * Nothing here touches `node:fs`: reads and writes go through `ctx.fs` so the
 * mounted filesystem (sandbox, remote, policy gate) stays authoritative.
 */
import { randomUUID } from 'node:crypto'
import { ANCHOR_CHARS, FILE_HASH_CHARS, applyPatch, fileHash } from './core.js'

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

/**
 * `createUserMessage` stamps the identity the host expects on a message the
 * plugin injects. Offline — and on hosts that do not export it — a plain
 * user-role object is enough; the shape only has to survive the pre-step merge.
 */
const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  .catch(() => ({
    createUserMessage: input => ({ id: randomUUID(), role: 'user', ...input }),
  }))

/** The tool registry and the filesystem service must be ready before `patch` registers. */
export const inject = ['tools', 'fs']

/** Built-in tools whose result carries the file hash. */
const ANNOTATED_TOOLS = new Set(['read', 'write', 'edit'])

/** Largest file this plugin will read to compute a hash. */
const MAX_FILE_BYTES = 5 * 1024 * 1024

/** How many user turns an anchor stays eligible for revalidation. */
const ANCHOR_TURNS = 3

/** Cap on tracked anchors so a read-heavy turn cannot grow the registry without bound. */
const MAX_ANCHORS = 32

const PATCH_DESCRIPTION = [
  'Replace an inclusive line range after verifying the whole file and both boundary lines.',
  `file_hash is the ${FILE_HASH_CHARS}-character hash printed under the most recent read/write/edit result for this file, or under a previous patch result.`,
  `start_anchor is the first ${ANCHOR_CHARS} characters of line_start's text — the part after the "N: " prefix a read result prints — and end_anchor the last ${ANCHOR_CHARS} characters of line_end's text. Use the whole line text when it is shorter than ${ANCHOR_CHARS}; never include the "N: " prefix.`,
  'Keep the indentation in start_anchor: one that carries it is compared strictly, which separates nested lines that look alike. Whitespace at either edge is otherwise collapsed.',
  'replace is the new text; pass an empty string to delete the range.',
  'If file_hash matches but an anchor does not, fix the anchor or the line number and retry without rereading the file.',
  'If no read/write/edit result showed a file_hash line (a >5 MB file, or run_code/PTC mode where tool text is not visible), this tool cannot be used — fall back to edit or write.',
].join(' ')

/**
 * Resolve the filesystem service or explain why the plugin cannot run.
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
 * The working directory the tool ran in, when the host can provide one.
 *
 * Built-in fs tools resolve relative paths against the agent's working
 * directory; without it `fs.resolve` falls back to the provider default and a
 * relative path would hash — and later patch — a different file.
 * @param {object} ctx - the plugin context.
 * @param {object} exec - the tool execution being finalized.
 * @returns {Promise<string|undefined>} the working directory, when known.
 */
async function workingDirectoryOf(ctx, exec) {
  // The built-ins skip the lookup entirely for an agentless call; doing the same
  // avoids a pointless throw on every root-level tool dispatch.
  if (exec?.agent === undefined) return undefined
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory
    if (service && typeof service.ensure === 'function') return await service.ensure(exec?.agent, exec?.signal)
  } catch {
    // No working-directory service, or the step was aborted: fall back to the provider default.
  }
  return undefined
}

/**
 * Read a file that fits the plugin's single-call budget, resolved the same way
 * the built-in fs tools resolve it.
 * @param {object} ctx - the plugin context.
 * @param {string} filePath - model-supplied path.
 * @param {object} [exec] - the tool execution carrying the agent and signal.
 * @returns {Promise<{target: object, content: string, version: string}>} the read result.
 */
async function readWholeFile(ctx, filePath, exec) {
  const fs = requireFs(ctx)
  const signal = exec?.signal
  const cwd = await workingDirectoryOf(ctx, exec)
  const target = await fs.resolve(filePath, cwd === undefined ? { signal } : { cwd, signal })
  const info = await fs.stat(target, signal)
  if (!info) throw new Error(`file not found: ${filePath}`)
  if (info.type !== 'file') throw new Error(`not a regular file: ${filePath}`)
  if (typeof info.size === 'number' && info.size > MAX_FILE_BYTES) {
    throw new Error(`file is larger than the ${MAX_FILE_BYTES} byte limit: ${filePath}`)
  }
  const content = await fs.readText(target, signal)
  return { target, content, version: info.version }
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
 * Re-check every live anchor and report the files whose content changed.
 *
 * `stat` is the cheap prefilter: an unchanged version means nothing moved and
 * no read happens. A changed version then splits into the two cases that
 * matter — same content (a touch or rebuild: refresh the bookkeeping so the
 * policy gate's version base stays truthful) and different content (the
 * model's line numbers and hash for that file are void).
 * @param {object} ctx - the plugin context.
 * @param {object} registry - the plugin's anchor registry.
 * @param {object} actor - the step's agent, used as the observation owner.
 * @returns {Promise<Set<string>>} display paths that are stale right now.
 */
async function collectStale(ctx, registry, actor) {
  const stale = new Set()
  const fs = ctx?.fs
  if (!fs || registry.anchors.size === 0) return stale
  for (const [key, anchor] of [...registry.anchors]) {
    if (registry.turn - anchor.turn > ANCHOR_TURNS) {
      registry.anchors.delete(key)
      continue
    }
    const target = anchor.target ?? { targetKey: key }
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
    // The model's line numbers and hash for this file are void until it
    // re-reads and the anchor is replaced with the fresh one.
    stale.add(anchor.displayPath)
  }
  return stale
}

/** What to say when every previously reported file has been re-read. */
const CLEARED_NOTICE = '[line-patch] No files changed since your last read; earlier line-patch notices no longer apply.'

/**
 * The notice text for the current stale set.
 *
 * Only paths are listed — no hashes, so the model cannot pair a fresh hash
 * with stale line numbers and pass the whole-file check by accident.
 * @param {Set<string>} paths - stale display paths, deduplicated.
 * @returns {string} the notice body.
 */
function noticeText(paths) {
  const list = [...paths]
  const subject = list.length === 1 ? '1 file has' : `${list.length} files have`
  const pronoun = list.length === 1 ? 'it' : 'them'
  return `[line-patch] ${subject} changed since you last read or wrote ${pronoun}:\n` +
    list.map(path => `- ${path}`).join('\n') +
    '\nThe line numbers and file_hash values you saw earlier for these files are void. ' +
    'Re-read a file before patching it.'
}

/** Build the user message carrying a notice body. */
function noticeMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'line-patch', form: 'notice', summary: text.split('\n')[0] },
  })
}

/**
 * Overwrite the live notice in place.
 *
 * The session surface only offers `replace`, never `delete`, so the single
 * line-patch notice is rewritten whenever the stale set changes and replaced by
 * a closing line once nothing is stale. That keeps exactly one record instead
 * of accumulating one per change.
 * @param {object} registry - the plugin's anchor registry.
 * @param {string} text - the new notice body.
 * @returns {boolean} whether the replacement was recorded.
 */
function replaceNotice(registry, text) {
  const session = registry.session
  const live = registry.notice
  if (!session || !live || typeof session.append !== 'function') return false
  try {
    const event = session.append('user/message', noticeMessage(text), {
      surfaceOp: { op: 'replace', startSeq: live.seq, endSeq: live.seq },
      sourceEventSeqs: [live.seq],
    })
    registry.notice = { seq: event?.seq ?? live.seq, text }
    return true
  } catch {
    return false
  }
}

/**
 * What this result should carry, or null when it should carry nothing.
 *
 * Runs before the rest of the `tools/post-execute` chain. Reading the file
 * again here is what makes the hash describe the file itself rather than the
 * tool's (possibly partial) view. Registering the anchor is left to the caller,
 * because a blocked result must not become a tracked read.
 * @param {object} ctx - the plugin context.
 * @param {object} registry - the plugin's anchor registry.
 * @param {object} exec - the tool execution being finalized.
 * @param {object} result - its outcome.
 * @returns {Promise<{line: string, anchor: object|null}|null>} the annotation.
 */
async function annotationFor(ctx, registry, exec, result) {
  const toolName = exec?.name
  if (!ANNOTATED_TOOLS.has(toolName) || result?.isError) return null
  if (!Array.isArray(result.content) || !result.content.some(block => block?.type === 'text')) return null
  const filePath = exec.arguments?.file_path
  if (typeof filePath !== 'string') return null

  let read
  try {
    read = await readWholeFile(ctx, filePath, exec)
  } catch {
    // A path this plugin cannot hash (binary view, oversized file, vanished) simply gets no hash.
    return null
  }
  // The hook re-reads the file after the tool did. If the stat version moved in
  // between, the hash would attest content the model never saw — annotate
  // nothing and let the next read produce a fresh pair.
  const observedKey = read.target.targetKey ?? read.target.key
  if (observedKey !== undefined && registry.observed.has(observedKey)
    && registry.observed.get(observedKey) !== read.version) {
    return null
  }
  const hash = fileHash(read.content)
  // Every annotated result becomes a tracked anchor: a later external change
  // voids its hash no matter which tool produced it.
  const anchor = {
    targetKey: read.target.targetKey ?? read.target.key ?? filePath,
    displayPath: filePath,
    fileHash: hash,
    version: read.version,
    turn: registry.turn,
    target: read.target,
  }
  return { line: `file_hash: ${hash}`, anchor }
}

/** Does this content already end with a hash line (a second loaded instance)? */
function alreadyAnnotated(content) {
  const last = Array.isArray(content) ? content.at(-1) : undefined
  if (last?.type !== 'text' || typeof last.text !== 'string') return false
  return /(?:^|\n)file_hash: [0-9a-f]+$/.test(last.text)
}

/**
 * Append the hash line *inside* the last text block.
 *
 * A result with two text blocks breaks plugins that annotate single-block
 * results (dsh-context-archive requires `content.length === 1`), so the new
 * line joins the existing block instead of becoming a block of its own.
 * @param {object[]} content - the result content blocks.
 * @param {string} line - the annotation line.
 * @returns {object[]} the content blocks to return.
 */
function appendAnnotation(content, line) {
  const blocks = Array.isArray(content) ? [...content] : []
  const last = blocks.at(-1)
  if (last?.type === 'text' && typeof last.text === 'string') {
    const separator = last.text.endsWith('\n') ? '' : '\n'
    blocks[blocks.length - 1] = { ...last, text: `${last.text}${separator}${line}` }
    return blocks
  }
  return [...blocks, { type: 'text', text: line }]
}

/**
 * Register the `patch` tool plus the hash annotation and anchor bookkeeping.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const registry = { anchors: new Map(), order: [], turn: 0, observed: new Map(), session: undefined, notice: null }

  /** Record an observation so `fs/write-intent` sees this file as read. */
  const observe = (target, version, actor) => {
    try {
      ctx.emit('fs/observed', target, { kind: 'present', version }, actor)
    } catch {
      // The gate is optional; a bare provider simply has no listener.
    }
  }

  // A tool-mediated write refreshes its own observation, so the anchor it
  // invalidates must not later read back as an "external" change. The same
  // table tells the annotator whether the file moved between the tool's own
  // observation and the hook's verifying read.
  try {
    ctx.on('fs/observed', (target, observation) => {
      if (!target || observation?.kind !== 'present') return
      const key = target.targetKey ?? target.key
      if (key !== undefined) {
        registry.observed.set(key, observation.version)
        while (registry.observed.size > MAX_ANCHORS * 2) {
          const oldest = registry.observed.keys().next().value
          registry.observed.delete(oldest)
        }
      }
      const anchor = registry.anchors.get(key)
      if (anchor && anchor.version !== observation.version) registry.anchors.delete(key)
    })
  } catch {
    // Hosts without the observation gate simply skip this bookkeeping.
  }

  // Every read/write/edit result is annotated here; `read` also registers the
  // anchor that the per-request revalidation later checks.
  try {
    ctx.on('tools/post-execute', (...args) => {
      const next = typeof args.at(-1) === 'function' ? args.at(-1) : undefined
      const [exec, result] = args
      // Cordis waterfall: `next()` takes no arguments and returns the downstream
      // decision; the outermost listener's RETURN VALUE is what the host applies.
      return annotationFor(ctx, registry, exec, result)
        .catch(() => null)
        .then(async annotation => {
          const downstream = next ? await next() : { kind: 'accept' }
          // Never argue with a block, a value replacement (the host forbids value
          // and content together), or a result that already carries a hash.
          if (!annotation || !downstream || downstream.kind !== 'accept') return downstream
          if (Object.hasOwn(downstream, 'value')) return downstream
          const base = Array.isArray(downstream.content) ? downstream.content : result.content ?? []
          if (alreadyAnnotated(base)) return downstream
          // Only an accepted result becomes a tracked anchor; a blocked one must
          // not later be announced as a change.
          if (annotation.anchor) rememberAnchor(registry, annotation.anchor)
          return { ...downstream, content: appendAnnotation(base, annotation.line) }
        })
    })
  } catch {
    // Without the waterfall the model simply sees no file_hash; `patch` is then unusable, not wrong.
  }

  // The user-turn counter bounds how long an anchor stays worth re-checking;
  // anchors older than the window are dropped instead of tracked forever. The
  // same stream keeps the seq of the single live notice, so it can be replaced
  // in place instead of accumulating.
  try {
    ctx.on('session/event', (session, event) => {
      if (session) registry.session = session
      if (event?.type === 'turn/start') registry.turn += 1
      if (event?.type !== 'user/message') return
      const message = event.data
      if (message?.source?.kind !== 'line-patch') return
      const text = message.content?.[0]?.text
      if (typeof text === 'string') registry.notice = { seq: event.seq, text }
    })
  } catch {
    // A host without session events still gets a working patch; anchors then
    // never expire by age and are only bounded by MAX_ANCHORS.
  }

  // `agent/pre-step` runs once per model request. It is the non-destructive
  // channel: a file that moved under the model is announced as one live user
  // notice, replaced in place as the stale set changes, and closed out once
  // everything has been re-read. No earlier tool result is rewritten.
  try {
    ctx.on('agent/pre-step', (...args) => {
      const next = typeof args.at(-1) === 'function' ? args.at(-1) : undefined
      const step = args[0]
      return collectStale(ctx, registry, step?.agent)
        .catch(() => new Set())
        .then(async stale => {
          const downstream = next ? await next() : { kind: 'accept', messages: [] }
          if (!downstream || downstream.kind === 'reject' || step?.signal?.aborted) return downstream
          const text = stale.size > 0 ? noticeText(stale) : CLEARED_NOTICE
          // Unchanged state: the live notice already says this.
          if (registry.notice?.text === text) return downstream
          // A live notice is rewritten through the replace op; only the first
          // notice goes through the host's own append path.
          if (registry.notice) {
            replaceNotice(registry, text)
            return downstream
          }
          if (stale.size === 0) return downstream
          return { ...downstream, messages: [...(downstream.messages ?? []), noticeMessage(text)] }
        })
    })
  } catch {
    // Without the hook, anchors are only checked at patch time.
  }

  ctx.tools.register(defineTool({
    name: 'patch',
    description: PATCH_DESCRIPTION,
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
      file_hash: { type: 'string', required: true, description: `The ${FILE_HASH_CHARS}-character hash printed under the latest read/write/edit result for this file, or under a previous patch result.` },
      line_start: { type: 'number', required: true, description: '1-based first line to replace.' },
      start_anchor: { type: 'string', required: true, description: `First ${ANCHOR_CHARS} characters of line_start's text — after the "N: " prefix a read result prints — indentation included (the whole line text when it is shorter).` },
      line_end: { type: 'number', required: true, description: '1-based last line to replace, inclusive. Equal to line_start for one line.' },
      end_anchor: { type: 'string', required: true, description: `Last ${ANCHOR_CHARS} characters of line_end's text — after the "N: " prefix; whitespace at either edge is collapsed before comparing (the whole line text when it is shorter).` },
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
          `(line shift ${value.line_shift >= 0 ? '+' : ''}${value.line_shift}).\n` +
          `file_hash: ${value.new_file_hash}`,
      }],
      presentationMeta: (args, value) => ({ replaced: value.replaced, path: value.path }),
    },
    async execute(args, exec) {
      const fs = requireFs(ctx)
      const { target, content, version } = await readWholeFile(ctx, args.file_path, exec)
      const result = applyPatch({
        content,
        expectedFileHash: args.file_hash,
        lineStart: args.line_start,
        startAnchor: args.start_anchor,
        lineEnd: args.line_end,
        endAnchor: args.end_anchor,
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
        targetKey: target.targetKey ?? target.key ?? String(args.file_path),
        displayPath: String(args.file_path),
        fileHash: result.fileHash,
        version: outcome?.version ?? version,
        turn: registry.turn,
        target,
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
