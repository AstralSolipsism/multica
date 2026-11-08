import { clip, type YskContext } from './context'
import { headsUpOutcome, lightBatch, type Batch, type Tip } from './reply'

/** Consume delivered AdvisorNote objects, never the advisor's private tool traffic. */
export function advisorBatch(note: unknown, ctx: YskContext, step: number, sent: readonly Tip[]): Batch | undefined {
  if (typeof note !== 'object' || note === null) return undefined
  const { note: raw, severity = 'nit' } = note as { note?: unknown; severity?: unknown }
  if (typeof raw !== 'string' || !['nit', 'concern', 'blocker'].includes(String(severity))) return undefined
  const text = raw.replace(/\s+/gu, ' ').trim()
  if (!text || text.includes('\u0000')) return undefined
  const sentence = text.match(/^.*?[。！？.!?](?:\s|$)/u)?.[0].trim() ?? text
  const tip = {
    title: clip(sentence, ctx.limits.title),
    line: clip(sentence, ctx.limits.line),
    explanation: clip(text, ctx.limits.explanation),
  }
  if (severity === 'nit') return lightBatch(JSON.stringify({ tips: [tip] }), ctx, step, sent)
  const outcome = headsUpOutcome(JSON.stringify({ heads_up: tip }), ctx, step, sent)
  return outcome.kind === 'found' ? outcome.batch : undefined
}
