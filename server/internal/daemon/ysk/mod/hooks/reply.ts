import { charCount, clip, type Limits, type YskContext } from './context'

// The fork's reply turned into the batch the mod logs for the daemon
// (OL-187 section 13 D, version 1). Anything the server would refuse is
// dropped here, so only well-formed tips leave the mod.

export type TipTag = 'you_should_know' | 'heads_up'

export type Tip = {
  tag: TipTag
  line: string
  title: string
  explanation: string
}

export type Overturned = {
  tip_id: string
  reason: string
}

export type Batch = {
  ysk: 1
  kind: 'light' | 'heads_up'
  tips: Tip[]
  overturned: Overturned[]
  step: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The JSON object in a reply. The prompt asks for the bare object; a code
 * fence or a stray sentence around it is tolerated, nothing else is.
 */
export function replyObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function field(value: Record<string, unknown>, key: string): string {
  const raw = value[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

function tipFrom(value: unknown, tag: TipTag, limits: Limits): Tip | undefined {
  if (!isRecord(value)) return undefined
  const line = field(value, 'line')
  const title = field(value, 'title')
  const explanation = field(value, 'explanation')
  if (line === '' || title === '' || explanation === '') return undefined
  if (charCount(line) > limits.line || charCount(title) > limits.title || charCount(explanation) > limits.explanation) {
    return undefined
  }
  // The line and title are shown on one row; no field may carry a NUL.
  if (/[\r\n]/.test(line + title) || (line + title + explanation).includes('\u0000')) return undefined
  return { tag, line, title, explanation }
}

/**
 * The key two tips are compared by: character width, case and whitespace do
 * not count, so "60 秒，" and "60秒," are the same tip.
 */
export function tipKey(line: string): string {
  return line.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
}

/**
 * What the reader already has: the issue's tips, the topics the person knows
 * and the tips this run has already sent (`earlier`), which the context file
 * predates.
 */
function shownKeys(ctx: YskContext, earlier: readonly Tip[]): Set<string> {
  const lines = [...ctx.existingTips.map((tip) => tip.line), ...ctx.knownTopics, ...earlier.map((tip) => tip.line)]
  return new Set(lines.map(tipKey))
}

/** The first batch, or undefined when the reply holds nothing to report. */
export function lightBatch(text: string, ctx: YskContext, step: number, earlier: readonly Tip[] = []): Batch | undefined {
  const reply = replyObject(text)
  if (reply === undefined) return undefined

  const seen = shownKeys(ctx, earlier)
  const tips: Tip[] = []
  for (const candidate of Array.isArray(reply.tips) ? reply.tips : []) {
    if (tips.length >= ctx.lightTipCount) break
    const tip = tipFrom(candidate, 'you_should_know', ctx.limits)
    if (tip === undefined || seen.has(tipKey(tip.line))) continue
    seen.add(tipKey(tip.line))
    tips.push(tip)
  }

  const known = new Set(ctx.existingTips.map((tip) => tip.id))
  const overturned: Overturned[] = []
  for (const candidate of Array.isArray(reply.overturned) ? reply.overturned : []) {
    if (!isRecord(candidate)) continue
    const tipID = field(candidate, 'tip_id')
    const reason = field(candidate, 'reason')
    if (!known.has(tipID) || reason === '' || reason.includes('\u0000')) continue
    known.delete(tipID)
    overturned.push({ tip_id: tipID, reason: clip(reason, ctx.limits.explanation) })
  }

  if (tips.length === 0 && overturned.length === 0) return undefined
  return { ysk: 1, kind: 'light', tips, overturned, step }
}

export type HeadsUpOutcome =
  /** The reply was not the requested JSON; the next check runs as planned. */
  | { kind: 'unreadable' }
  /** The model looked and found nothing worth a heads-up. */
  | { kind: 'none' }
  /** The heads-up says what the reader already has; the checks go on. */
  | { kind: 'repeat' }
  | { kind: 'found'; batch: Batch }

export function headsUpOutcome(text: string, ctx: YskContext, step: number, earlier: readonly Tip[] = []): HeadsUpOutcome {
  const reply = replyObject(text)
  if (reply === undefined || !('heads_up' in reply)) return { kind: 'unreadable' }
  if (reply.heads_up === null) return { kind: 'none' }
  const tip = tipFrom(reply.heads_up, 'heads_up', ctx.limits)
  if (tip === undefined) return { kind: 'unreadable' }
  if (shownKeys(ctx, earlier).has(tipKey(tip.line))) return { kind: 'repeat' }
  return { kind: 'found', batch: { ysk: 1, kind: 'heads_up', tips: [tip], overturned: [], step } }
}
