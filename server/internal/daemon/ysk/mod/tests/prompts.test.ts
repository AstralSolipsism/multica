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
      const prompt = build(context)
      expect(prompt).toContain('It is not from the user')
      expect(prompt).toContain('Do not call any tools')
      expect(prompt).toContain('Issue: OL-123')
      expect(prompt).toContain('请把登录改成短信验证码')
      expect(prompt).toContain('[{"id":"tip-1","tag":"you_should_know","line":"登录走短信验证码"}]')
      expect(prompt).toContain('["短信验证码"]')
      expect(prompt).toContain('at most 40 characters')
      expect(prompt).toContain('at most 12 characters')
      expect(prompt).toContain('at most 200 characters')
      expect(prompt).toContain('mechanism, module or consequence the subject')
      expect(prompt).not.toContain('always name the subject')
      expect(prompt).toContain('language of the latest human comment')
      expect(prompt).toContain('Never include secrets')
    })
  }

  test('light asks for the configured number of tips and for overturned ones', () => {
    const prompt = lightPrompt(context)
    expect(prompt).toContain('Up to 3 tips')
    expect(prompt).toContain('"overturned"')
  })

  test('heads-up keeps the bar high and allows null', () => {
    const prompt = headsUpPrompt(context)
    expect(prompt).toContain('{"heads_up":null}')
    expect(prompt).toContain('Null is the usual answer')
  })

  test('light teaches four grounded dimensions and bans assignment and activity narration', () => {
    const prompt = lightPrompt({ ...context, issueIdentifier: '' })
    expect(prompt).toContain('Issue: (unknown)')
    for (const rule of ['Why / Mechanism', 'Architecture & Context', 'What Changed & Trade-off', 'Boundaries & Caveats',
      'specific code, data structures, call chains or diagnostic evidence', 'Never restate the task scope or assignment instructions',
      'Never narrate an activity log', 'Never give generic advice detached from this project', '{"tips":[],"overturned":[]}']) {
      expect(prompt).toContain(rule)
    }
  })
})
