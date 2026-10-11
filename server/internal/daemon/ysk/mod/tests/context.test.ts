import { describe, expect, test } from 'claude-code/testing'
import { charCount, clip, parseContext } from '../hooks/context'

const valid = {
  version: 1,
  issue_identifier: 'OL-123',
  anchor_comment_id: null,
  latest_human_comment: '请把登录改成短信验证码',
  existing_tips: [{ id: 'tip-1', tag: 'you_should_know', line: '登录走短信验证码' }],
  known_topics: ['短信验证码'],
  light_tip_count: 3,
  check_every_steps: 6,
  limits: { line: 40, title: 12, explanation: 200 },
}

describe('parseContext', () => {
  test('reads a version-1 context', () => {
    expect(parseContext(JSON.stringify(valid))).toEqual({
      issueIdentifier: 'OL-123',
      latestHumanComment: '请把登录改成短信验证码',
      existingTips: [{ id: 'tip-1', tag: 'you_should_know', line: '登录走短信验证码' }],
      knownTopics: ['短信验证码'],
      lightTipCount: 3,
      checkEverySteps: 6,
      limits: { line: 40, title: 12, explanation: 200 },
    })
  })

  test('stays off for anything but a version-1 object', () => {
    expect(parseContext('not json')).toBeUndefined()
    expect(parseContext('[]')).toBeUndefined()
    expect(parseContext(JSON.stringify({ ...valid, version: 2 }))).toBeUndefined()
    expect(parseContext(JSON.stringify({ ...valid, version: undefined }))).toBeUndefined()
  })

  test('drops malformed entries and fills missing limits', () => {
    const context = parseContext(JSON.stringify({
      version: 1,
      existing_tips: [{ id: '', line: 'no id' }, { id: 'x' }, 'tip', { id: 'ok', line: ' kept ' }],
      known_topics: ['a', 7, '', ' b '],
      light_tip_count: 99,
      check_every_steps: -1,
      limits: { line: 0, title: 'twelve', explanation: 150 },
    }))
    expect(context?.existingTips).toEqual([{ id: 'ok', tag: '', line: 'kept' }])
    expect(context?.knownTopics).toEqual(['a', 'b'])
    expect(context?.lightTipCount).toBe(99)
    expect(context?.checkEverySteps).toBe(0)
    expect(context?.limits).toEqual({ line: 40, title: 12, explanation: 150 })
    expect(context?.issueIdentifier).toBe('')
    expect(context?.latestHumanComment).toBe('')
  })

  // The server owns the protocol's limits; the mod keeps what it was sent.
  test('keeps every tip, topic and the whole comment it was sent', () => {
    const tips = Array.from({ length: 201 }, (_, i) => ({ id: `tip-${i}`, tag: 'you_should_know', line: `Existing fact ${i}` }))
    const topics = Array.from({ length: 60 }, (_, i) => `topic ${i}`)
    const context = parseContext(JSON.stringify({ ...valid, existing_tips: tips, known_topics: topics, latest_human_comment: '字'.repeat(600) }))
    expect(context?.existingTips).toHaveLength(201)
    expect(context?.existingTips[0]).toEqual({ id: 'tip-0', tag: 'you_should_know', line: 'Existing fact 0' })
    expect(context?.existingTips[200]?.id).toBe('tip-200')
    expect(context?.knownTopics).toEqual(topics)
    expect(charCount(context?.latestHumanComment ?? '')).toBe(600)
  })
})

describe('character counting', () => {
  test('counts code points, not UTF-16 units', () => {
    expect(charCount('提个醒')).toBe(3)
    expect(charCount('a😀b')).toBe(3)
    expect(clip('a😀bc', 2)).toBe('a😀')
    expect(clip('short', 10)).toBe('short')
  })
})
