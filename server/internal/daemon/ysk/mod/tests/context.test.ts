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

  test('drops malformed entries and fills missing numbers', () => {
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
    expect(context?.lightTipCount).toBe(10)
    expect(context?.checkEverySteps).toBe(0)
    expect(context?.limits).toEqual({ line: 40, title: 12, explanation: 150 })
    expect(context?.issueIdentifier).toBe('')
    expect(context?.latestHumanComment).toBe('')
  })

  test('caps the human comment and topic lists', () => {
    const context = parseContext(JSON.stringify({
      ...valid,
      latest_human_comment: '字'.repeat(600),
      known_topics: Array.from({ length: 60 }, (_, i) => `topic ${i}`),
    }))
    expect(charCount(context?.latestHumanComment ?? '')).toBe(500)
    expect(context?.knownTopics).toHaveLength(50)
    expect(context?.knownTopics[49]).toBe('topic 59')
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
