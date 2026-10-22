import type { EngineInterface, Register } from 'claude-code'

// labrastro-effort: per-step adaptive effort for Labrastro Claude tasks
// (OL-992 S3-1). The daemon installs this mod only when the run uses an
// adaptive effort and the CLI can change effort per turn; it hands over the
// run context in MULTICA_EFFORT_CONTEXT_FILE and reads the levels that took
// effect back from the `ui_log` lines of Claude Code's stream-json output.
//
// Every main-thread step explicitly carries an effort: the daemon's fresh
// decision when one arrived, otherwise the last level that took effect. A
// bare next(e) would re-send the startup effort (OL-1000), which rewrites the
// prompt cache — the one thing per-turn effort avoids.
//
// Material crosses the mod -> daemon boundary WHOLE or NOT AT ALL: the
// daemon redacts and truncates (contract §4), and any clipping here could
// split a multi-line credential beyond recognition before that happens.

/** Context file written by the daemon, version 1. */
export type EffortContext = {
  task_id: string
  endpoint: string
  startup_effort: string
}

/** What the daemon answered for one step. */
export type Decision =
  | { kind: 'level'; level: string; confidence?: number; probabilities?: Record<string, number>; latency_ms?: number; source?: string }
  | { kind: 'fallback'; reason: string }
  | { kind: 'disabled' }

/** Step material sent to the daemon: raw only. The daemon normalizes error
 * features and counts same-kind repeats (OL-1013); this mod judges nothing. */
export type ToolMaterial = {
  name: string
  is_error: boolean
  /** True when the tool's result is file content: the daemon omits the
   * body from the state (contract §4). */
  is_file_content: boolean
  input_summary: string
  result_text: string
  /** True when the field over the byte limit ships as "" — whole or
   * omitted, never a partial body. */
  input_summary_omitted: boolean
  result_omitted: boolean
}

export type StepPayload = {
  step: number
  assistant_text: string
  tools: ToolMaterial[]
  error_text: string
  assistant_omitted: boolean
  error_omitted: boolean
}

// The daemon is local (measured 1–3 ms per round trip); a whole decision must
// not hold a step noticeably longer than this.
export const DECISION_TIMEOUT_MS = 2_000

// Whole-field byte ceilings. The daemon redacts BEFORE truncating, so a
// field within these limits crosses intact; an over-limit field is omitted
// entirely (never clipped). Bytes, not code points: the daemon's 1 MiB body
// limit counts bytes.
export const FIELD_LIMIT_BYTES = 64 * 1024
export const REQUEST_LIMIT_BYTES = 768 * 1024

/** UTF-8 byte length of a string (TextEncoder is available in the host). */
const encoder = new TextEncoder()
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/**
 * A field within `limit` UTF-8 bytes ships whole; an over-limit field ships
 * as "" and reports true. There is no partial body: clipping here would run
 * before the daemon's redaction and could split a multi-line credential
 * (e.g. a PEM private key) beyond its recognizer.
 */
export function wholeOrOmitted(text: string | undefined, limit: number): { value: string; omitted: boolean } {
  if (typeof text !== 'string' || text === '') return { value: '', omitted: false }
  return byteLength(text) <= limit ? { value: text, omitted: false } : { value: '', omitted: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseContext(raw: string): EffortContext | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.version !== 1) return undefined
  const task_id = typeof value.task_id === 'string' ? value.task_id : ''
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint : ''
  // startup_effort may be empty: a run whose run-level decision fell back
  // starts with no level; the first step decision sets one (contract §7).
  const startup_effort = typeof value.startup_effort === 'string' ? value.startup_effort : ''
  if (task_id === '' || endpoint === '') return undefined
  return { task_id, endpoint, startup_effort }
}

/**
 * Minimal shape of `$.session.messages()`. The host splits one request's
 * assistant output into several entries (text, then each tool use on its
 * own) and merges each tool result into its tool use entry (`text`,
 * `isError`), keyed by tool_use_id (OL-1000 §0.9). A user entry may carry
 * the results as toolResults, interleaved between the split assistant
 * entries of one step (observed on 2.1.304: a Read+Bash step delivered
 * [asst Read][user results][asst Bash][user results] to the mod).
 */
export type SessionMessages = Array<{
  role: string
  text?: string
  toolUses?: Array<Record<string, unknown>>
  toolResults?: Array<{ tool_use_id?: string }>
}>

/**
 * Payload for step `step`: the previous main-thread step's assistant text
 * and tool calls with their results. `window` is the entries that arrived
 * after the previous step's request (the caller snapshots the session
 * length each step): within it, the previous step is the run of entries
 * from the end back to the original user message — the host interleaves
 * user result entries between one step's split assistant entries. An
 * empty or missing window leaves the empty payload; the daemon still
 * decides on what arrived.
 */
export function stepPayload(step: number, window: SessionMessages | undefined): StepPayload {
  const tools: ToolMaterial[] = []
  const texts: string[] = []
  if (Array.isArray(window)) {
    let i = window.length - 1
    // Collect the step's assistant entries from the end. The host
    // interleaves user result entries between the step's split assistant
    // entries: a user entry carrying toolResults belongs to the step, one
    // without (the original user message) ends it.
    while (i >= 0) {
      const message = window[i]
      if (message?.role === 'user') {
        if ((message.toolResults ?? []).length === 0) break
        i--
        continue
      }
      if (message?.role !== 'assistant') break
      if (typeof message.text === 'string' && message.text !== '') texts.unshift(message.text)
      for (const use of message.toolUses ?? []) {
        if (!isRecord(use)) continue
        const isError = use.isError === true
        const isFileContent = fileContentTools.has(typeof use.tool === 'string' ? use.tool : '')
        // A file-content tool's SUCCESS result is a body the daemon omits
        // anyway — do not ship it. Its FAILURE result is an error message,
        // not file content, and must reach error_text.
        const result = isFileContent && !isError
          ? { value: '', omitted: false }
          : wholeOrOmitted(typeof use.text === 'string' ? use.text : '', FIELD_LIMIT_BYTES)
        const summary = wholeOrOmitted(summarizeInput(use.input), FIELD_LIMIT_BYTES)
        tools.unshift({
          name: typeof use.tool === 'string' ? use.tool : '',
          is_error: isError,
          is_file_content: isFileContent,
          input_summary: summary.value,
          result_text: result.value,
          input_summary_omitted: summary.omitted,
          result_omitted: result.omitted,
        })
      }
      i--
    }
  }
  const errorTools = tools.filter((tool) => tool.is_error && tool.result_text !== '')
  const joined = errorTools.map((tool) => tool.result_text).join('\n')
  // An error tool whose result was omitted whole must not read as "no
  // error": the daemon would reset the repeat count (#38). Flag the
  // error text omitted whenever any error body was, even when the joined
  // text is empty.
  const errorOmitted = tools.some((tool) => tool.is_error && tool.result_omitted)
  const errorText = wholeOrOmitted(joined, FIELD_LIMIT_BYTES)
  const assistantText = wholeOrOmitted(texts.join(''), FIELD_LIMIT_BYTES)
  const payload: StepPayload = {
    step,
    assistant_text: assistantText.value,
    tools,
    error_text: errorText.value,
    assistant_omitted: assistantText.omitted,
    error_omitted: errorText.omitted || errorOmitted,
  }
  return fitRequest(payload)
}

/**
 * Keeps the serialized payload under the request ceiling by dropping whole
 * fields — the earliest tools' big texts first (the state describes the
 * LAST failed tool or the last tool, so the tail matters most), then the
 * remaining big fields. A tool's name and is_error are never dropped
 * (OL-1013 wants the full tool list). The budget is measured on the
 * serialized JSON — the bytes the daemon actually decodes.
 */
export function fitRequest(payload: StepPayload): StepPayload {
  const over = (): boolean => byteLength(JSON.stringify(payload)) > REQUEST_LIMIT_BYTES
  if (!over()) return payload
  // Keep the last failed tool; with no failure, the last tool.
  const lastFailed = payload.tools.reduce((acc, t, idx) => (t.is_error ? idx : acc), -1)
  const keep = lastFailed >= 0 ? lastFailed : payload.tools.length - 1
  for (let i = 0; i < payload.tools.length; i++) {
    if (i === keep) continue
    const tool = payload.tools[i]
    if (tool.result_text !== '') {
      tool.result_text = ''
      tool.result_omitted = true
      if (!over()) return payload
    }
    if (tool.input_summary !== '') {
      tool.input_summary = ''
      tool.input_summary_omitted = true
      if (!over()) return payload
    }
  }
  if (payload.assistant_text !== '') {
    payload.assistant_text = ''
    payload.assistant_omitted = true
    if (!over()) return payload
  }
  if (payload.error_text !== '') {
    payload.error_text = ''
    payload.error_omitted = true
  }
  return payload
}

/** Tools whose results are file contents: the daemon omits the body for
 * them (contract §4 — no file contents leave the machine). */
const fileContentTools = new Set(['Read', 'NotebookRead'])

/** The one field of a tool input that names what it touched, when there is
 * one; otherwise the whole input as JSON. */
function summarizeInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (!isRecord(input)) return ''
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value
  }
  try {
    return JSON.stringify(input)
  } catch {
    return ''
  }
}

/** One effect record, exactly as the daemon reads it from the ui_log line. */
export function effectRecord(payload: { step: number; level: string; confidence?: number; probabilities?: Record<string, number>; latency_ms?: number; source?: string; fallback?: string }): string {
  const record: Record<string, unknown> = { effort: 1, step: payload.step, level: payload.level }
  for (const key of ['confidence', 'probabilities', 'latency_ms', 'source', 'fallback'] as const) {
    const value = payload[key]
    if (value !== undefined) record[key] = value
  }
  return JSON.stringify(record)
}

function debug($: EngineInterface, message: string): void {
  try {
    $.ui.log(`labrastro-effort: ${message}`, { to: 'debug' })
  } catch {
    // Diagnostics only.
  }
}

async function markerExists($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.exists(path)) === true
  } catch {
    return false
  }
}

/**
 * `CLAUDE_CODE_PLUGIN_DIRS` without this mod's folder (empty string when
 * nothing else is left), so nothing the agent starts loads this mod twice.
 * Keeps the other mods' folders (labrastro-ysk) intact.
 */
export function pluginDirsWithout(dirs: string, root: string): string {
  const separator = root.startsWith('/') ? ':' : ';'
  const trim = (path: string) => path.replace(/[\\/]+$/, '')
  const own = trim(root)
  const rest = dirs.split(separator).filter((dir) => dir !== '' && trim(dir) !== own)
  return rest.join(separator)
}

/** The daemon's answer for one step's effort, as the endpoint shapes it. */
export async function decide(
  $: EngineInterface,
  ctx: EffortContext,
  step: number,
  port: string,
  token: string,
  window: SessionMessages | undefined,
): Promise<Decision> {
  const payload = stepPayload(step, window)
  let response: { status?: number; text?: string } | undefined
  try {
    response = await Promise.race([
      $.http.fetch(`http://127.0.0.1:${port}${ctx.endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), DECISION_TIMEOUT_MS)),
    ])
  } catch {
    return { kind: 'fallback', reason: 'error' }
  }
  if (response === undefined) return { kind: 'fallback', reason: 'timeout' }
  // 401/404 means this run's credential or endpoint is gone; asking again
  // each step would only repeat it.
  if (response.status === 401 || response.status === 404) return { kind: 'disabled' }
  if (response.status !== 200) return { kind: 'fallback', reason: 'error' }
  let answer: unknown
  try {
    answer = JSON.parse(response.text ?? '')
  } catch {
    return { kind: 'fallback', reason: 'error' }
  }
  if (!isRecord(answer)) return { kind: 'fallback', reason: 'error' }
  if (answer.enabled === false) return { kind: 'disabled' }
  if (typeof answer.fallback === 'string' && answer.fallback !== '') return { kind: 'fallback', reason: answer.fallback }
  if (typeof answer.level === 'string' && answer.level !== '') {
    return {
      kind: 'level',
      level: answer.level,
      confidence: typeof answer.confidence === 'number' ? answer.confidence : undefined,
      probabilities: isRecord(answer.probabilities) ? (answer.probabilities as Record<string, number>) : undefined,
      latency_ms: typeof answer.latency_ms === 'number' ? answer.latency_ms : undefined,
      source: typeof answer.source === 'string' ? answer.source : undefined,
    }
  }
  return { kind: 'fallback', reason: 'error' }
}

export const register: Register = (on) => {
  let context: EffortContext | undefined
  let markerFile: string | undefined
  let token = ''
  let port = ''
  // The last level that took effect; the startup level until a decision says
  // otherwise. Every main step carries it explicitly.
  let last = ''
  // The enablement marker was seen at least once this run.
  let wasEnabled = false
  // Per-turn effort is off for the rest of this run (marker removed after it
  // was seen, or the endpoint answered not-enabled): lock `last`, stop asking,
  // write no further effect records.
  let revoked = false
  // Entry count of `$.session.messages()` as of the previous main step's
  // request: the next step's decision material is only what arrived after
  // it (the previous step), never the whole run (#19).
  let seenEntries = 0

  on('session.start', async ($, e, next) => {
    try {
      const path = await $.env.get('MULTICA_EFFORT_CONTEXT_FILE')
      if (path !== undefined && path !== '') {
        await $.env.set('MULTICA_EFFORT_CONTEXT_FILE', undefined)
        const dirs = await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')
        if (dirs !== undefined) {
          await $.env.set('CLAUDE_CODE_PLUGIN_DIRS', pluginDirsWithout(dirs, $.plugin.root))
        }
        token = (await $.env.get('MULTICA_TOKEN')) ?? ''
        port = (await $.env.get('MULTICA_DAEMON_PORT')) ?? ''
        const raw = await $.fs.read(path)
        context = typeof raw === 'string' ? parseContext(raw) : undefined
        markerFile = context === undefined ? undefined : path.replace(/[^\\/]*$/, 'enabled')
        last = context?.startup_effort ?? ''
        if (context === undefined) debug($, 'no usable run context; staying off')
      }
    } catch (error) {
      context = undefined
      markerFile = undefined
      debug($, `run context unreadable (${String(error)}); staying off`)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const ctx = context
    if (e.agentId !== undefined || ctx === undefined) return yield* next(e)
    const step = e.index + 1
    if (step === 1) {
      // Step 1: `last` (set from the context's startup_effort at
      // session.start) is the run-level decision's level; a run-level
      // fallback leaves it empty (no effort flag injected). e.effort must
      // not referee this: with no --effort injected it reports the CLI
      // default ("medium" measured on 2.1.304, Haiku 5.5 — OL-1057), so
      // trusting it would turn a run-level fallback into a locked medium.
      return yield* next(last === '' ? e : { ...e, effort: last })
    }
    if (!revoked && markerFile !== undefined) {
      const enabled = await markerExists($, markerFile)
      if (enabled) {
        wasEnabled = true
      } else if (wasEnabled) {
        // The daemon revoked per-turn effort mid-run (per_turn_effort_changed
        // was false): lock the level, keep it explicit so the top-level
        // startup effort never comes back and rewrites the cache.
        revoked = true
      }
    }
    if (!revoked && wasEnabled) {
      let window: SessionMessages | undefined
      try {
        const messages = (await $.session.messages()) as SessionMessages
        // Snapshot before this step's request adds its own entries.
        window = messages.slice(seenEntries)
        seenEntries = messages.length
      } catch {
        // Materials are best-effort; the daemon decides on what arrived.
      }
      const decision = await decide($, ctx, step, port, token, window)
      if (decision.kind === 'disabled') {
        revoked = true
      } else if (decision.kind === 'level') {
        last = decision.level
        $.ui.log(effectRecord({
          step,
          level: decision.level,
          confidence: decision.confidence,
          probabilities: decision.probabilities,
          latency_ms: decision.latency_ms,
          source: decision.source,
        }))
      } else {
        // Fallback keeps the last level; the record says so (contract §7).
        // With no level ever in effect (run-level fallback and no decision
        // yet), level stays empty and the step passes through unchanged.
        $.ui.log(effectRecord({ step, level: last, fallback: decision.reason }))
      }
    }
    return yield* next(last === '' ? e : { ...e, effort: last })
  })
}
