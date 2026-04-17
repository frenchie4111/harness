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

  it('autoUpdateEnabledChanged toggles auto-update flag', () => {
    expect(initialSettings.autoUpdateEnabled).toBe(true)
    const off = apply(initialSettings, {
      type: 'settings/autoUpdateEnabledChanged',
      payload: false
    })
    expect(off.autoUpdateEnabled).toBe(false)
    const on = apply(off, { type: 'settings/autoUpdateEnabledChanged', payload: true })
    expect(on.autoUpdateEnabled).toBe(true)
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

  it('harnessStarredChanged tracks star state', () => {
    const yes = apply(initialSettings, { type: 'settings/harnessStarredChanged', payload: true })
    expect(yes.harnessStarred).toBe(true)
    const no = apply(yes, { type: 'settings/harnessStarredChanged', payload: false })
    expect(no.harnessStarred).toBe(false)
    const unknown = apply(no, { type: 'settings/harnessStarredChanged', payload: null })
    expect(unknown.harnessStarred).toBeNull()
  })

  it('githubAuthSourceChanged updates the source', () => {
    const gh = apply(initialSettings, {
      type: 'settings/githubAuthSourceChanged',
      payload: 'gh-cli'
    })
    expect(gh.githubAuthSource).toBe('gh-cli')
    const pat = apply(gh, { type: 'settings/githubAuthSourceChanged', payload: 'pat' })
    expect(pat.githubAuthSource).toBe('pat')
    const none = apply(pat, { type: 'settings/githubAuthSourceChanged', payload: null })
    expect(none.githubAuthSource).toBeNull()
  })

  it('claudeModelChanged sets the model', () => {
    const next = apply(initialSettings, {
      type: 'settings/claudeModelChanged',
      payload: 'claude-opus-4-7'
    })
    expect(next.claudeModel).toBe('claude-opus-4-7')
  })

  it('claudeModelChanged clears with null', () => {
    const withModel = apply(initialSettings, {
      type: 'settings/claudeModelChanged',
      payload: 'claude-opus-4-7'
    })
    const cleared = apply(withModel, {
      type: 'settings/claudeModelChanged',
      payload: null
    })
    expect(cleared.claudeModel).toBeNull()
  })

  it('codexModelChanged sets the model', () => {
    const next = apply(initialSettings, {
      type: 'settings/codexModelChanged',
      payload: 'o3'
    })
    expect(next.codexModel).toBe('o3')
  })

  it('codexModelChanged clears with null', () => {
    const withModel = apply(initialSettings, {
      type: 'settings/codexModelChanged',
      payload: 'o3'
    })
    const cleared = apply(withModel, {
      type: 'settings/codexModelChanged',
      payload: null
    })
    expect(cleared.codexModel).toBeNull()
  })

  it('harnessSystemPromptEnabledChanged toggles flag', () => {
    const off = apply(initialSettings, {
      type: 'settings/harnessSystemPromptEnabledChanged',
      payload: false
    })
    expect(off.harnessSystemPromptEnabled).toBe(false)
    const on = apply(off, {
      type: 'settings/harnessSystemPromptEnabledChanged',
      payload: true
    })
    expect(on.harnessSystemPromptEnabled).toBe(true)
  })

  it('harnessSystemPromptChanged sets the prompt', () => {
    const next = apply(initialSettings, {
      type: 'settings/harnessSystemPromptChanged',
      payload: 'custom prompt'
    })
    expect(next.harnessSystemPrompt).toBe('custom prompt')
  })

  it('harnessSystemPromptMainChanged sets the main prompt', () => {
    const next = apply(initialSettings, {
      type: 'settings/harnessSystemPromptMainChanged',
      payload: 'main only text'
    })
    expect(next.harnessSystemPromptMain).toBe('main only text')
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
