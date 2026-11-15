import { describe, expect, it } from 'vitest'
import { preprocessIssueIdentifiers } from './issue-identifiers'

describe('preprocessIssueIdentifiers wiki-link protection', () => {
  it('keeps [[wiki links]] whole so the wiki chip resolver sees them', () => {
    expect(preprocessIssueIdentifiers('See [[OL-123]] now')).toBe('See [[OL-123]] now')
    expect(preprocessIssueIdentifiers('See [[page#OL-123|标题]] now')).toBe('See [[page#OL-123|标题]] now')
    expect(preprocessIssueIdentifiers('See [[OL-123|OL-124]] now')).toBe('See [[OL-123|OL-124]] now')
  })

  it('still rewrites bare identifiers outside wiki links', () => {
    expect(preprocessIssueIdentifiers('Fix OL-123 today')).toBe(
      'Fix [OL-123](mention://issue/OL-123) today',
    )
    expect(preprocessIssueIdentifiers('[[OL-1]] and OL-2')).toBe(
      '[[OL-1]] and [OL-2](mention://issue/OL-2)',
    )
  })
  it('does not trip over unbalanced brackets', () => {
    // A single `[OL-123]` is not a wiki link: the identifier still rewrites
    // (pre-existing behaviour), producing a bracketed chip.
    expect(preprocessIssueIdentifiers('[OL-123] plain bracket')).toBe(
      '[[OL-123](mention://issue/OL-123)] plain bracket',
    )
    expect(preprocessIssueIdentifiers('[[OL-123 broken')).toBe(
      '[[[OL-123](mention://issue/OL-123) broken',
    )
  })
})
