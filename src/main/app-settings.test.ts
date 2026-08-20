import { describe, it, expect } from 'vitest'
import {
  APP_SETTINGS,
  applyEnvPatch,
  coerceAppSettingValue,
  findAppSetting,
  projectAppSettingValue,
  readAppSettings
} from './app-settings'
import { initialState, type AppState } from '../shared/state'

function stateWith(settings: Partial<AppState['settings']>): AppState {
  return { ...initialState, settings: { ...initialState.settings, ...settings } }
}

const SECRET = 'sk-ant-do-not-leak-me'

describe('app-settings registry', () => {
  it('every writable descriptor names a distinct key', () => {
    const keys = APP_SETTINGS.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('marks entries without a channel as read-only', () => {
    const readOnly = APP_SETTINGS.filter((d) => !d.channel).map((d) => d.key)
    expect(readOnly).toEqual(['hasGithubToken', 'githubAuthSource'])
    const projected = readAppSettings(initialState)
    for (const key of readOnly) {
      expect(projected.find((p) => p.key === key)?.writable).toBe(false)
    }
  })

  it('folds mode-matching custom themes into the advertised theme enum', () => {
    const state = stateWith({
      customThemes: [
        { id: 'midnight', name: 'Midnight', mode: 'dark', colors: {} },
        { id: 'parchment', name: 'Parchment', mode: 'light', colors: {} }
      ]
    })
    const dark = readAppSettings(state).find((s) => s.key === 'themeDark')
    expect(dark?.values).toContain('midnight')
    expect(dark?.values).not.toContain('parchment')
  })
})

describe('env-var settings', () => {
  const descriptor = findAppSetting('claudeEnvVars')!

  it('is declared as env, not object — object would echo values verbatim', () => {
    expect(descriptor.type).toBe('env')
    for (const key of ['claudeEnvVars', 'codexEnvVars', 'cursorEnvVars']) {
      expect(findAppSetting(key)?.type).toBe('env')
    }
  })

  it('reports which names are set without their values', () => {
    const state = stateWith({
      claudeEnvVars: { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: 'https://x' }
    })
    const value = projectAppSettingValue(descriptor, state)
    expect(value).toEqual({
      ANTHROPIC_API_KEY: '<set>',
      ANTHROPIC_BASE_URL: '<set>'
    })
    expect(JSON.stringify(value)).not.toContain(SECRET)
  })

  it('keeps the secret out of the full list_settings payload too', () => {
    const state = stateWith({ claudeEnvVars: { ANTHROPIC_API_KEY: SECRET } })
    expect(JSON.stringify(readAppSettings(state))).not.toContain(SECRET)
  })

  it('patches rather than replaces, so unseen vars survive a write', () => {
    const merged = applyEnvPatch(
      { ANTHROPIC_API_KEY: SECRET, KEEP_ME: 'yes' },
      { ANTHROPIC_BASE_URL: 'https://proxy' }
    )
    expect(merged).toEqual({
      ANTHROPIC_API_KEY: SECRET,
      KEEP_ME: 'yes',
      ANTHROPIC_BASE_URL: 'https://proxy'
    })
  })

  it('removes a name set to null', () => {
    expect(applyEnvPatch({ A: '1', B: '2' }, { B: null })).toEqual({ A: '1' })
  })

  it('overwrites a name the caller does supply', () => {
    expect(applyEnvPatch({ A: '1' }, { A: '2' })).toEqual({ A: '2' })
  })

  it('tolerates a missing or malformed current map', () => {
    expect(applyEnvPatch(undefined, { A: '1' })).toEqual({ A: '1' })
    expect(applyEnvPatch({ A: 1 as unknown as string }, { B: '2' })).toEqual({
      B: '2'
    })
  })

  it('coerces a name/value object into a patch', () => {
    const r = coerceAppSettingValue(descriptor, { A: '1', B: null }, initialState)
    expect(r).toEqual({ ok: true, value: { A: '1', B: null } })
  })

  it('accepts a JSON string, which is how a model often sends objects', () => {
    const r = coerceAppSettingValue(descriptor, '{"A":"1"}', initialState)
    expect(r).toEqual({ ok: true, value: { A: '1' } })
  })

  it('rejects a non-string, non-null value rather than stringifying it', () => {
    const r = coerceAppSettingValue(descriptor, { A: 42 }, initialState)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/claudeEnvVars\.A must be a string/)
  })

  it('rejects an array — it would coerce to a nonsense map', () => {
    const r = coerceAppSettingValue(descriptor, ['A'], initialState)
    expect(r.ok).toBe(false)
  })
})

describe('coerceAppSettingValue', () => {
  it('rejects an enum value outside the advertised set', () => {
    const d = findAppSetting('uiScale')!
    expect(coerceAppSettingValue(d, 'gigantic', initialState).ok).toBe(false)
    expect(coerceAppSettingValue(d, 'large', initialState)).toEqual({
      ok: true,
      value: 'large'
    })
  })

  it('accepts a custom theme id once that theme is loaded', () => {
    const d = findAppSetting('themeDark')!
    expect(coerceAppSettingValue(d, 'midnight', initialState).ok).toBe(false)
    const withTheme = stateWith({
      customThemes: [{ id: 'midnight', name: 'Midnight', mode: 'dark', colors: {} }]
    })
    expect(coerceAppSettingValue(d, 'midnight', withTheme)).toEqual({
      ok: true,
      value: 'midnight'
    })
  })

  it('accepts stringified booleans, which models produce routinely', () => {
    const d = findAppSetting('autoApprovePermissions')!
    expect(coerceAppSettingValue(d, 'true', initialState)).toEqual({
      ok: true,
      value: true
    })
    expect(coerceAppSettingValue(d, false, initialState)).toEqual({
      ok: true,
      value: false
    })
    expect(coerceAppSettingValue(d, 'yes', initialState).ok).toBe(false)
  })

  it('rejects a non-numeric number rather than passing NaN to the handler', () => {
    const d = findAppSetting('autoSleepMinutes')!
    expect(coerceAppSettingValue(d, 'soon', initialState).ok).toBe(false)
    expect(coerceAppSettingValue(d, '15', initialState)).toEqual({
      ok: true,
      value: 15
    })
  })

  it('lets a nullable string setting be cleared with null', () => {
    const d = findAppSetting('claudeModel')!
    expect(coerceAppSettingValue(d, null, initialState)).toEqual({
      ok: true,
      value: null
    })
  })

  it('parses an object setting sent as a JSON string', () => {
    const d = findAppSetting('worktreeScripts')!
    expect(
      coerceAppSettingValue(d, '{"setup":"npm i","teardown":""}', initialState)
    ).toEqual({ ok: true, value: { setup: 'npm i', teardown: '' } })
  })

  it('rejects an object setting sent as unparseable text', () => {
    const d = findAppSetting('worktreeScripts')!
    expect(coerceAppSettingValue(d, 'npm i', initialState).ok).toBe(false)
  })

  it('accepts an explicit null for an object setting (hotkeys reset)', () => {
    const d = findAppSetting('hotkeys')!
    expect(coerceAppSettingValue(d, null, initialState)).toEqual({
      ok: true,
      value: null
    })
  })
})
