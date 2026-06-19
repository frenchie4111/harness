import { describe, it, expect } from 'vitest'
import {
  extractArgs,
  getToolDisplay,
  isHarnessControl,
  normalizeServerName,
  parseMcpToolName,
  prettyToolName
} from './tool-display'

describe('parseMcpToolName', () => {
  it('parses claude.ai-hosted servers', () => {
    expect(parseMcpToolName('mcp__claude_ai_Notion__notion-get-users')).toEqual({
      server: 'claude_ai_Notion',
      tool: 'notion-get-users'
    })
  })

  it('parses harness-control tools', () => {
    expect(parseMcpToolName('mcp__harness-control__create_worktree')).toEqual({
      server: 'harness-control',
      tool: 'create_worktree'
    })
  })

  it('parses bare server names', () => {
    expect(parseMcpToolName('mcp__notion__authenticate')).toEqual({
      server: 'notion',
      tool: 'authenticate'
    })
  })

  it('returns null for built-in tools', () => {
    expect(parseMcpToolName('Read')).toBeNull()
    expect(parseMcpToolName('Bash')).toBeNull()
  })

  it('returns null for malformed mcp__ inputs', () => {
    expect(parseMcpToolName('mcp__')).toBeNull()
    expect(parseMcpToolName('mcp____tool')).toBeNull()
    expect(parseMcpToolName('mcp__server__')).toBeNull()
  })
})

describe('isHarnessControl', () => {
  it('recognises harness-control tools', () => {
    expect(isHarnessControl('mcp__harness-control__create_worktree')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isHarnessControl('Read')).toBe(false)
    expect(isHarnessControl('mcp__claude_ai_Notion__notion-get-users')).toBe(false)
    expect(isHarnessControl(undefined)).toBe(false)
  })
})

describe('getToolDisplay', () => {
  it('returns built-in name + icon for Claude tools', () => {
    const read = getToolDisplay('Read')
    expect(read.label).toBe('Read')
    expect(read.icon).not.toBeNull()

    const bash = getToolDisplay('Bash')
    expect(bash.label).toBe('Bash')
    expect(bash.icon).not.toBeNull()
  })

  it('returns name only (no icon) for unknown built-ins', () => {
    expect(getToolDisplay('SomeNewBuiltin')).toEqual({
      label: 'SomeNewBuiltin',
      compactLabel: 'SomeNewBuiltin',
      icon: null
    })
  })

  it('formats harness-control as "Harness · Title Cased Action"', () => {
    const display = getToolDisplay('mcp__harness-control__create_worktree')
    expect(display.label).toBe('Harness · Create Worktree')
    expect(display.icon).not.toBeNull()
  })

  it('formats Notion tools as "Notion · Action" and strips notion- prefix', () => {
    expect(getToolDisplay('mcp__claude_ai_Notion__notion-get-users').label).toBe(
      'Notion · Get Users'
    )
    expect(getToolDisplay('mcp__notion__authenticate').label).toBe(
      'Notion · Authenticate'
    )
  })

  it('formats Slack tools as "Slack · Action" and strips slack_ prefix', () => {
    expect(
      getToolDisplay('mcp__claude_ai_Slack__slack_send_message').label
    ).toBe('Slack · Send Message')
  })

  it('formats Google Drive tools with the multi-word label', () => {
    expect(
      getToolDisplay('mcp__claude_ai_Google_Drive__list_recent_files').label
    ).toBe('Google Drive · List Recent Files')
  })

  it('formats Google Calendar tools with the multi-word label', () => {
    expect(
      getToolDisplay('mcp__claude_ai_Google_Calendar__create_event').label
    ).toBe('Google Calendar · Create Event')
  })

  it('formats Gmail tools', () => {
    expect(getToolDisplay('mcp__claude_ai_Gmail__create_draft').label).toBe(
      'Gmail · Create Draft'
    )
  })

  it('falls back to title-cased server + generic icon for unknown brands', () => {
    const display = getToolDisplay('mcp__foo_bar__do_thing')
    expect(display.label).toBe('foo bar · Do Thing')
    expect(display.icon).not.toBeNull()
  })

  it('handles undefined gracefully', () => {
    expect(getToolDisplay(undefined)).toEqual({
      label: 'Tool',
      compactLabel: 'Tool',
      icon: null
    })
  })
})

describe('prettyToolName back-compat', () => {
  it('returns the same label as getToolDisplay', () => {
    expect(prettyToolName('mcp__harness-control__create_worktree')).toBe(
      'Harness · Create Worktree'
    )
    expect(prettyToolName('Read')).toBe('Read')
  })
})

describe('normalizeServerName', () => {
  it('collapses spellings of the same brand to one key', () => {
    expect(normalizeServerName('GitHub')).toBe('github')
    expect(normalizeServerName('github')).toBe('github')
    expect(normalizeServerName('claude_ai_GitHub')).toBe('github')
    expect(normalizeServerName('Google_Drive')).toBe('googledrive')
    expect(normalizeServerName('claude_ai_Google_Drive')).toBe('googledrive')
    expect(normalizeServerName('harness-control')).toBe('harnesscontrol')
  })
})

describe('expanded brand registry', () => {
  it('matches GitHub regardless of spelling', () => {
    expect(getToolDisplay('mcp__github__create_issue').label).toBe(
      'GitHub · Create Issue'
    )
    expect(getToolDisplay('mcp__GitHub__create_issue').label).toBe(
      'GitHub · Create Issue'
    )
    expect(getToolDisplay('mcp__claude_ai_GitHub__create_issue').label).toBe(
      'GitHub · Create Issue'
    )
  })

  it('strips the brand prefix from tool names with hyphen or underscore', () => {
    expect(getToolDisplay('mcp__github__github-list-pull-requests').label).toBe(
      'GitHub · List Pull Requests'
    )
    expect(getToolDisplay('mcp__stripe__stripe_create_customer').label).toBe(
      'Stripe · Create Customer'
    )
  })

  it('handles common dev/data/comms brands', () => {
    expect(getToolDisplay('mcp__linear__create_issue').label).toBe(
      'Linear · Create Issue'
    )
    expect(getToolDisplay('mcp__postgres__query').label).toBe('Postgres · Query')
    expect(getToolDisplay('mcp__postgresql__query').label).toBe(
      'Postgres · Query'
    )
    expect(getToolDisplay('mcp__discord__send_message').label).toBe(
      'Discord · Send Message'
    )
    expect(getToolDisplay('mcp__figma__get_file').label).toBe(
      'Figma · Get File'
    )
  })

  it('treats Twitter as X (rename)', () => {
    expect(getToolDisplay('mcp__twitter__post_tweet').label).toBe(
      'X · Post Tweet'
    )
    expect(getToolDisplay('mcp__x__post_tweet').label).toBe('X · Post Tweet')
  })

  it('returns an icon for every known brand', () => {
    const brands = [
      'github', 'gitlab', 'bitbucket', 'linear', 'jira', 'sentry', 'vercel',
      'netlify', 'cloudflare', 'supabase', 'firebase', 'postgres', 'mysql',
      'mongodb', 'redis', 'sqlite', 'snowflake', 'elasticsearch', 'discord',
      'telegram', 'whatsapp', 'zoom', 'mailchimp', 'twilio', 'intercom',
      'asana', 'trello', 'clickup', 'confluence', 'stripe', 'paypal',
      'shopify', 'hubspot', 'salesforce', 'zendesk', 'openai', 'huggingface',
      'perplexity', 'brave', 'anthropic', 'figma', 'spotify', 'youtube',
      'reddit', 'x', 'bluesky', 'cloudinary'
    ]
    for (const b of brands) {
      const d = getToolDisplay(`mcp__${b}__do_thing`)
      expect(d.icon, `${b} should have an icon`).not.toBeNull()
    }
  })
})

describe('extractArgs', () => {
  it('returns [] for non-object inputs', () => {
    expect(extractArgs(undefined)).toEqual([])
    expect(extractArgs(null)).toEqual([])
    expect(extractArgs('hi')).toEqual([])
    expect(extractArgs(42)).toEqual([])
    expect(extractArgs([1, 2])).toEqual([])
  })

  it('returns an entry per top-level key, preserving order', () => {
    const args = extractArgs({ branchName: 'feat-x', count: 3 })
    expect(args).toEqual([
      { key: 'branchName', value: 'feat-x', multiline: false },
      { key: 'count', value: '3', multiline: false }
    ])
  })

  it('stringifies nested objects and arrays as JSON', () => {
    const args = extractArgs({ rules: [{ a: 1 }], opts: { x: true } })
    expect(args[0].value).toBe('[{"a":1}]')
    expect(args[1].value).toBe('{"x":true}')
  })

  it('marks long or multi-line values as multiline', () => {
    const long = 'a'.repeat(120)
    const args = extractArgs({
      short: 'hi',
      long,
      hasNewline: 'one\ntwo'
    })
    expect(args[0].multiline).toBe(false)
    expect(args[1].multiline).toBe(true)
    expect(args[2].multiline).toBe(true)
  })

  it('handles null and booleans as scalars, not multiline', () => {
    const args = extractArgs({ enabled: true, missing: null })
    expect(args).toEqual([
      { key: 'enabled', value: 'true', multiline: false },
      { key: 'missing', value: 'null', multiline: false }
    ])
  })
})

describe('compactLabel', () => {
  it('drops the brand prefix for known MCP brands (icon conveys it)', () => {
    expect(getToolDisplay('mcp__github__create_issue').compactLabel).toBe(
      'Create Issue'
    )
    expect(
      getToolDisplay('mcp__harness-control__create_worktree').compactLabel
    ).toBe('Create Worktree')
    expect(
      getToolDisplay('mcp__claude_ai_Google_Drive__list_recent_files').compactLabel
    ).toBe('List Recent Files')
  })

  it('matches label for built-ins (no prefix to drop)', () => {
    const read = getToolDisplay('Read')
    expect(read.compactLabel).toBe(read.label)
    expect(read.compactLabel).toBe('Read')
  })

  it('matches label for unknown MCPs (generic plug icon has no brand cue)', () => {
    const d = getToolDisplay('mcp__foo_bar__do_thing')
    expect(d.compactLabel).toBe(d.label)
    expect(d.compactLabel).toBe('foo bar · Do Thing')
  })

  it('handles undefined gracefully', () => {
    expect(getToolDisplay(undefined).compactLabel).toBe('Tool')
  })
})
