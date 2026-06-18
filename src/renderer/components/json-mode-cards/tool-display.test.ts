import { describe, it, expect } from 'vitest'
import {
  getToolDisplay,
  isHarnessControl,
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
      icon: null
    })
  })

  it('drops the Harness label for harness-control (gradient implies it)', () => {
    const display = getToolDisplay('mcp__harness-control__create_worktree')
    expect(display.label).toBe('create worktree')
    expect(display.icon).not.toBeNull()
  })

  it('formats Notion tools as "Notion · action" and strips notion- prefix', () => {
    expect(getToolDisplay('mcp__claude_ai_Notion__notion-get-users').label).toBe(
      'Notion · get users'
    )
    expect(getToolDisplay('mcp__notion__authenticate').label).toBe(
      'Notion · authenticate'
    )
  })

  it('formats Slack tools as "Slack · action" and strips slack_ prefix', () => {
    expect(
      getToolDisplay('mcp__claude_ai_Slack__slack_send_message').label
    ).toBe('Slack · send message')
  })

  it('formats Google Drive tools with the multi-word label', () => {
    expect(
      getToolDisplay('mcp__claude_ai_Google_Drive__list_recent_files').label
    ).toBe('Google Drive · list recent files')
  })

  it('formats Google Calendar tools with the multi-word label', () => {
    expect(
      getToolDisplay('mcp__claude_ai_Google_Calendar__create_event').label
    ).toBe('Google Calendar · create event')
  })

  it('formats Gmail tools', () => {
    expect(getToolDisplay('mcp__claude_ai_Gmail__create_draft').label).toBe(
      'Gmail · create draft'
    )
  })

  it('falls back to title-cased server + generic icon for unknown brands', () => {
    const display = getToolDisplay('mcp__foo_bar__do_thing')
    expect(display.label).toBe('foo bar · do thing')
    expect(display.icon).not.toBeNull()
  })

  it('handles undefined gracefully', () => {
    expect(getToolDisplay(undefined)).toEqual({ label: 'Tool', icon: null })
  })
})

describe('prettyToolName back-compat', () => {
  it('returns the same label as getToolDisplay', () => {
    expect(prettyToolName('mcp__harness-control__create_worktree')).toBe(
      'create worktree'
    )
    expect(prettyToolName('Read')).toBe('Read')
  })
})
