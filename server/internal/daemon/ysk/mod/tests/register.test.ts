import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import { pluginDirsWithout } from '../hooks/register'
import type { ModelForkResult, On, TurnStepResult } from 'claude-code'

// The hooks against the engine: the test's own hooks stand for the model,
// the filesystem and the environment beneath the mod.

const CONTEXT = JSON.stringify({
  version: 1,
  issue_identifier: 'OL-123',
  anchor_comment_id: null,
  latest_human_comment: 'Please move login to SMS codes.',
  existing_tips: [{ id: 'tip-1', tag: 'you_should_know', line: 'Login uses passwords today' }],
  known_topics: [],
  light_tip_count: 3,
  check_every_steps: 3,
  limits: { line: 40, title: 12, explanation: 200 },
})

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const LIGHT_REPLY = JSON.stringify({
  tips: [{ title: 'SMS login', line: 'The Engineer agent adds SMS codes', explanation: 'Users sign in with a code.' }],
  overturned: [{ tip_id: 'tip-1', reason: 'Passwords are being replaced.' }],
})

type World = {
  logs: string[]
  debug: string[]
  forks: string[]
  envSets: Array<[string, string | undefined]>
  stopReads: string[]
  stopFile: 'missing' | 'present' | 'unreadable'
  /** Tool calls the next main-thread response asks for. */
  tools: number
  /** How the next fork answers; a pending promise models a slow fork. */
  answer: (prompt: string) => ModelForkResult | Promise<ModelForkResult>
  /** Lets unawaited work (a fork's answer, its log line) run to the end. */
  settle: () => Promise<void>
}

function setUp(on: On, options: { env?: Record<string, string>; context?: string; unreadable?: boolean } = {}): World {
  const world: World = {
    logs: [],
    debug: [],
    forks: [],
    envSets: [],
    stopReads: [],
    stopFile: 'missing',
    tools: 1,
    answer: () => ({ isAnswered: true, text: '{"heads_up":null}', usage: USAGE }),
    settle: async () => {},
  }
  mock.env(on, options.env ?? {
    MULTICA_YSK_CONTEXT_FILE: '/task/multica-config/ysk/context.json',
    MULTICA_AGENT_NAME: 'Engineer',
  })
  const clock = mock.clock(on, { now: 1_000 })
  world.settle = () => clock.settle()
  on('fs.read', async ($, e) => {
    if (e.path.endsWith('/stop') || e.path.endsWith('\\stop')) {
      world.stopReads.push(e.path)
      return world.stopFile === 'present'
        ? { value: '' }
        : { deny: world.stopFile === 'unreadable' ? 'EACCES: permission denied' : 'ENOENT: no such file' }
    }
    return options.unreadable === true ? { deny: 'ENOENT: no such file' } : { value: options.context ?? CONTEXT }
  })
  on('env.set', async ($, e) => {
    world.envSets.push([e.name, e.value])
    return { value: undefined }
  })
  on('ui.log', async ($, e) => {
    ;(e.to === 'debug' ? world.debug : world.logs).push(e.text)
    return { value: undefined }
  })
  on('model.fork', async ($, e) => {
    world.forks.push(e.prompt)
    return { value: await world.answer(e.prompt) }
  })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* ($, e) {
    const toolUses = Array.from({ length: e.agentId === undefined ? world.tools : 0 }, () => ({ name: 'Bash', input: {} }))
    return { turnId: e.turnId, index: e.index, answer: '', toolUses, stopReason: toolUses.length > 0 ? 'tool_use' : 'end_turn', usage: null }
  })
  return world
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/task/workdir', surface: null, isInteractive: false })
}

async function step($: Engine, index: number, agentId?: string): Promise<TurnStepResult> {
  const stream = $.turn.step({ turnId: 'turn-1', index, model: 'claude-test', messageCount: 10 + index, ...(agentId === undefined ? {} : { agentId }) })
  for (;;) {
    const next = await stream.next()
    if (next.done === true) return next.value
  }
}

const kinds = (logs: string[]) => logs.map((line) => (JSON.parse(line) as { kind: string }).kind)

describe('labrastro-ysk hooks', () => {
  test('a stop marker prevents the first fork and is never read again', async ($, on) => {
    const world = setUp(on)
    world.stopFile = 'present'
    await start($)
    await step($, 0)
    await step($, 1)
    expect(world.stopReads).toEqual([])
    expect((await step($, 2)).index).toBe(2)
    // Removing the marker cannot re-enable this run.
    world.stopFile = 'missing'
    for (let i = 3; i < 40; i++) await step($, i)
    expect(world.stopReads).toEqual(['/task/multica-config/ysk/stop'])
    expect(world.forks).toEqual([])
  })

  test('closing during a fork lets its answer finish but prevents later forks', async ($, on) => {
    const world = setUp(on)
    let release: (result: ModelForkResult) => void = () => {}
    world.answer = () => new Promise<ModelForkResult>((resolve) => { release = resolve })
    await start($)
    for (let i = 0; i <= 2; i++) await step($, i)
    world.stopFile = 'present'
    // At step 32 the old fork is stale, so this would start a new fork.
    for (let i = 3; i <= 32; i++) await step($, i)
    expect(world.stopReads).toHaveLength(2)
    expect(world.forks).toHaveLength(1)
    release({ isAnswered: true, text: LIGHT_REPLY, usage: USAGE })
    await world.settle()
    expect(kinds(world.logs)).toEqual(['light'])
    for (let i = 33; i < 40; i++) await step($, i)
    expect(world.stopReads).toHaveLength(2)
    expect(world.forks).toHaveLength(1)
  })

  test('an unreadable stop marker does not block forks or main steps', async ($, on) => {
    const world = setUp(on)
    world.stopFile = 'unreadable'
    await start($)
    for (let i = 0; i <= 5; i++) {
      expect((await step($, i)).index).toBe(i)
      await world.settle()
    }
    expect(world.forks).toHaveLength(2)
    expect(world.stopReads).toHaveLength(2)
    world.stopFile = 'present'
    for (let i = 6; i <= 8; i++) await step($, i)
    expect(world.forks).toHaveLength(2)
    expect(world.stopReads).toHaveLength(3)
  })

  test('the stop marker is a sibling of the context file on Windows', async ($, on) => {
    const world = setUp(on, { env: { MULTICA_YSK_CONTEXT_FILE: 'C:\\task\\ysk\\context.json' } })
    world.stopFile = 'present'
    await start($)
    for (let i = 0; i <= 2; i++) await step($, i)
    expect(world.stopReads).toHaveLength(1)
    // The Linux test engine resolves Windows spellings relative to the mod.
    expect(world.stopReads[0]?.endsWith('C:\\task\\ysk\\stop')).toBe(true)
    expect(world.forks).toEqual([])
  })

  test('without a context file the mod stays off', async ($, on) => {
    const world = setUp(on, { env: {} })
    await start($)
    for (let i = 0; i < 10; i++) await step($, i)
    expect(world.forks).toEqual([])
    expect(world.logs).toEqual([])
  })

  test('an unusable context file keeps the mod off', async ($, on) => {
    const world = setUp(on, { context: '{"version":2}' })
    await start($)
    for (let i = 0; i < 10; i++) await step($, i)
    expect(world.forks).toEqual([])
    expect(world.logs).toEqual([])
  })

  test('the context variables leave the environment once read', async ($, on) => {
    const world = setUp(on, {
      env: {
        MULTICA_YSK_CONTEXT_FILE: '/task/multica-config/ysk/context.json',
        CLAUDE_CODE_PLUGIN_DIRS: '/opt/user-plugin',
      },
    })
    await start($)
    expect(world.envSets).toEqual([
      ['MULTICA_YSK_CONTEXT_FILE', undefined],
      ['CLAUDE_CODE_PLUGIN_DIRS', '/opt/user-plugin'],
    ])
  })

  test('a context file that cannot be read still leaves the environment', async ($, on) => {
    const world = setUp(on, {
      unreadable: true,
      env: { MULTICA_YSK_CONTEXT_FILE: '/gone/context.json', CLAUDE_CODE_PLUGIN_DIRS: '/opt/user-plugin' },
    })
    await start($)
    for (let i = 0; i < 10; i++) await step($, i)
    expect(world.envSets.map(([name]) => name)).toEqual(['MULTICA_YSK_CONTEXT_FILE', 'CLAUDE_CODE_PLUGIN_DIRS'])
    expect(world.forks).toEqual([])
  })

  test('only this mod leaves the plugin folder list', () => {
    expect(pluginDirsWithout('/opt/a:/task/ysk/plugin/:/opt/b', '/task/ysk/plugin')).toBe('/opt/a:/opt/b')
    expect(pluginDirsWithout('/task/ysk/plugin', '/task/ysk/plugin/')).toBeUndefined()
    expect(pluginDirsWithout('C:\\u\\p;C:\\task\\ysk\\plugin', 'C:\\task\\ysk\\plugin')).toBe('C:\\u\\p')
    expect(pluginDirsWithout('/opt/a::', '/task/ysk/plugin')).toBe('/opt/a')
  })

  test('the light batch waits until a fork can see the first tool result', async ($, on) => {
    const world = setUp(on)
    world.answer = () => ({ isAnswered: true, text: LIGHT_REPLY, usage: USAGE })
    await start($)

    world.tools = 0
    await step($, 0) // a reply without tools: nothing for a fork to see yet
    world.tools = 1
    await step($, 1) // the first tool call
    await step($, 2) // its result is in this request, not yet in a fork's view
    await world.settle()
    expect(world.forks).toEqual([])

    await step($, 3)
    await world.settle()
    expect(world.forks).toHaveLength(1)
    expect(world.forks[0]).toContain('Up to 3 tips')
    expect(world.logs.map((line) => JSON.parse(line))).toEqual([{
      ysk: 1,
      kind: 'light',
      tips: [{ tag: 'you_should_know', line: 'The Engineer agent adds SMS codes', title: 'SMS login', explanation: 'Users sign in with a code.' }],
      overturned: [{ tip_id: 'tip-1', reason: 'Passwords are being replaced.' }],
      step: 3,
    }])
  })

  test('heads-up checks run every check_every_steps steps until one is found', async ($, on) => {
    const world = setUp(on)
    let headsUpChecks = 0
    world.answer = (prompt) => {
      if (prompt.includes('Up to 3 tips')) return { isAnswered: true, text: '{"tips":[],"overturned":[]}', usage: USAGE }
      headsUpChecks++
      const text = headsUpChecks < 2
        ? '{"heads_up":null}'
        : JSON.stringify({ heads_up: { title: 'Cost', line: 'The agent reruns the full suite', explanation: 'Each run costs an hour.' } })
      return { isAnswered: true, text, usage: USAGE }
    }
    await start($)
    for (let i = 0; i < 20; i++) {
      await step($, i)
      await world.settle()
    }
    // Light at step 2, then checks at 5 and 8; the one at 8 finds a heads-up.
    expect(world.forks.map((prompt) => (prompt.includes('Up to 3 tips') ? 'light' : 'heads_up'))).toEqual(['light', 'heads_up', 'heads_up'])
    expect(kinds(world.logs)).toEqual(['heads_up'])
    expect(JSON.parse(world.logs[0] ?? '{}')).toMatchObject({ kind: 'heads_up', step: 8, overturned: [], tips: [{ tag: 'heads_up', title: 'Cost' }] })
  })

  test('a fork is never awaited by the step that started it', async ($, on) => {
    const world = setUp(on)
    let release: (result: ModelForkResult) => void = () => {}
    world.answer = () => new Promise<ModelForkResult>((resolve) => { release = resolve })
    await start($)
    await step($, 0)
    await step($, 1)
    const response = await step($, 2) // starts the light fork, which hangs
    expect(response.index).toBe(2)
    expect(world.forks).toHaveLength(1)

    // While it hangs, later steps go on and no second fork starts.
    for (let i = 3; i < 9; i++) await step($, i)
    expect(world.forks).toHaveLength(1)

    release({ isAnswered: true, text: LIGHT_REPLY, usage: USAGE })
    await world.settle()
    expect(kinds(world.logs)).toEqual(['light'])
    await step($, 9)
    await world.settle()
    expect(world.forks).toHaveLength(2)
  })

  test('a fork that never answers stops holding back checks after 30 steps', async ($, on) => {
    const world = setUp(on)
    world.answer = () => new Promise<ModelForkResult>(() => {})
    await start($)
    for (let i = 0; i < 40; i++) await step($, i)
    // The light fork at step 2 never settles; the next check waits until step 32.
    expect(world.forks.map((prompt) => (prompt.includes('Up to 3 tips') ? 'light' : 'heads_up'))).toEqual(['light', 'heads_up'])
  })

  test('an answer from a given-up fork is ignored, so a run sends one heads-up at most', async ($, on) => {
    const world = setUp(on)
    await start($)
    for (let i = 0; i <= 2; i++) {
      await step($, i)
      await world.settle()
    }
    const releases: Array<(result: ModelForkResult) => void> = []
    world.answer = () => new Promise<ModelForkResult>((resolve) => { releases.push(resolve) })
    // The check at step 5 hangs; at step 35 it is given up and step 35 checks again.
    for (let i = 3; i <= 35; i++) await step($, i)
    expect(releases).toHaveLength(2)
    const headsUp = (title: string, line: string) => ({ isAnswered: true as const, text: JSON.stringify({ heads_up: { title, line, explanation: 'It matters.' } }), usage: USAGE })
    releases[1]?.(headsUp('Cost', 'The agent reruns the full suite'))
    await world.settle()
    releases[0]?.(headsUp('Data loss', 'The agent deletes the old table'))
    await world.settle()
    expect(world.logs.map((line) => JSON.parse(line) as { kind: string; tips: Array<{ title: string }> })).toMatchObject([{ kind: 'heads_up', tips: [{ title: 'Cost' }] }])
  })

  test('a light answer that arrives after its fork was given up is ignored', async ($, on) => {
    const world = setUp(on)
    const releases: Array<(result: ModelForkResult) => void> = []
    world.answer = () => new Promise<ModelForkResult>((resolve) => { releases.push(resolve) })
    await start($)
    for (let i = 0; i <= 32; i++) await step($, i) // light at 2, given up at 32 by a heads-up check
    expect(releases).toHaveLength(2)
    releases[0]?.({ isAnswered: true, text: LIGHT_REPLY, usage: USAGE })
    await world.settle()
    expect(world.logs).toEqual([])
  })

  test('a given-up fork still counts while no newer fork has started', async ($, on) => {
    const world = setUp(on, { context: JSON.stringify({ ...JSON.parse(CONTEXT), check_every_steps: 0 }) })
    let release: (result: ModelForkResult) => void = () => {}
    world.answer = () => new Promise<ModelForkResult>((resolve) => { release = resolve })
    await start($)
    for (let i = 0; i <= 40; i++) await step($, i) // no heads-up checks, so nothing replaces the light fork
    expect(world.forks).toHaveLength(1)
    release({ isAnswered: true, text: LIGHT_REPLY, usage: USAGE })
    await world.settle()
    expect(kinds(world.logs)).toEqual(['light'])
  })

  test('a heads-up never repeats a tip this run already sent, and the question lists them', async ($, on) => {
    const world = setUp(on)
    world.answer = (prompt) => ({
      isAnswered: true,
      text: prompt.includes('Up to 3 tips')
        ? LIGHT_REPLY
        : JSON.stringify({ heads_up: { title: 'SMS login', line: 'The Engineer agent adds SMS codes', explanation: 'Users sign in with a code.' } }),
      usage: USAGE,
    })
    await start($)
    for (let i = 0; i <= 5; i++) {
      await step($, i)
      await world.settle()
    }
    expect(kinds(world.logs)).toEqual(['light'])
    expect(world.forks[0]).toContain('Tips already shown during this run, as JSON: []')
    expect(world.forks[1]).toContain('Tips already shown during this run, as JSON: [{"tag":"you_should_know","line":"The Engineer agent adds SMS codes"}]')
  })

  test('fork failures produce no tips and leave the steps alone', async ($, on) => {
    const world = setUp(on)
    const failures: Array<() => ModelForkResult | Promise<ModelForkResult>> = [
      () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }),
      () => ({ isAnswered: false, reason: 'empty-reply', usage: USAGE }),
      () => Promise.reject(new Error('blocked model')),
      () => ({ isAnswered: true, text: 'not json at all', usage: USAGE }),
    ]
    world.answer = () => (failures.shift() ?? (() => ({ isAnswered: false, reason: 'aborted', usage: USAGE })))()
    await start($)
    for (let i = 0; i < 16; i++) {
      const response = await step($, i)
      expect(response.index).toBe(i)
      await world.settle()
    }
    expect(world.forks.length).toBeGreaterThan(3)
    expect(world.logs).toEqual([])
  })

  test('subagent steps are neither counted nor forked', async ($, on) => {
    const world = setUp(on)
    world.answer = () => ({ isAnswered: true, text: LIGHT_REPLY, usage: USAGE })
    await start($)
    await step($, 0)
    for (let i = 0; i < 10; i++) await step($, i, 'agent-7')
    await world.settle()
    expect(world.forks).toEqual([])
    await step($, 1)
    await step($, 2)
    await world.settle()
    expect(world.forks).toHaveLength(1)
  })
})
