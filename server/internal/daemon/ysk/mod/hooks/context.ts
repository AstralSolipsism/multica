// The run context the daemon writes to MULTICA_YSK_CONTEXT_FILE: the claim's
// `you_should_know` field, version 1 (OL-187 section 13 B).

export type ExistingTip = {
  id: string
  tag: string
  line: string
}

export type Limits = {
  line: number
  title: number
  explanation: number
}

export type YskContext = {
  issueIdentifier: string
  latestHumanComment: string
  existingTips: ExistingTip[]
  knownTopics: string[]
  lightTipCount: number
  checkEverySteps: number
  limits: Limits
}

const DEFAULT_LIMITS: Limits = { line: 40, title: 12, explanation: 200 }
const MAX_LIGHT_TIPS = 10
const MAX_EXISTING_TIPS = 200
const MAX_KNOWN_TOPICS = 50
const MAX_COMMENT_CHARS = 500
const MAX_TOPIC_CHARS = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Length in code points, the unit the server's limits count in. */
export function charCount(text: string): number {
  return [...text].length
}

export function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseLimits(value: unknown): Limits {
  if (!isRecord(value)) return DEFAULT_LIMITS
  const pick = (key: keyof Limits): number => {
    const n = value[key]
    return isCount(n) && n > 0 ? n : DEFAULT_LIMITS[key]
  }
  return { line: pick('line'), title: pick('title'), explanation: pick('explanation') }
}

/**
 * Reads the context file's text. Anything that is not a version-1 context
 * turns the mod off for the session; malformed entries inside one are dropped.
 */
export function parseContext(raw: string): YskContext | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.version !== 1) return undefined

  const existingTips: ExistingTip[] = []
  if (Array.isArray(value.existing_tips)) {
    for (const tip of value.existing_tips) {
      if (!isRecord(tip)) continue
      const id = text(tip.id)
      const line = text(tip.line)
      if (id === '' || line === '') continue
      existingTips.push({ id, tag: text(tip.tag), line })
    }
  }

  const knownTopics: string[] = []
  if (Array.isArray(value.known_topics)) {
    for (const topic of value.known_topics) {
      const t = text(topic)
      if (t !== '') knownTopics.push(clip(t, MAX_TOPIC_CHARS))
    }
  }

  const lightTipCount = isCount(value.light_tip_count) ? Math.min(value.light_tip_count, MAX_LIGHT_TIPS) : 0
  const checkEverySteps = isCount(value.check_every_steps) ? value.check_every_steps : 0

  return {
    issueIdentifier: text(value.issue_identifier),
    latestHumanComment: clip(text(value.latest_human_comment), MAX_COMMENT_CHARS),
    existingTips: existingTips.slice(-MAX_EXISTING_TIPS),
    knownTopics: knownTopics.slice(-MAX_KNOWN_TOPICS),
    lightTipCount,
    checkEverySteps,
    limits: parseLimits(value.limits),
  }
}
