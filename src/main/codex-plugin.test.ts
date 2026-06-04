import { describe, it, expect, vi, beforeEach } from 'vitest'

const fsState: { files: Map<string, string> } = { files: new Map() }

vi.mock('fs', () => ({
  existsSync: (p: string) => fsState.files.has(p),
  readFileSync: (p: string) => {
    if (!fsState.files.has(p)) throw new Error(`ENOENT: ${p}`)
    return fsState.files.get(p) as string
  },
  writeFileSync: (p: string, data: string) => {
    fsState.files.set(p, data)
  }
}))

vi.mock('./debug', () => ({
  log: () => {}
}))

vi.mock('./claude-plugin', () => ({
  harnessPluginMarketplaceRoot: () => '/bundled/plugins'
}))

import {
  stripHarnessEntriesFromHooksFile,
  legacyGlobalHooksPath,
  legacyWorktreeHooksPath
} from './codex-plugin'

beforeEach(() => {
  fsState.files.clear()
})

describe('stripHarnessEntriesFromHooksFile', () => {
  const SIG = '/tmp/harness-status'
  const harnessEntry = {
    hooks: [{ type: 'command', command: `bash -c 'd=${SIG}; …'`, timeout: 5 }]
  }
  const userEntry = {
    hooks: [{ type: 'command', command: 'echo user hook' }]
  }

  it('returns false when the file does not exist', () => {
    expect(stripHarnessEntriesFromHooksFile('/nope/hooks.json')).toBe(false)
  })

  it('returns false when no hooks key is present', () => {
    fsState.files.set('/x/hooks.json', JSON.stringify({}))
    expect(stripHarnessEntriesFromHooksFile('/x/hooks.json')).toBe(false)
  })

  it('returns false when there are no harness entries', () => {
    fsState.files.set(
      '/x/hooks.json',
      JSON.stringify({ hooks: { Stop: [userEntry] } })
    )
    expect(stripHarnessEntriesFromHooksFile('/x/hooks.json')).toBe(false)
    // Untouched.
    expect(JSON.parse(fsState.files.get('/x/hooks.json') as string)).toEqual({
      hooks: { Stop: [userEntry] }
    })
  })

  it('strips harness entries but preserves user-authored ones', () => {
    fsState.files.set(
      '/x/hooks.json',
      JSON.stringify({
        hooks: {
          Stop: [harnessEntry, userEntry],
          PreToolUse: [harnessEntry]
        }
      })
    )
    expect(stripHarnessEntriesFromHooksFile('/x/hooks.json')).toBe(true)
    const after = JSON.parse(fsState.files.get('/x/hooks.json') as string)
    expect(after).toEqual({ hooks: { Stop: [userEntry] } })
  })

  it('drops the hooks key entirely when every event becomes empty', () => {
    fsState.files.set(
      '/x/hooks.json',
      JSON.stringify({
        hooks: { Stop: [harnessEntry], PreToolUse: [harnessEntry] }
      })
    )
    expect(stripHarnessEntriesFromHooksFile('/x/hooks.json')).toBe(true)
    const after = JSON.parse(fsState.files.get('/x/hooks.json') as string)
    expect(after.hooks).toBeUndefined()
  })

  it('gracefully handles invalid JSON', () => {
    fsState.files.set('/x/hooks.json', '{ not valid json }')
    expect(stripHarnessEntriesFromHooksFile('/x/hooks.json')).toBe(false)
  })
})

describe('hook file path helpers', () => {
  it('legacyGlobalHooksPath ends with .codex/hooks.json', () => {
    expect(legacyGlobalHooksPath()).toMatch(/\.codex[\\/]hooks\.json$/)
  })

  it('legacyWorktreeHooksPath nests under the worktree', () => {
    expect(legacyWorktreeHooksPath('/work/tree')).toMatch(
      /^\/work\/tree[\\/]\.codex[\\/]hooks\.json$/
    )
  })
})
