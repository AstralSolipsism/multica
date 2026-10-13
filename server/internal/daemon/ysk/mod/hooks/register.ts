import type { EngineInterface, ModelForkResult, Register } from 'claude-code'
import { parseContext, type YskContext } from './context'
import { headsUpPrompt, lightPrompt } from './prompts'
import { headsUpOutcome, lightBatch, type Batch, type Tip } from './reply'

// labrastro-ysk: "You should know" tips for the people watching a Labrastro
// agent. The daemon loads this mod only when the workspace turned the feature
// on; it hands over the run context in MULTICA_YSK_CONTEXT_FILE and reads the
// batches back from the `ui_log` lines of Claude Code's stream-json output.
//
// Every question is a `$.model.fork`: the main thread's last request again,
// tool-less, read from its prompt cache and never written to the transcript.
// A fork is never awaited inside a hook and every failure is swallowed, so
// the agent's own work is untouched whatever happens here.

// A fork answers within a step or two. One still open after this many main
// steps is given up: the next check may start, and once it has, the old
// fork's answer is ignored.
const FORK_STALE_STEPS = 30

/**
 * When to ask, counted in main-thread model requests (`turn.step` without an
 * `agentId`), the unit Claude Code's own "You should know" uses.
 *
 * A fork sees the main thread's last request plus the text of its reply, so
 * at step `n` it sees the tool results the reply to step `n - 2` asked for.
 * The light batch therefore waits for the first step whose fork can see a
 * tool result: on a fresh session the prompt only names the issue, and its
 * content arrives as the result of the agent's first tool call.
 */
export class Schedule {
  private steps = 0
  private firstToolStep = -1
  private lightStep = -1
  private nextCheck = Number.POSITIVE_INFINITY
  private headsUpFound = false
  private fork: { id: number; step: number } | undefined
  private forks = 0

  constructor(private readonly checkEverySteps: number) {}

  /** Called as each main step starts; returns the step's index from 0. */
  begin(): number {
    return this.steps++
  }

  /** Which question, if any, to ask as main step `step` starts. */
  decide(step: number): 'light' | 'heads_up' | undefined {
    if (this.fork !== undefined && step - this.fork.step < FORK_STALE_STEPS) return undefined
    if (this.lightStep < 0) {
      if (this.firstToolStep < 0 || step < this.firstToolStep + 2) return undefined
      this.lightStep = step
      if (this.checkEverySteps > 0) this.nextCheck = step + this.checkEverySteps
      return 'light'
    }
    if (this.headsUpFound || step < this.nextCheck) return undefined
    this.nextCheck = step + this.checkEverySteps
    return 'heads_up'
  }

  /** Called when main step `step`'s response is in. */
  end(step: number, toolUses: number): void {
    if (this.firstToolStep < 0 && toolUses > 0) this.firstToolStep = step
  }

  /** Marks a fork started at `step` as running; the returned id settles it. */
  forkStarted(step: number): number {
    const id = ++this.forks
    this.fork = { id, step }
    return id
  }

  /**
   * Called when fork `id` answers. Returns whether its answer still counts:
   * false when a newer fork has started since, which happens only after this
   * one was given up.
   */
  forkSettled(id: number): boolean {
    if (this.fork?.id !== id) return false
    this.fork = undefined
    return true
  }

  foundHeadsUp(): void {
    this.headsUpFound = true
  }
}

/**
 * `CLAUDE_CODE_PLUGIN_DIRS` without this mod's folder, or undefined when
 * nothing else is left. The list separator follows the platform the root's
 * spelling shows: an absolute POSIX path starts with a slash.
 */
export function pluginDirsWithout(dirs: string, root: string): string | undefined {
  const separator = root.startsWith('/') ? ':' : ';'
  const trim = (path: string) => path.replace(/[\\/]+$/, '')
  const own = trim(root)
  const rest = dirs.split(separator).filter((dir) => dir !== '' && trim(dir) !== own)
  return rest.length > 0 ? rest.join(separator) : undefined
}

/**
 * Takes this mod's variables out of the process environment, then reads the
 * run context: nothing the agent starts afterwards (a shell, a nested
 * `claude`) should find the context file or load this mod a second time.
 */
async function loadContext($: EngineInterface): Promise<{ context: YskContext | undefined; stopFile: string } | undefined> {
  const path = await $.env.get('MULTICA_YSK_CONTEXT_FILE')
  if (path === undefined || path === '') return undefined
  await $.env.set('MULTICA_YSK_CONTEXT_FILE', undefined)
  const dirs = await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')
  if (dirs !== undefined) await $.env.set('CLAUDE_CODE_PLUGIN_DIRS', pluginDirsWithout(dirs, $.plugin.root))
  const raw = await $.fs.read(path)
  return { context: typeof raw === 'string' ? parseContext(raw) : undefined, stopFile: path.replace(/[^\\/]*$/, 'stop') }
}

async function stopRequested($: EngineInterface, path: string | undefined): Promise<boolean> {
  if (path === undefined) return false
  try {
    // The empty marker is enough. Missing is normal; all read failures leave
    // generation enabled, without affecting the main request.
    return typeof await $.fs.read(path) === 'string'
  } catch {
    return false
  }
}

function debug($: EngineInterface, message: string): void {
  try {
    $.ui.log(`labrastro-ysk: ${message}`, { to: 'debug' })
  } catch {
    // Diagnostics only.
  }
}

function emit($: EngineInterface, batch: Batch): void {
  // One `ui_log` line per batch; the daemon forwards its text as-is.
  $.ui.log(JSON.stringify(batch))
}

/** Takes one fork's answer; `sent` holds the tips this run has emitted. */
function settle($: EngineInterface, ctx: YskContext, plan: Schedule, sent: Tip[], ask: 'light' | 'heads_up', step: number, result: ModelForkResult): void {
  if (!result.isAnswered) {
    const reason = result.reason === 'api-error' ? `api-error ${result.status ?? 'no status'} ${result.error}` : result.reason
    debug($, `${ask} fork at step ${step}: ${reason}`)
    return
  }
  if (ask === 'light') {
    const batch = lightBatch(result.text, ctx, step, sent)
    if (batch === undefined) {
      debug($, `light fork at step ${step}: nothing usable`)
      return
    }
    emit($, batch)
    sent.push(...batch.tips)
    return
  }
  // Only the current fork's answer reaches here and no check starts once a
  // heads-up is found, so a run sends one heads-up at most.
  const outcome = headsUpOutcome(result.text, ctx, step, sent)
  if (outcome.kind !== 'found') {
    debug($, `heads-up fork at step ${step}: ${outcome.kind}`)
    return
  }
  plan.foundHeadsUp()
  emit($, outcome.batch)
  sent.push(...outcome.batch.tips)
}

export const register: Register = (on) => {
  let context: YskContext | undefined
  let agentName = ''
  let schedule: Schedule | undefined
  let stopFile: string | undefined
  let stopped = false
  // Tips this run has emitted: shown to readers already, so later questions
  // and answers leave them out.
  const sent: Tip[] = []

  on('session.start', async ($, e, next) => {
    try {
      const loaded = await loadContext($)
      context = loaded?.context
      stopFile = loaded?.stopFile
      stopped = false
      agentName = ((await $.env.get('MULTICA_AGENT_NAME')) ?? '').trim()
      schedule = context === undefined ? undefined : new Schedule(context.checkEverySteps)
      if (context === undefined) debug($, 'no usable run context; staying off')
    } catch (error) {
      context = undefined
      schedule = undefined
      debug($, `run context unreadable (${String(error)}); staying off`)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const ctx = context
    const plan = schedule
    if (e.agentId !== undefined || ctx === undefined || plan === undefined || stopped) {
      return yield* next(e)
    }

    const step = plan.begin()
    try {
      const ask = plan.decide(step)
      if (ask !== undefined && !(stopped = await stopRequested($, stopFile))) {
        const prompt = ask === 'light' ? lightPrompt(ctx, agentName, sent) : headsUpPrompt(ctx, agentName, sent)
        const fork = plan.forkStarted(step)
        // Not awaited: the main thread's request goes out at once, and the
        // answer is logged whenever it arrives.
        void $.model.fork({ prompt }).then(
          (result) => {
            if (!plan.forkSettled(fork)) {
              debug($, `${ask} fork at step ${step} answered after it was given up; ignored`)
              return
            }
            try {
              settle($, ctx, plan, sent, ask, step, result)
            } catch (error) {
              debug($, `${ask} fork at step ${step}: ${String(error)}`)
            }
          },
          (error: unknown) => {
            plan.forkSettled(fork)
            debug($, `${ask} fork at step ${step} refused: ${String(error)}`)
          },
        )
      }
    } catch (error) {
      debug($, `step ${step} bookkeeping failed: ${String(error)}`)
    }

    const response = yield* next(e)
    try {
      plan.end(step, response.toolUses.length)
    } catch {
      // Bookkeeping only.
    }
    return response
  })
}
