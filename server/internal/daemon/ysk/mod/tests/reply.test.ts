import { describe, expect, test } from 'claude-code/testing'
import type { YskContext } from '../hooks/context'
import { headsUpOutcome, lightBatch, replyObject } from '../hooks/reply'

const context: YskContext = {
  issueIdentifier: 'OL-123',
  latestHumanComment: 'please move login to SMS codes',
  existingTips: [
    { id: 'tip-1', tag: 'you_should_know', line: 'Login uses SMS codes' },
    { id: 'tip-2', tag: 'heads_up', line: 'Old sessions will be logged out' },
  ],
  knownTopics: [],
  lightTipCount: 2,
  checkEverySteps: 6,
  limits: { line: 40, title: 12, explanation: 200 },
}

const tip = (line: string, title = 'Title', explanation = 'Why it matters.') => ({ line, title, explanation })

describe('replyObject', () => {
  test('accepts the bare object, a fenced one, or one with a stray sentence', () => {
    expect(replyObject('{"a":1}')).toEqual({ a: 1 })
    expect(replyObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(replyObject('Here you go: {"a":1}')).toEqual({ a: 1 })
  })

  test('rejects anything that is not one JSON object', () => {
    expect(replyObject('')).toBeUndefined()
    expect(replyObject('no json here')).toBeUndefined()
    expect(replyObject('[1, 2]')).toBeUndefined()
    expect(replyObject('{"a":')).toBeUndefined()
  })
})

describe('lightBatch', () => {
  test('builds a light batch with tagged tips and overturned entries', () => {
    const text = JSON.stringify({
      tips: [tip('The Engineer agent adds a retry')],
      overturned: [{ tip_id: 'tip-2', reason: 'Sessions now survive the change.' }],
    })
    expect(lightBatch(text, context, 4)).toEqual({
      ysk: 1,
      kind: 'light',
      tips: [{ tag: 'you_should_know', line: 'The Engineer agent adds a retry', title: 'Title', explanation: 'Why it matters.' }],
      overturned: [{ tip_id: 'tip-2', reason: 'Sessions now survive the change.' }],
      step: 4,
    })
  })

  test('drops tips over the limits, repeats and anything past the count', () => {
    const text = JSON.stringify({
      tips: [
        tip('x'.repeat(41)),
        tip('Fine line', 'A title that is too long'),
        tip('Fine line', 'Title', 'e'.repeat(201)),
        tip('Login uses SMS codes'),
        tip('First'),
        tip('First'),
        { line: 'Missing title', explanation: 'x' },
        tip('Second'),
        tip('Third'),
      ],
    })
    const batch = lightBatch(text, context, 1)
    expect(batch?.tips.map((t) => t.line)).toEqual(['First', 'Second'])
  })

  test('drops a line or title that breaks across rows, and any NUL', () => {
    const text = JSON.stringify({
      tips: [
        tip('Two\nrows'),
        tip('Fine', 'Two\rrows'),
        tip('Fine', 'Title', 'Nul \u0000 inside'),
        tip('Kept', 'Title', 'An explanation\nmay wrap.'),
      ],
      overturned: [{ tip_id: 'tip-1', reason: 'nul \u0000' }],
    })
    const batch = lightBatch(text, context, 1)
    expect(batch?.tips.map((t) => t.line)).toEqual(['Kept'])
    expect(batch?.overturned).toEqual([])
  })

  test('keeps only overturned ids of shown tips, once each, with a clipped reason', () => {
    const text = JSON.stringify({
      tips: [],
      overturned: [
        { tip_id: 'unknown', reason: 'x' },
        { tip_id: 'tip-1', reason: '' },
        { tip_id: 'tip-1', reason: 'r'.repeat(250) },
        { tip_id: 'tip-1', reason: 'again' },
      ],
    })
    const batch = lightBatch(text, context, 3)
    expect(batch?.tips).toEqual([])
    expect(batch?.overturned).toEqual([{ tip_id: 'tip-1', reason: 'r'.repeat(200) }])
  })

  test('reports nothing when the reply holds nothing usable', () => {
    expect(lightBatch('{"tips":[],"overturned":[]}', context, 1)).toBeUndefined()
    expect(lightBatch('I cannot help with that.', context, 1)).toBeUndefined()
    expect(lightBatch('{"tips":"none"}', context, 1)).toBeUndefined()
  })
})

describe('headsUpOutcome', () => {
  test('null means nothing to say', () => {
    expect(headsUpOutcome('{"heads_up":null}', context, 9)).toEqual({ kind: 'none' })
  })

  test('a valid heads-up becomes a one-tip batch', () => {
    const text = JSON.stringify({ heads_up: tip('The agent deletes the old table', 'Data loss') })
    expect(headsUpOutcome(text, context, 9)).toEqual({
      kind: 'found',
      batch: {
        ysk: 1,
        kind: 'heads_up',
        tips: [{ tag: 'heads_up', line: 'The agent deletes the old table', title: 'Data loss', explanation: 'Why it matters.' }],
        overturned: [],
        step: 9,
      },
    })
  })

  test('anything else is unreadable and leaves the checks running', () => {
    expect(headsUpOutcome('{}', context, 9)).toEqual({ kind: 'unreadable' })
    expect(headsUpOutcome('nothing', context, 9)).toEqual({ kind: 'unreadable' })
    expect(headsUpOutcome(JSON.stringify({ heads_up: tip('x'.repeat(41)) }), context, 9)).toEqual({ kind: 'unreadable' })
    expect(headsUpOutcome(JSON.stringify({ heads_up: tip('Old sessions will be logged out') }), context, 9)).toEqual({ kind: 'unreadable' })
  })
})
