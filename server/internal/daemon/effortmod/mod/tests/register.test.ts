import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import { clip, effectRecord, parseContext, pluginDirsWithout, stepPayload, type SessionMessages } from '../hooks/register'
import type { On, TurnStepResult } from 'claude-code'

// The hooks against the engine: the test's own hooks stand for the daemon's
// endpoint, the enablement marker and the environment beneath the mod.

const CONTEXT = JSON.stringify({ version: 1, task_id: 'task-1', endpoint: '/tasks/task-1/thinking-decision', startup_effort: 'medium' })

const GOOD_DECISION = JSON.stringify({ level: 'high', confidence: 0.8, probabilities: { high: 0.8, low: 0.2 }, latency_ms: 3, source: 'test' })
const FALLBACK_DECISION = JSON.stringify({ fallback: 'timeout' })
const NOT_ENABLED = JSON.stringify({ enabled: false })

type Fetch = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }

type World = {
  logs: string[]
  debug: string[]
  fetches: Fetch[]
  markerReads: number[]
  messageReads: number
  envSets: Array<[string, string | undefined]>
  marker: 'missing' | 'present'
  answer: (fetch: Fetch) => { status: number; text: string } | Promise<{ status: number; text: string }>
  messages: () => SessionMessages
  settle: () => Promise<void>
}

function setUp(on: On, options: { env?: Record<string, string>; context?: string } = {}): World {
  const world: World = {
    logs: [],
    debug: [],
    fetches: [],
    markerReads: [],
    messageReads: 0,
    envSets: [],
    marker: 'present',
    answer: () => ({ status: 200, text: GOOD_DECISION }),
    messages: () => [],
    settle: async () => {},
  }
  mock.env(on, options.env ?? {
    MULTICA_EFFORT_CONTEXT_FILE: '/task/multica-config/effort/context.json',
    MULTICA_TOKEN: 'mat_test',
    MULTICA_DAEMON_PORT: '8619',
  })
  const clock = mock.clock(on, { now: 1_000 })
  world.settle = () => clock.settle()
  on('fs.read', async ($, e) => {
    if (e.path.endsWith('context.json')) {
      return { value: options.context ?? CONTEXT }
    }
    return { deny: 'ENOENT: no such file' }
  })
  on('fs.exists', async ($, e) => {
    if (e.path.endsWith('/enabled') || e.path.endsWith('\\enabled')) {
      world.markerReads.push(clock.now())
      return { value: world.marker === 'present' }
    }
    return { value: false }
  })
  on('env.set', async ($, e) => {
    world.envSets.push([e.name, e.value])
    return { value: undefined }
  })
  on('ui.log', async ($, e) => {
    ;(e.to === 'debug' ? world.debug : world.logs).push(e.text)
    return { value: undefined }
  })
  on('http.fetch', async ($, e) => {
    const fetch: Fetch = { url: e.url, init: e.init }
    world.fetches.push(fetch)
    return { value: await world.answer(fetch) }
  })
  on('session.messages', async () => {
    world.messageReads++
    return { value: world.messages() }
  })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* ($, e) {
    const effort = (e as { effort?: string }).effort
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null, ...(effort !== undefined ? { effort } : {}) }
  })
  return world
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/task/workdir', surface: null, isInteractive: false })
}

async function step($: Engine, index: number, agentId?: string): Promise<TurnStepResult & { effort?: string }> {
  const stream = $.turn.step({ turnId: 'turn-1', index, model: 'claude-test', messageCount: 10 + index, ...(agentId === undefined ? {} : { agentId }) })
  for (;;) {
    const next = await stream.next()
    if (next.done === true) return next.value as TurnStepResult & { effort?: string }
  }
}

const LAST_STEP: SessionMessages = [
  { role: 'user', text: 'issue' },
  {
    role: 'assistant',
    text: 'running tests',
    toolUses: [
      { tool_use_id: 't1', tool: 'Bash', input: { command: 'go test ./...' }, text: 'FAIL: build failed', isError: true },
      { tool_use_id: 't2', tool: 'Read', input: { file_path: 'a.go' }, text: 'package a' },
    ],
  },
]

describe('labrastro-effort hooks', () => {
  test('step 1 carries the startup effort and asks nothing', async ($, on) => {
    const world = setUp(on)
    await start($)
    expect((await step($, 0)).effort).toBe('medium')
    expect(world.fetches).toEqual([])
    expect(world.logs).toEqual([])
  })

  test('a decision rewrites effort and writes an effect record', async ($, on) => {
    const world = setUp(on)
    world.messages = () => LAST_STEP
    await start($)
    expect((await step($, 1)).effort).toBe('high')
    expect(world.fetches).toHaveLength(1)
    expect(world.fetches[0]?.url).toBe('http://127.0.0.1:8619/tasks/task-1/thinking-decision')
    expect(world.fetches[0]?.init?.headers?.authorization).toBe('Bearer mat_test')
    const body = JSON.parse(world.fetches[0]?.init?.body ?? '{}')
    expect(body.step).toBe(2)
    expect(body.tools).toEqual([
      { name: 'Bash', is_error: true, input_summary: 'go test ./...', result_text: 'FAIL: build failed' },
      { name: 'Read', is_error: false, input_summary: 'a.go', result_text: 'package a' },
    ])
    expect(body.error_text).toBe('FAIL: build failed')
    const record = JSON.parse(world.logs[0] ?? '{}')
    expect(record).toMatchObject({ effort: 1, step: 2, level: 'high', source: 'test' })
  })

  test('a fallback keeps the last level: low → high → failure stays high', async ($, on) => {
    const world = setUp(on)
    const answers = [GOOD_DECISION, FALLBACK_DECISION]
    world.answer = () => ({ status: 200, text: answers.shift() ?? GOOD_DECISION })
    await start($)
    await step($, 0) // medium (startup)
    expect((await step($, 1)).effort).toBe('high') // decision
    expect((await step($, 2)).effort).toBe('high') // fallback keeps high, not medium
    const records = world.logs.map((line) => JSON.parse(line))
    expect(records[1]).toMatchObject({ step: 3, level: 'high', fallback: 'timeout' })
  })

  test('a mod-side timeout falls back and still records', async ($, on) => {
    const world = setUp(on)
    let release: (value: { status: number; text: string }) => void = () => {}
    world.answer = () => new Promise((resolve) => { release = resolve })
    await start($)
    await step($, 0)
    const pending = step($, 1)
    await world.settle()
    expect((await pending).effort).toBe('medium')
    expect(JSON.parse(world.logs[0] ?? '{}')).toMatchObject({ step: 2, level: 'medium', fallback: 'timeout' })
    release({ status: 200, text: GOOD_DECISION })
  })

  test('removing the marker locks the level and stops asking', async ($, on) => {
    const world = setUp(on)
    await start($)
    await step($, 0)
    expect((await step($, 1)).effort).toBe('high')
    world.marker = 'missing'
    expect((await step($, 2)).effort).toBe('high')
    for (let i = 3; i < 8; i++) expect((await step($, i)).effort).toBe('high')
    expect(world.fetches).toHaveLength(1)
    expect(world.logs).toHaveLength(1)
  })

  test('the endpoint answering not-enabled locks the level, records nothing new', async ($, on) => {
    const world = setUp(on)
    const answers = [GOOD_DECISION, NOT_ENABLED]
    world.answer = () => ({ status: 200, text: answers.shift() ?? NOT_ENABLED })
    await start($)
    await step($, 0)
    expect((await step($, 1)).effort).toBe('high')
    expect((await step($, 2)).effort).toBe('high')
    for (let i = 3; i < 6; i++) await step($, i)
    expect(world.fetches).toHaveLength(2)
    expect(world.logs).toHaveLength(1)
  })

  test('a missing marker from the start asks nothing and keeps the startup level', async ($, on) => {
    const world = setUp(on)
    world.marker = 'missing'
    await start($)
    for (let i = 0; i < 5; i++) expect((await step($, i)).effort).toBe('medium')
    expect(world.fetches).toEqual([])
    expect(world.logs).toEqual([])
  })

  test('subagent steps pass through untouched', async ($, on) => {
    const world = setUp(on)
    await start($)
    const subagent = await step($, 3, 'agent-1')
    expect(subagent.effort).toBeUndefined()
    expect(world.fetches).toEqual([])
    expect(world.logs).toEqual([])
  })

  test('the context variable leaves the environment once read', async ($, on) => {
    const world = setUp(on, {
      env: {
        MULTICA_EFFORT_CONTEXT_FILE: '/task/multica-config/effort/context.json',
        CLAUDE_CODE_PLUGIN_DIRS: '/opt/ysk-plugin',
      },
    })
    await start($)
    expect(world.envSets).toContainEqual(['MULTICA_EFFORT_CONTEXT_FILE', undefined])
    expect(world.envSets).toContainEqual(['CLAUDE_CODE_PLUGIN_DIRS', '/opt/ysk-plugin'])
  })

  test('without a context file the mod stays off', async ($, on) => {
    const world = setUp(on, { env: {} })
    await start($)
    for (let i = 0; i < 4; i++) expect((await step($, i)).effort).toBeUndefined()
    expect(world.fetches).toEqual([])
  })
})

describe('labrastro-effort helpers', () => {
  test('stepPayload reads the last assistant message, deduplicated by the host', () => {
    const payload = stepPayload(3, LAST_STEP)
    expect(payload.step).toBe(3)
    expect(payload.assistant_text).toBe('running tests')
    expect(payload.tools).toHaveLength(2)
    expect(payload.error_text).toBe('FAIL: build failed')
  })

  test('stepPayload with no assistant material stays empty', () => {
    expect(stepPayload(2, [{ role: 'user', text: 'hi' }])).toEqual({ step: 2, assistant_text: '', tools: [], error_text: '' })
    expect(stepPayload(2, undefined)).toEqual({ step: 2, assistant_text: '', tools: [], error_text: '' })
  })

  test('parseContext accepts version 1 and rejects the rest', () => {
    expect(parseContext(CONTEXT)).toEqual({ task_id: 'task-1', endpoint: '/tasks/task-1/thinking-decision', startup_effort: 'medium' })
    for (const bad of ['', 'not json', '{"version":2}', '{"version":1}', '{"version":1,"task_id":"t","endpoint":"","startup_effort":"low"}']) {
      expect(parseContext(bad)).toBeUndefined()
    }
  })

  test('clip bounds by code points', () => {
    expect(clip(undefined, 5)).toBe('')
    expect(clip('abc', 5)).toBe('abc')
    expect(clip('abcdef', 3)).toBe('abc')
    expect([...clip('你好世界再见', 4)]).toHaveLength(4)
  })

  test('effectRecord carries the decision or the fallback', () => {
    expect(JSON.parse(effectRecord({ step: 4, level: 'low' }))).toEqual({ effort: 1, step: 4, level: 'low' })
    expect(JSON.parse(effectRecord({ step: 4, level: 'low', fallback: 'error' }))).toEqual({ effort: 1, step: 4, level: 'low', fallback: 'error' })
    expect(JSON.parse(effectRecord({ step: 4, level: 'low', confidence: 0.5, latency_ms: 2 }))).toMatchObject({ confidence: 0.5, latency_ms: 2 })
  })

  test('pluginDirsWithout keeps other mods and drops the mod itself', () => {
    expect(pluginDirsWithout('/a/effort/plugin:/opt/ysk', '/a/effort/plugin')).toBe('/opt/ysk')
    expect(pluginDirsWithout('/a/effort/plugin', '/a/effort/plugin')).toBe('')
    expect(pluginDirsWithout('C:\\effort\\plugin;C:\\ysk', 'C:\\effort\\plugin')).toBe('C:\\ysk')
  })
})
