// Main model steps are zero-based. Claude forks see tool results one request
// behind the main thread, so wait two steps after the third exploration round.
const FORK_STALE_STEPS = 30
const LIGHT_FALLBACK_STEP = 7

const BACKOFF_FACTOR = 4

export class Schedule {
  private steps = 0
  private explorationRounds = 0
  private exploredStep = -1
  private lightStep = -1
  private nextCheck = Number.POSITIVE_INFINITY
  private checkGap = 0
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
      if (step < LIGHT_FALLBACK_STEP && (this.explorationRounds < 3 || step < this.exploredStep + 2)) return undefined
      this.lightStep = step
      if (this.checkEverySteps > 0) {
        this.checkGap = this.checkEverySteps
        this.nextCheck = step + this.checkGap
      }
      return 'light'
    }
    if (this.headsUpFound || step < this.nextCheck) return undefined
    // Dense early, sparser later: double the gap each round, capped at 4x.
    this.checkGap = Math.min(this.checkGap * 2, this.checkEverySteps * BACKOFF_FACTOR)
    this.nextCheck = step + this.checkGap
    return 'heads_up'
  }

  /** Called when main step `step`'s response is in. */
  end(step: number, explored: boolean): void {
    if (explored && this.explorationRounds < 3) {
      this.explorationRounds++
      this.exploredStep = step
    }
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

/** Classify evidence gathering, not platform setup or task metadata reads. */
export function isExploration(name: string, input: Record<string, unknown>): boolean {
  if (/^(read|read_file)$/i.test(name)) {
    const path = input.file_path ?? input.path
    return typeof path === 'string' && !/(?:^|[/\\])(?:AGENTS|CLAUDE|SKILL|issue)\.md$/i.test(path)
  }
  if (/^(grep|glob|search)$/i.test(name)) return true
  if (!/^(bash|shell|exec_command)$/i.test(name)) return false
  const command = input.command ?? input.cmd
  if (typeof command !== 'string') return false
  // Count a mixed shell command if it also reads source or diagnoses behavior.
  return /(?:^|[;&\n])\s*(?:(?:rg|grep|cat|sed|head|tail|less)\b|git\s+(?:diff|show|log|blame)\b|(?:go|cargo)\s+(?:test|check|build)\b|(?:npm|pnpm|bun)\s+(?:run\s+)?(?:test|typecheck|lint)\b|(?:python3?|node)\s+(?:-c|-e|-m)\b|(?:pytest|curl|ps)\b)/.test(command)
}
