import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  APP_SETTINGS,
  HELD_BACK_SETTINGS,
  applyEnvPatch,
  coerceAppSettingValue,
  findAppSetting,
  projectAppSettingValue,
  readAppSettings,
  unclassifiedSettingKeys
} from './app-settings'
import { initialState, type AppState } from '../shared/state'

function stateWith(settings: Partial<AppState['settings']>): AppState {
  return { ...initialState, settings: { ...initialState.settings, ...settings } }
}

const SECRET = 'sk-ant-do-not-leak-me'

describe('app-settings registry exhaustiveness', () => {
  // The load-bearing test in this file. Settings are added to this app
  // constantly; without this, a new one silently doesn't exist to the
  // global chat and nobody finds out. Failing here forces whoever adds a
  // setting to spend one line deciding whether an agent should be able
  // to change it.
  it('classifies every SettingsState key as exposed or held back', () => {
    const unclassified = unclassifiedSettingKeys()
    expect(
      unclassified,
      unclassified.length === 0
        ? ''
        : `New setting(s) not classified for the ness-app MCP: ${unclassified.join(', ')}.\n` +
          `Add each to APP_SETTINGS in src/main/app-settings.ts (with a type, a\n` +
          `description written for an agent, and the config:set* channel that\n` +
          `already applies it), or to HELD_BACK_SETTINGS with the reason.\n` +
          `Prefer exposing: the global chat exists to configure Ness by\n` +
          `conversation, and an unlisted setting might as well not exist to it.`
    ).toEqual([])
  })

  it('never lists a key as both exposed and held back', () => {
    const exposed = new Set<string>(APP_SETTINGS.map((d) => d.key))
    const both = Object.keys(HELD_BACK_SETTINGS).filter((k) => exposed.has(k))
    expect(both).toEqual([])
  })

  it('gives every held-back setting a reason, not a bare true', () => {
    for (const [key, reason] of Object.entries(HELD_BACK_SETTINGS)) {
      expect(typeof reason, `${key} needs a reason`).toBe('string')
      expect(reason!.length, `${key}'s reason is too terse to be useful`).toBeGreaterThan(15)
    }
  })

  // Would have caught `config:setAnnouncementsMuted`, which does not
  // exist — the real channel is `announcements:mute`. A registry entry
  // naming a channel nobody registered throws at call time, deep inside
  // an MCP round trip, where the agent reports it as an opaque failure.
  it('names a request channel that main actually registers', () => {
    const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf-8')
    const missing = APP_SETTINGS.filter(
      (d) => d.channel && !indexSrc.includes(`'${d.channel}'`)
    ).map((d) => `${d.key} -> ${d.channel}`)
    expect(missing).toEqual([])
  })

  it('every writable descriptor names a distinct key', () => {
    const keys = APP_SETTINGS.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives every exposed setting a description an agent can act on', () => {
    for (const d of APP_SETTINGS) {
      expect(d.description.length, `${d.key} needs a real description`).toBeGreaterThan(20)
    }
  })

  it('offers at least two choices for every enum, or it should not be an enum', () => {
    for (const d of APP_SETTINGS) {
      if (d.type !== 'enum') continue
      expect(d.values, `${d.key} is an enum with no values`).toBeDefined()
      expect(d.values!(initialState).length, `${d.key}`).toBeGreaterThan(1)
    }
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
