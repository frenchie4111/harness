import { describe, it, expect } from 'vitest'
import {
  PROVIDER_BRANCH_SHORTCODE,
  renderTicketPrompt,
  slugifyTitle,
  suggestedBranchName,
  toWorktreeTicketLink
} from './ticket-prompt'
import { isValidBranchName } from './branch-name'
import type { Ticket } from '../shared/tickets'

const fixture: Ticket = {
  id: 'p:42',
  providerId: 'p',
  externalId: '42',
  title: 'Add Dark Mode Toggle to Settings!',
  description: 'Long form description.',
  url: 'https://example.com/tickets/42'
}

describe('slugifyTitle', () => {
  it('lowercases, collapses whitespace, and drops punctuation', () => {
    expect(slugifyTitle('Add Dark Mode Toggle to Settings!')).toBe(
      'add-dark-mode-toggle-to-settings'
    )
  })

  it('returns an empty string for unprintable input rather than throwing', () => {
    expect(slugifyTitle('—— !!!')).toBe('')
  })

  it('truncates long titles on a word boundary', () => {
    const long = 'a very long title that easily exceeds the default character limit threshold yes'
    const slug = slugifyTitle(long)
    expect(slug.length).toBeLessThanOrEqual(50)
    expect(slug.endsWith('-')).toBe(false)
    // Doesn't cut mid-token (lastIndexOf('-') > maxLen/2).
    expect(slug.split('-').every((tok) => tok.length > 0)).toBe(true)
  })

  it('hard-cuts a single overlong token', () => {
    const slug = slugifyTitle('a'.repeat(80))
    expect(slug).toBe('a'.repeat(50))
  })
})

describe('suggestedBranchName', () => {
  it('combines the provider shortcode + external id + slug', () => {
    expect(suggestedBranchName(fixture, 'github-issues')).toBe(
      'gh-42/add-dark-mode-toggle-to-settings'
    )
  })

  it('drops the external id for notion (page UUIDs are useless in branch names)', () => {
    const notionFixture = {
      ...fixture,
      externalId: '3a4df6fc-c6e5-818b-9a9d-e0752628295a'
    }
    expect(suggestedBranchName(notionFixture, 'notion')).toBe(
      'notion/add-dark-mode-toggle-to-settings'
    )
  })

  it('strips URLs out of titles so they do not slugify into noise', () => {
    const urlFixture = {
      ...fixture,
      title: 'hi.chat stuck https://plan.hifinance.ca/chat'
    }
    expect(suggestedBranchName(urlFixture, 'notion')).toBe('notion/hi-chat-stuck')
  })

  it('falls back to "work" when the title slugifies to nothing', () => {
    const empty = { ...fixture, title: '!!!' }
    expect(suggestedBranchName(empty, 'github-issues')).toBe('gh-42/work')
  })

  it('produces a name accepted by isValidBranchName', () => {
    expect(isValidBranchName(suggestedBranchName(fixture, 'github-issues'))).toBe(true)
  })

  it('keeps PROVIDER_BRANCH_SHORTCODE in sync with both provider types', () => {
    expect(PROVIDER_BRANCH_SHORTCODE['github-issues']).toBe('gh')
    expect(PROVIDER_BRANCH_SHORTCODE.notion).toBe('notion')
  })
})

describe('renderTicketPrompt', () => {
  it('substitutes every supported variable', () => {
    const template = '{title}\n{description}\n{url}\n{externalId}\n{providerType}'
    expect(renderTicketPrompt(template, fixture, 'github-issues')).toBe(
      'Add Dark Mode Toggle to Settings!\nLong form description.\nhttps://example.com/tickets/42\n42\ngithub-issues'
    )
  })

  it('repeats substitutions when a variable appears more than once', () => {
    const template = '{title} :: {title}'
    expect(renderTicketPrompt(template, fixture, 'github-issues')).toBe(
      `${fixture.title} :: ${fixture.title}`
    )
  })

  it('leaves unknown placeholders alone', () => {
    const template = '{title} :: {unknown}'
    expect(renderTicketPrompt(template, fixture, 'github-issues')).toBe(
      `${fixture.title} :: {unknown}`
    )
  })
})

describe('toWorktreeTicketLink', () => {
  it('returns the (providerId, externalId) tuple from a Ticket', () => {
    expect(toWorktreeTicketLink(fixture)).toEqual({ providerId: 'p', externalId: '42' })
  })
})
