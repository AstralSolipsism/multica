import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { advisorBatch } from './advisor'
import { parseContext, type YskContext } from './context'
import { headsUpPrompt, lightPrompt } from './prompts'
import { headsUpOutcome, lightBatch, type Batch, type Tip } from './reply'
import { isExploration, Schedule } from './schedule'

export default function (pi: ExtensionAPI): void {
  let context: YskContext | undefined
  let plan: Schedule | undefined
  let stopFile = ''
  let stopped = false
  let advisor = false
  let step = -1
  let explored = false
  const sent: Tip[] = []
  const shutdown = new AbortController()

  function active(ctx: ExtensionContext): boolean {
    if (ctx.agent?.kind !== 'main' || !context || stopped) return false
    if (existsSync(stopFile)) stopped = true
    return !stopped
  }

  function emit(batch: Batch | undefined): void {
    if (!batch) return
    // A private JSONL frame, intercepted before piBackend handles task events.
    // Never use sendMessage/appendEntry: neither history nor chat owns these tips.
    process.stdout.write(JSON.stringify({ type: 'labrastro_ysk', batch }) + '\n')
    sent.push(...batch.tips)
  }

  pi.on('session_start', (_event, ctx) => {
    if (ctx.agent?.kind !== 'main') return
    try {
      const path = process.env.MULTICA_YSK_CONTEXT_FILE
      advisor = process.env.MULTICA_OMP_YSK_ADVISOR === 'true'
      delete process.env.MULTICA_YSK_CONTEXT_FILE
      delete process.env.MULTICA_OMP_YSK_EXTENSION
      delete process.env.MULTICA_OMP_YSK_ADVISOR
      if (!path) return
      context = parseContext(readFileSync(path, 'utf8'))
      stopFile = join(dirname(path), 'stop')
      if (context) plan = new Schedule(advisor ? 0 : context.checkEverySteps)
    } catch {
      context = undefined
    }
  })

  pi.on('turn_start', (_event, ctx) => {
    try {
      if (!active(ctx) || !plan || !context) return
      step = plan.begin()
      explored = false
      const ask = plan.decide(step)
      if (!ask || (ask === 'heads_up' && advisor) || !ctx.runEphemeralTurn) return
      const fork = plan.forkStarted(step)
      const atStep = step
      const runContext = context
      const schedule = plan
      const promptText = ask === 'light' ? lightPrompt(runContext, sent) : headsUpPrompt(runContext, sent)
      // Fire and forget within the runtime. The extension handler never holds
      // the main turn open, and shutdown/timeout only cancel this side request.
      void ctx.runEphemeralTurn({
        promptText, tools: false, minimizeEffort: true,
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)]),
      }).then((result) => {
        if (!schedule.forkSettled(fork) || stopped) return
        try {
          if (ask === 'light') {
            emit(lightBatch(result.replyText, runContext, atStep, sent))
          } else {
            const outcome = headsUpOutcome(result.replyText, runContext, atStep, sent)
            if (outcome.kind === 'found') {
              emit(outcome.batch)
              schedule.foundHeadsUp()
            }
          }
        } catch { /* Tips must never fail the task. */ }
      }, () => { schedule.forkSettled(fork) })
    } catch { /* Missing/unsupported side turns leave the task untouched. */ }
  })

  pi.on('tool_result', (event, ctx) => {
    try {
      if (active(ctx) && !event.isError && isExploration(event.toolName, event.input)) explored = true
    } catch { /* Bookkeeping only. */ }
  })

  pi.on('turn_end', (_event, ctx) => {
    try {
      if (active(ctx) && step >= 0) plan?.end(step, explored)
    } catch { /* Bookkeeping only. */ }
  })

  pi.on('message_end', (event, ctx) => {
    try {
      if (!active(ctx) || !context) return
      const message = event.message
      if (message.role !== 'custom' || message.customType !== 'advisor') return
      advisor = true
      const details = message.details as { notes?: unknown[] } | undefined
      if (!Array.isArray(details?.notes)) return
      for (const note of details.notes) emit(advisorBatch(note, context, Math.max(1, step), sent))
    } catch { /* Malformed notes and reporting failures are silent. */ }
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.agent?.kind !== 'main') return
    stopped = true
    shutdown.abort()
  })
}
