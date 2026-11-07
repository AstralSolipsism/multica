// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import omp from '../mod/hooks/omp'
import { advisorBatch } from '../mod/hooks/advisor'
import { parseContext, charCount } from '../mod/hooks/context'
import { isExploration, Schedule } from '../mod/hooks/schedule'
import type { Batch, Tip } from '../mod/hooks/reply'

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }))

const contextJSON = JSON.stringify({
  version: 1, issue_identifier: 'OL-1283', light_tip_count: 3, check_every_steps: 6,
  existing_tips: [{ id: 'old', tag: 'you_should_know', line: 'Known fact' }], known_topics: ['Known topic'],
})
const context = parseContext(contextJSON)!
const lightReply = JSON.stringify({ tips: [{ title: 'Cache', line: 'Cache expiry duplicates refreshes', explanation: 'No single-flight lock.' }], overturned: [{ tip_id: 'old', reason: 'The contract changed.' }] })

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks() })

function setup(advisor = false) {
  vi.stubEnv('MULTICA_YSK_CONTEXT_FILE', '/task/ysk/context.json')
  vi.stubEnv('MULTICA_OMP_YSK_EXTENSION', '/task/ysk/plugin/hooks/omp.ts')
  vi.stubEnv('MULTICA_OMP_YSK_ADVISOR', String(advisor))
  vi.mocked(readFileSync).mockReturnValue(contextJSON)
  vi.mocked(existsSync).mockReturnValue(false)
  const frames: Batch[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
    const frame = JSON.parse(String(line))
    expect(frame.type).toBe('labrastro_ysk')
    frames.push(frame.batch)
    return true
  })
  const handlers = new Map<string, (event: any, ctx: any) => unknown>()
  const api = { on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler) }
  omp(api as Parameters<typeof omp>[0])
  const ctx = {
    agent: { kind: 'main', id: 'Main' },
    runEphemeralTurn: vi.fn(async ({ promptText }: { promptText: string }) => ({ replyText: promptText.includes('Up to 3 tips') ? lightReply : '{"heads_up":null}' })),
  }
  const fire = (name: string, event = {}, agentCtx = ctx) => handlers.get(name)?.(event, agentCtx)
  const turn = async (toolName = 'read', input: Record<string, unknown> = { path: 'server/login.go' }, isError = false, agentCtx = ctx) => {
    fire('turn_start', {}, agentCtx)
    fire('tool_result', { toolName, input, isError }, agentCtx)
    fire('turn_end', {}, agentCtx)
    await Promise.resolve()
  }
  fire('session_start')
  const notes = (notes: unknown[]) => fire('message_end', { message: { role: 'custom', customType: 'advisor', details: { notes } } })
  return { ctx, fire, turn, frames, notes }
}

describe('shared exploration schedule', () => {
  it.each([
    { rounds: [0], lightStep: 7 },
    { rounds: [0, 2], lightStep: 7 },
    { rounds: [0, 2, 3], lightStep: 5 },
  ])('waits for enough sparse exploration rounds: $rounds', ({ rounds, lightStep }) => {
    const plan = new Schedule(0)
    const asked: number[] = []
    for (let step = 0; step < 12; step++) {
      expect(plan.begin()).toBe(step)
      if (plan.decide(step) === 'light') asked.push(step)
      plan.end(step, rounds.includes(step))
    }
    expect(asked).toEqual([lightStep])
  })

  it('excludes platform metadata and directory setup, including mixed commands', () => {
    for (const command of ['multica issue get x --output json', 'multica issue get x | head -20', 'multica issue comment list x', 'multica repo checkout x', 'pwd && ls', 'git status --short']) {
      expect(isExploration('bash', { command })).toBe(false)
    }
    for (const command of ['rg schema server', 'sed -n 1,40p src/main.go', 'git diff main', 'go test ./...', 'python3 -c \"import auth; print(auth.check())\"', 'multica issue get x && cat src/main.go']) {
      expect(isExploration('Bash', { command })).toBe(true)
    }
    expect(isExploration('read', { path: 'main.go' })).toBe(true)
    expect(isExploration('task', {})).toBe(false)
    for (const path of ['AGENTS.md', '/task/CLAUDE.md', 'issue.md', 'C:\\task\\SKILL.md']) expect(isExploration('Read', { file_path: path })).toBe(false)
  })

  it('counts exploration rounds once and falls back at the eighth step', () => {
    const plan = new Schedule(6)
    const asks: number[] = []
    for (let step = 0; step < 60; step++) {
      expect(plan.begin()).toBe(step)
      if (plan.decide(step)) asks.push(step)
      plan.end(step, false)
    }
    expect(asks).toEqual([7, 13, 25, 49])
  })
})

describe('OMP extension', () => {
  it('waits for three source rounds, emits privately and backs off 6→12→24', async () => {
    const w = setup()
    const asked: number[] = []
    for (let step = 0; step < 50; step++) {
      const before = w.ctx.runEphemeralTurn.mock.calls.length
      await w.turn(step < 2 ? 'bash' : 'read', step < 2 ? { command: 'multica issue get x' } : { path: 'main.go' })
      if (w.ctx.runEphemeralTurn.mock.calls.length > before) asked.push(step)
    }
    expect(asked).toEqual([6, 12, 24, 48])
    expect(w.frames).toMatchObject([{ kind: 'light', step: 6, overturned: [{ tip_id: 'old' }] }])
    for (const [request] of w.ctx.runEphemeralTurn.mock.calls) expect(request).toMatchObject({ tools: false, minimizeEffort: true, signal: expect.any(AbortSignal) })
    for (const name of ['MULTICA_YSK_CONTEXT_FILE', 'MULTICA_OMP_YSK_EXTENSION', 'MULTICA_OMP_YSK_ADVISOR']) expect(process.env[name]).toBeUndefined()
  })

  it('does not count failed tools or subagent and clone turns', async () => {
    const w = setup()
    for (let i = 0; i < 10; i++) await w.turn('read', {}, false, { ...w.ctx, agent: { kind: 'sub', id: 'clone' } })
    for (let i = 0; i < 7; i++) await w.turn('read', {}, true)
    expect(w.ctx.runEphemeralTurn).not.toHaveBeenCalled()
    await w.turn('read', {}, true)
    expect(w.frames[0]?.step).toBe(7)
  })

  it('keeps the opening turn with Advisor, consumes delivered notes, and never polls heads-up', async () => {
    const w = setup(true)
    for (let i = 0; i < 80; i++) await w.turn()
    expect(w.ctx.runEphemeralTurn).toHaveBeenCalledTimes(1)
    w.notes([{ severity: 'nit', note: 'Index excludes archived rows.' }, { severity: 'concern', note: 'Concurrent refresh can lose updates.' }])
    w.notes([{ severity: 'nit', note: 'Index excludes archived rows.' }, { severity: 'blocker', note: 'A second warning exceeds quota.' }])
    expect(w.frames.map((batch) => batch.tips[0]?.tag)).toEqual(['you_should_know', 'you_should_know', 'heads_up'])
    expect(w.frames[2]?.kind).toBe('heads_up')
  })

  it('shares the three light / one heads-up quota across early notes and a pending light', async () => {
    const w = setup(true)
    w.notes(['A', 'B', 'C', 'D'].map((note) => ({ note, severity: 'nit' })))
    for (let i = 0; i < 8; i++) await w.turn()
    expect(w.ctx.runEphemeralTurn).toHaveBeenCalledTimes(1)
    expect(w.frames.flatMap((batch) => batch.tips)).toHaveLength(3)
    expect(w.frames.at(-1)?.overturned).toEqual([{ tip_id: 'old', reason: 'The contract changed.' }])
  })

  it('stops heads-up polling when Advisor is first discovered during the session', async () => {
    const w = setup(false)
    for (let i = 0; i < 6; i++) await w.turn()
    expect(w.ctx.runEphemeralTurn).toHaveBeenCalledTimes(1)
    w.notes([{ severity: 'nit', note: 'The index excludes archived rows.' }])
    for (let i = 6; i < 80; i++) await w.turn()
    expect(w.ctx.runEphemeralTurn).toHaveBeenCalledTimes(1)
    expect(w.frames.map((batch) => batch.kind)).toEqual(['light', 'light'])
  })

  it('a delivered Advisor warning takes the quota before an older side answer settles', async () => {
    const w = setup()
    for (let i = 0; i < 5; i++) await w.turn()
    let resolve!: (result: { replyText: string }) => void
    w.ctx.runEphemeralTurn.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    for (let i = 5; i <= 10; i++) await w.turn()
    w.notes([{ severity: 'blocker', note: 'The migration loses data.' }])
    resolve({ replyText: '{"heads_up":{"title":"Other risk","line":"A stale warning","explanation":"Already reviewed"}}' })
    await Promise.resolve()
    expect(w.frames.map((batch) => batch.kind)).toEqual(['light', 'heads_up'])
    expect(w.frames[1]?.tips[0]?.line).toBe('The migration loses data.')
  })

  it('hosts without ephemeral turns can still deliver Advisor notes without throwing', async () => {
    const w = setup(true)
    const ctx = { ...w.ctx, runEphemeralTurn: undefined } as unknown as typeof w.ctx
    for (let i = 0; i < 12; i++) await w.turn('read', {}, false, ctx)
    w.notes([{ severity: 'nit', note: 'The index excludes archived rows.' }])
    expect(w.ctx.runEphemeralTurn).not.toHaveBeenCalled()
    expect(w.frames).toHaveLength(1)
  })

  it('silently contains unavailable side turns, rejections, parse errors and reporting failures', async () => {
    const w = setup()
    w.ctx.runEphemeralTurn.mockRejectedValueOnce(new Error('provider failure'))
    w.ctx.runEphemeralTurn.mockResolvedValueOnce({ replyText: 'invalid JSON' })
    w.ctx.runEphemeralTurn.mockResolvedValueOnce({ replyText: '{"heads_up":{"title":"Risk","line":"Data is stale","explanation":"No expiry check"}}' })
    for (let i = 0; i < 30; i++) await w.turn()
    expect(w.frames).toHaveLength(1)
    expect(w.frames[0]?.kind).toBe('heads_up')
    vi.mocked(process.stdout.write).mockImplementationOnce(() => { throw new Error('output failure') })
    expect(() => w.notes([{ note: 'A nit' }])).not.toThrow()
    expect(() => w.fire('message_end', { message: null })).not.toThrow()
  })

  it('does not wait for a side turn and cancels it on shutdown', async () => {
    const w = setup()
    w.ctx.runEphemeralTurn.mockImplementation(() => new Promise(() => {}))
    for (let i = 0; i < 10; i++) await w.turn()
    expect(w.ctx.runEphemeralTurn).toHaveBeenCalledTimes(1)
    const request = w.ctx.runEphemeralTurn.mock.calls[0]![0] as unknown as { signal: AbortSignal }
    w.fire('session_shutdown')
    expect(request.signal.aborted).toBe(true)
    w.notes([{ note: 'After shutdown' }])
    expect(w.frames).toEqual([])
  })

  it('a stop file disables both new side turns and Advisor reports for the run', async () => {
    const w = setup(true)
    vi.mocked(existsSync).mockReturnValue(true)
    await w.turn()
    vi.mocked(existsSync).mockReturnValue(false)
    for (let i = 0; i < 40; i++) await w.turn()
    w.notes([{ note: 'Should not appear' }])
    expect(w.frames).toEqual([])
    expect(w.ctx.runEphemeralTurn).not.toHaveBeenCalled()
  })

  it('unusable context leaves the extension off', async () => {
    const w = setup()
    vi.stubEnv('MULTICA_YSK_CONTEXT_FILE', '/bad/context.json')
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error('unreadable') })
    w.fire('session_start')
    for (let i = 0; i < 40; i++) await w.turn()
    expect(w.ctx.runEphemeralTurn).not.toHaveBeenCalled()
  })
})

describe('Advisor formatting', () => {
  it.each(['nit', 'concern', 'blocker'] as const)('maps %s and clips code points to server limits', (severity) => {
    const batch = advisorBatch({ severity, note: '😀'.repeat(250) }, context, 4, [])!
    const tip = batch.tips[0]!
    expect(tip.tag).toBe(severity === 'nit' ? 'you_should_know' : 'heads_up')
    expect(charCount(tip.title)).toBe(12)
    expect(charCount(tip.line)).toBe(40)
    expect(charCount(tip.explanation)).toBe(200)
  })

  it('normalizes notes, extracts the first sentence and deduplicates against all shown tips', () => {
    const sent: Tip[] = []
    const note = { note: 'The cache is stale.\n Refresh after expiry.', severity: 'nit' }
    const tip = advisorBatch(note, context, 4, sent)!.tips[0]!
    expect(tip.line).toBe('The cache is stale.')
    expect(tip.explanation).toBe('The cache is stale. Refresh after expiry.')
    sent.push(tip)
    for (const candidate of [note, { note: 'ＴＨＥ cache is stale.' }, { note: 'known FACT' }, { note: 'Known topic' }, { note: '\u0000' }, { note: 'x', severity: 'other' }, null]) {
      expect(advisorBatch(candidate, context, 5, sent)).toBeUndefined()
    }
  })
})
