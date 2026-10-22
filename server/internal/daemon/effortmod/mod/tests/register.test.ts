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
  /** Entries each upcoming main step appends to the session when it answers. */
  stepOutput: SessionMessages[]
  marker: 'missing' | 'present'
  answer: (fetch: Fetch) => { status: number; text: string } | Promise<{ status: number; text: string }>
  /** The session's entries; grows as main steps complete (turn.step below
   * appends each step's entries when its response is produced). */
  session: SessionMessages
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
    stepOutput: [],
    answer: () => ({ status: 200, text: GOOD_DECISION }),
    session: [{ role: 'user', text: 'issue' }],
    messages: () => world.session,
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
    if (e.agentId === undefined) {
      // The real host has a step's entries in the conversation by the time
      // the next step starts (they exist once the step's request produced
      // them); emulate that by appending this step's output as it begins.
      const output = world.stepOutput.shift()
      if (output) world.session.push(...output)
    }
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

// The host's real shape (OL-1000 r2-sonnet55): one request's output arrives
// as a text entry followed by one entry per tool use, then the user entry
// carrying their results.
const LAST_STEP: SessionMessages = [
  { role: 'user', text: 'issue' },
  { role: 'assistant', text: '先跑测试，再读一下 a.go。' },
  {
    role: 'assistant',
    toolUses: [
      { tool_use_id: 't1', tool: 'Bash', input: { command: 'go test ./...' }, text: 'Exit code 1\nFAIL: build failed', isError: true },
    ],
  },
  {
    role: 'assistant',
    toolUses: [
      { tool_use_id: 't2', tool: 'Read', input: { file_path: 'a.go' }, text: 'package a' },
    ],
  },
  {
    role: 'user',
    toolResults: [
      { tool_use_id: 't1' },
      { tool_use_id: 't2' },
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
    world.stepOutput.push(LAST_STEP)
    await start($)
    await step($, 0) // step 1 runs its tools; its output becomes step 2's material
    expect((await step($, 1)).effort).toBe('high')
    expect(world.fetches).toHaveLength(1)
    expect(world.fetches[0]?.url).toBe('http://127.0.0.1:8619/tasks/task-1/thinking-decision')
    expect(world.fetches[0]?.init?.headers?.authorization).toBe('Bearer mat_test')
    const body = JSON.parse(world.fetches[0]?.init?.body ?? '{}')
    expect(body.step).toBe(2)
    expect(body.assistant_text).toBe('先跑测试，再读一下 a.go。')
    expect(body.tools).toEqual([
      { name: 'Bash', is_error: true, is_file_content: false, input_summary: 'go test ./...', result_text: 'Exit code 1\nFAIL: build failed' },
      { name: 'Read', is_error: false, is_file_content: true, input_summary: 'a.go', result_text: 'package a' },
    ])
    expect(body.error_text).toBe('Exit code 1\nFAIL: build failed')
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

  test('an empty startup effort passes steps through until a decision lands', async ($, on) => {
    const world = setUp(on, { context: JSON.stringify({ version: 1, task_id: 'task-1', endpoint: '/tasks/task-1/thinking-decision', startup_effort: '' }) })
    await start($)
    // Step 1 has no level in effect: pass through untouched.
    expect((await step($, 0)).effort).toBeUndefined()
    // Step 2 decides; from here every step carries a level.
    expect((await step($, 1)).effort).toBe('high')
    expect(JSON.parse(world.logs[0] ?? '{}')).toMatchObject({ step: 2, level: 'high' })
    // A fallback before any level landed records an empty level.
    world.answer = () => ({ status: 200, text: FALLBACK_DECISION })
    expect((await step($, 2)).effort).toBe('high')
    expect(JSON.parse(world.logs[1] ?? '{}')).toMatchObject({ step: 3, level: 'high', fallback: 'timeout' })
  })

  test('a run-level fallback records an empty level on the first fallback', async ($, on) => {
    const world = setUp(on, { context: JSON.stringify({ version: 1, task_id: 'task-1', endpoint: '/tasks/task-1/thinking-decision', startup_effort: '' }) })
    world.answer = () => ({ status: 200, text: FALLBACK_DECISION })
    await start($)
    await step($, 0)
    expect((await step($, 1)).effort).toBeUndefined()
    expect(JSON.parse(world.logs[0] ?? '{}')).toEqual({ effort: 1, step: 2, level: '', fallback: 'timeout' })
  })

  test('a 401 from the endpoint locks the level and stops asking', async ($, on) => {
    const world = setUp(on)
    await start($)
    await step($, 0)
    expect((await step($, 1)).effort).toBe('high')
    world.answer = () => ({ status: 401, text: 'thinking decision requires an active task credential' })
    expect((await step($, 2)).effort).toBe('high')
    for (let i = 3; i < 6; i++) await step($, i)
    expect(world.fetches).toHaveLength(2)
    // The 401 answered disabled: no effect record for it.
    expect(world.logs).toHaveLength(1)
  })

  test('the window covers only the previous step, not the whole run', async ($, on) => {
    const world = setUp(on)
    await start($)
    // Step 1 fails a build; steps 2+ succeed.
    world.stepOutput.push([
      { role: 'assistant', text: 'building' },
      { role: 'assistant', toolUses: [{ tool_use_id: 'e1', tool: 'Bash', input: { command: 'go build ./...' }, text: 'Exit code 1\nundefined: Foo', isError: true }] },
      { role: 'user', toolResults: [{ tool_use_id: 'e1' }] },
    ])
    await step($, 0)
    // Step 2's request carries step 1's error once. Its own output (queued
    // now, appended as the step answers) succeeds.
    world.stepOutput.push([{ role: 'assistant', text: 'fixed, running again' }, { role: 'assistant', toolUses: [{ tool_use_id: 'e2', tool: 'Bash', input: { command: 'go test ./...' }, text: 'ok' }] }, { role: 'user', toolResults: [{ tool_use_id: 'e2' }] }])
    expect((await step($, 1)).effort).toBe('high')
    expect(JSON.parse(world.fetches[0]?.init?.body ?? '{}')).toMatchObject({ step: 2, error_text: 'Exit code 1\nundefined: Foo' })
    // Steps 3 and 4 succeed: their material must not mention the old error.
    world.stepOutput.push([{ role: 'assistant', text: 'done' }])
    await step($, 2)
    const body3 = JSON.parse(world.fetches[1]?.init?.body ?? '{}')
    expect(body3.step).toBe(3)
    expect(body3.error_text).toBe('')
    expect(body3.tools.map((t: { name: string }) => t.name)).toEqual(['Bash'])
    expect(body3.assistant_text).toBe('fixed, running again')
    await step($, 3)
    const body4 = JSON.parse(world.fetches[2]?.init?.body ?? '{}')
    expect(body4.step).toBe(4)
    expect(body4.error_text).toBe('')
    expect(body4.tools).toEqual([])
    expect(body4.assistant_text).toBe('done')
  })

  test('without a context file the mod stays off', async ($, on) => {
    const world = setUp(on, { env: {} })
    await start($)
    for (let i = 0; i < 4; i++) expect((await step($, i)).effort).toBeUndefined()
    expect(world.fetches).toEqual([])
  })
})

describe('labrastro-effort helpers', () => {
  test('stepPayload collects the previous step\'s split assistant entries', () => {
    const payload = stepPayload(3, LAST_STEP)
    expect(payload.step).toBe(3)
    expect(payload.assistant_text).toBe('先跑测试，再读一下 a.go。')
    expect(payload.tools).toHaveLength(2)
    expect(payload.tools[0]).toMatchObject({ name: 'Bash', is_error: true })
    expect(payload.tools[1]).toMatchObject({ name: 'Read', is_file_content: true })
    expect(payload.error_text).toBe('Exit code 1\nFAIL: build failed')
  })

  test('stepPayload marks file-content tools and stops before earlier steps', () => {
    // An earlier step's entries stay out.
    const payload = stepPayload(4, [{ role: 'assistant', text: 'old' }, ...LAST_STEP])
    expect(payload.assistant_text).toBe('先跑测试，再读一下 a.go。')
  })

  test('stepPayload walks back through interleaved user result entries', () => {
    // The shape a real 2.1.304 run delivered for a parallel Read+Bash step:
    // [asst Read][user result t1][asst Bash][user result t2].
    const interleaved: SessionMessages = [
      { role: 'user', text: 'issue' },
      { role: 'assistant', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.go' }, text: 'package a' }] },
      { role: 'user', toolResults: [{ tool_use_id: 't1' }] },
      { role: 'assistant', toolUses: [{ tool_use_id: 't2', tool: 'Bash', input: { command: 'go test' }, text: 'FAIL', isError: true }] },
      { role: 'user', toolResults: [{ tool_use_id: 't2' }] },
    ]
    const payload = stepPayload(2, interleaved)
    expect(payload.tools.map((t) => t.name)).toEqual(['Read', 'Bash'])
    expect(payload.tools[0]).toMatchObject({ is_file_content: true })
    expect(payload.tools[1]).toMatchObject({ is_error: true })
    expect(payload.error_text).toBe('FAIL')
  })

  test('stepPayload ships whole lines: no partial credentials, tail errors survive', () => {
    const conn = 'postgres://app:reviewcanary@db.internal:5432/orders'
    // A credential line inside a long result crosses no line boundary.
    const long: string[] = []
    for (let i = 0; i < 40; i++) long.push(`progress line ${i} done`)
    const result = long.concat([conn, 'Exit code 1', 'FAIL: TAIL_CANARY missing']).join('\n')
    const payload = stepPayload(2, [
      { role: 'user', text: 'issue' },
      { role: 'assistant', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'go test' }, text: result, isError: true }] },
      { role: 'user', toolResults: [{ tool_use_id: 't1' }] },
    ])
    const text = payload.tools[0]?.result_text ?? ''
    // The whole credential line ships (the daemon redacts it); it is never cut.
    expect(text).toContain(conn)
    // The tail error survives the mod's budget; the daemon keeps it in result_tail.
    expect(text).toContain('FAIL: TAIL_CANARY missing')
    expect(payload.error_text).toContain('TAIL_CANARY')
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

  test('clip keeps whole lines and never a partial secret line', () => {
    expect(clip(undefined, 5)).toBe('')
    expect(clip('abc', 5)).toBe('abc')
    // Multi-line: whole lines up to the budget.
    expect(clip('aaaa\nbbbb\ncccc', 10)).toBe('aaaa\nbbbb')
    // A first line alone over the budget ships as nothing, not a prefix.
    expect(clip('postgres://app:reviewcanary@db.internal:5432/orders', 20)).toBe('')
    // A credential inside fitting lines survives whole for the daemon to redact.
    const line = 'postgres://app:reviewcanary@db.internal:5432/orders'
    expect(clip(line + '\nshort', 80)).toBe(line + '\nshort')
    expect(clip(line + '\nshort', 55)).toBe(line)
    // Unicode counts by code point.
    expect([...clip('你好\n世界\n再见', 5)].length).toBeLessThanOrEqual(5)
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
