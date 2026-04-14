import { describe, it, expect } from 'vitest'
import {
  initialSettings,
  settingsReducer,
  type SettingsEvent,
  type SettingsState
} from './settings'

function apply(state: SettingsState, event: SettingsEvent): SettingsState {
  return settingsReducer(state, event)
}

describe('settingsReducer', () => {
  it('themeChanged sets theme', () => {
    const next = apply(initialSettings, { type: 'settings/themeChanged', payload: 'solarized' })
    expect(next.theme).toBe('solarized')
  })

  it('hotkeysChanged replaces the map (including null)', () => {
    const s1 = apply(initialSettings, {
      type: 'settings/hotkeysChanged',
      payload: { 'switch-worktree': 'Cmd+Shift+T' }
    })
    expect(s1.hotkeys).toEqual({ 'switch-worktree': 'Cmd+Shift+T' })
    const s2 = apply(s1, { type: 'settings/hotkeysChanged', payload: null })
    expect(s2.hotkeys).toBeNull()
  })

  it('claudeCommandChanged sets the command string', () => {
    const next = apply(initialSettings, {
      type: 'settings/claudeCommandChanged',
      payload: 'claude --verbose'
    })
    expect(next.claudeCommand).toBe('claude --verbose')
  })

  it('worktreeScriptsChanged replaces both setup and teardown', () => {
    const next = apply(initialSettings, {
      type: 'settings/worktreeScriptsChanged',
      payload: { setup: 'pnpm i', teardown: 'echo bye' }
    })
    expect(next.worktreeScripts).toEqual({ setup: 'pnpm i', teardown: 'echo bye' })
  })

  it('claudeEnvVarsChanged replaces the full map', () => {
    const next = apply(initialSettings, {
      type: 'settings/claudeEnvVarsChanged',
      payload: { FOO: 'bar', BAZ: 'qux' }
    })
    expect(next.claudeEnvVars).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('harnessMcpEnabledChanged toggles mcp flag', () => {
    const off = apply(initialSettings, {
      type: 'settings/harnessMcpEnabledChanged',
      payload: false
    })
    expect(off.harnessMcpEnabled).toBe(false)
    const on = apply(off, { type: 'settings/harnessMcpEnabledChanged', payload: true })
    expect(on.harnessMcpEnabled).toBe(true)
  })

  it('nameClaudeSessionsChanged toggles flag', () => {
    const next = apply(initialSettings, {
      type: 'settings/nameClaudeSessionsChanged',
      payload: true
    })
    expect(next.nameClaudeSessions).toBe(true)
  })

  it('terminalFontFamilyChanged sets font family', () => {
    const next = apply(initialSettings, {
      type: 'settings/terminalFontFamilyChanged',
      payload: 'JetBrains Mono'
    })
    expect(next.terminalFontFamily).toBe('JetBrains Mono')
  })

  it('terminalFontSizeChanged sets font size', () => {
    const next = apply(initialSettings, {
      type: 'settings/terminalFontSizeChanged',
      payload: 16
    })
    expect(next.terminalFontSize).toBe(16)
  })

  it('editorChanged sets editor id', () => {
    const next = apply(initialSettings, { type: 'settings/editorChanged', payload: 'zed' })
    expect(next.editor).toBe('zed')
  })

  it('worktreeBaseChanged sets base mode', () => {
    const next = apply(initialSettings, {
      type: 'settings/worktreeBaseChanged',
      payload: 'local'
    })
    expect(next.worktreeBase).toBe('local')
  })

  it('mergeStrategyChanged sets strategy', () => {
    const next = apply(initialSettings, {
      type: 'settings/mergeStrategyChanged',
      payload: 'fast-forward'
    })
    expect(next.mergeStrategy).toBe('fast-forward')
  })

  it('hasGithubTokenChanged flips the presence flag', () => {
    const hasIt = apply(initialSettings, {
      type: 'settings/hasGithubTokenChanged',
      payload: true
    })
    expect(hasIt.hasGithubToken).toBe(true)
    const gone = apply(hasIt, { type: 'settings/hasGithubTokenChanged', payload: false })
    expect(gone.hasGithubToken).toBe(false)
  })

  it('returns a new object reference (no mutation)', () => {
    const next = apply(initialSettings, { type: 'settings/themeChanged', payload: 'x' })
    expect(next).not.toBe(initialSettings)
    expect(initialSettings.theme).not.toBe('x')
  })

  it('leaves unrelated fields untouched', () => {
    const start: SettingsState = {
      ...initialSettings,
      claudeCommand: 'pre-existing',
      nameClaudeSessions: true
    }
    const next = apply(start, { type: 'settings/themeChanged', payload: 'other' })
    expect(next.claudeCommand).toBe('pre-existing')
    expect(next.nameClaudeSessions).toBe(true)
  })
})
