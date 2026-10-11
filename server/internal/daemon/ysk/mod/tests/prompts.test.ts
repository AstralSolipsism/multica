import { describe, expect, test } from 'claude-code/testing'
import type { YskContext } from '../hooks/context'
import { headsUpPrompt, lightPrompt } from '../hooks/prompts'

const context: YskContext = {
  issueIdentifier: 'OL-123',
  latestHumanComment: '请把登录改成短信验证码',
  existingTips: [{ id: 'tip-1', tag: 'you_should_know', line: '登录走短信验证码' }],
  knownTopics: ['短信验证码'],
  lightTipCount: 3,
  checkEverySteps: 6,
  limits: { line: 40, title: 12, explanation: 200 },
}

describe('prompts', () => {
  for (const [name, build] of [['light', lightPrompt], ['heads-up', headsUpPrompt]] as const) {
    test(`${name}: a side request with the run's data and limits`, () => {
      const prompt = build(context, '工程师')
      expect(prompt).toContain('It is not from the user')
      expect(prompt).toContain('Do not call any tools')
      expect(prompt).toContain('Issue: OL-123')
      expect(prompt).toContain('请把登录改成短信验证码')
      expect(prompt).toContain('[{"id":"tip-1","tag":"you_should_know","line":"登录走短信验证码"}]')
      expect(prompt).toContain('["短信验证码"]')
      expect(prompt).toContain('at most 40 characters')
      expect(prompt).toContain('at most 12 characters')
      expect(prompt).toContain('at most 200 characters')
      expect(prompt).toContain('call it "工程师智能体" in Chinese or "the 工程师 agent" in English')
      expect(prompt).toContain('language of the latest human comment')
      expect(prompt).toContain('Never include secrets')
    })
  }

  test('light asks for the configured number of tips and for overturned ones', () => {
    const prompt = lightPrompt(context, '工程师')
    expect(prompt).toContain('Up to 3 tips')
    expect(prompt).toContain('"overturned"')
  })

  test('heads-up keeps the bar high and allows null', () => {
    const prompt = headsUpPrompt(context, '工程师')
    expect(prompt).toContain('{"heads_up":null}')
    expect(prompt).toContain('Null is the usual answer')
  })

  test('an unnamed agent is still a third-person subject', () => {
    expect(lightPrompt({ ...context, issueIdentifier: '' }, '')).toContain('call it "这个智能体" in Chinese or "the agent" in English')
    expect(lightPrompt({ ...context, issueIdentifier: '' }, '')).toContain('Issue: (unknown)')
  })
})
