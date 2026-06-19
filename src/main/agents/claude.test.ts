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
  },
  mkdirSync: () => {},
  readdirSync: () => [],
  statSync: () => ({ mtimeMs: 0 })
}))

vi.mock('../debug', () => ({
  log: () => {}
}))

vi.mock('../hooks', () => ({
  // Match the real shape — every Harness hook command embeds the
  // status-dir path. That substring is what dedup recognizes.
  makeHookCommand: (event: string) =>
    `bash -c 'd=/tmp/harness-status; printf "${event}" >> "$d/$h.ndjson"'`
}))

import { homedir } from 'os'
import { join } from 'path'
import { buildSpawnArgs, hooksInstalled, installHooks, hookEvents, uninstallHooks } from './claude'

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

beforeEach(() => {
  fsState.files.clear()
})

describe('buildSpawnArgs', () => {
  const base = { command: 'claude', cwd: '/tmp/test' }

  it('includes --append-system-prompt when systemPrompt is provided', () => {
    const result = buildSpawnArgs({ ...base, systemPrompt: 'You are in Harness.' })
    expect(result).toContain('--append-system-prompt')
    expect(result).toContain('You are in Harness.')
  })

  it('omits --append-system-prompt when systemPrompt is undefined', () => {
    const result = buildSpawnArgs({ ...base })
    expect(result).not.toContain('--append-system-prompt')
  })

  it('omits --append-system-prompt when systemPrompt is empty', () => {
    const result = buildSpawnArgs({ ...base, systemPrompt: '' })
    expect(result).not.toContain('--append-system-prompt')
  })

  it('shell-quotes the system prompt safely', () => {
    const prompt = "it's a \"test\" with\nnewlines"
    const result = buildSpawnArgs({ ...base, systemPrompt: prompt })
    expect(result).toContain('--append-system-prompt')
    expect(result).toContain("'\\''")
  })

  const sessionPath = (cwd: string, id: string): string =>
    join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)

  it('blank: --session-id when no transcript exists for the session id', () => {
    const result = buildSpawnArgs({ ...base, sessionId: 'fresh-id' })
    expect(result).toContain('--session-id fresh-id')
    expect(result).not.toContain('--resume')
    expect(result).not.toContain('--fork-session')
  })

  it('resume: --resume when a transcript exists for the session id', () => {
    fsState.files.set(sessionPath(base.cwd, 'old-id'), '{}')
    const result = buildSpawnArgs({ ...base, sessionId: 'old-id' })
    expect(result).toContain('--resume old-id')
    expect(result).not.toContain('--session-id')
  })

  it('fork: --resume <src> --fork-session, never --session-id (even if sessionId set)', () => {
    const result = buildSpawnArgs({ ...base, sessionId: 'tab-id', forkFromSessionId: 'src-id' })
    expect(result).toContain('--resume src-id')
    expect(result).toContain('--fork-session')
    expect(result).not.toContain('--session-id')
  })
})

describe('hook install / dedup', () => {
  it('hooksInstalled() recognizes normalized entries with no _marker field', () => {
    // Simulate what Claude Code leaves behind after normalizing settings.json:
    // the _marker and _version sidecar fields are stripped, only the
    // {type, command, timeout} triple remains.
    const settings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  "bash -c 'd=/tmp/harness-status; printf hi >> \"$d/$h.ndjson\"'",
                timeout: 5
              }
            ]
          }
        ]
      }
    }
    fsState.files.set(SETTINGS_PATH, JSON.stringify(settings))
    expect(hooksInstalled()).toBe(true)
  })

  it('hooksInstalled() returns false when only user-authored hooks exist', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'echo user hook', timeout: 5 }]
          }
        ]
      }
    }
    fsState.files.set(SETTINGS_PATH, JSON.stringify(settings))
    expect(hooksInstalled()).toBe(false)
  })

  it('installHooks() called twice yields exactly one harness entry per event', () => {
    installHooks()
    installHooks()
    const settings = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    for (const event of hookEvents) {
      const entries = settings.hooks[event]
      expect(entries).toHaveLength(1)
      expect(entries[0].hooks[0].command).toContain('/tmp/harness-status')
    }
  })

  it('installHooks() collapses pre-existing duplicates left by buggy passes', () => {
    // Three duplicate harness entries per event, all in normalized form
    // (no _marker / _version). This is the exact shape the user reports
    // after several buggy install passes.
    const dupEntry = {
      hooks: [
        {
          type: 'command',
          command:
            "bash -c 'd=/tmp/harness-status; printf hi >> \"$d/$h.ndjson\"'",
          timeout: 5
        }
      ]
    }
    const settings: { hooks: Record<string, unknown[]> } = { hooks: {} }
    for (const event of hookEvents) {
      settings.hooks[event] = [dupEntry, dupEntry, dupEntry]
    }
    fsState.files.set(SETTINGS_PATH, JSON.stringify(settings))

    installHooks()

    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    for (const event of hookEvents) {
      expect(after.hooks[event]).toHaveLength(1)
    }
  })

  it('installHooks() preserves user-authored hooks (commands not pointing at /tmp/harness-status)', () => {
    const userHook = {
      hooks: [{ type: 'command', command: 'echo user hook', timeout: 10 }]
    }
    fsState.files.set(
      SETTINGS_PATH,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [userHook],
          PreToolUse: [userHook]
        },
        unrelatedKey: 'preserve-me'
      })
    )

    installHooks()

    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    expect(after.unrelatedKey).toBe('preserve-me')
    // User hook still there + one harness entry appended
    expect(after.hooks.UserPromptSubmit).toContainEqual(userHook)
    expect(after.hooks.PreToolUse).toContainEqual(userHook)
    for (const event of hookEvents) {
      const harnessEntries = (after.hooks[event] as Array<{ hooks: { command: string }[] }>).filter(
        (e) => e.hooks.some((h) => h.command.includes('/tmp/harness-status'))
      )
      expect(harnessEntries).toHaveLength(1)
    }
  })

  it('uninstallHooks() removes harness entries but preserves user-authored hooks', () => {
    installHooks()
    // Add a user-authored hook alongside
    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    after.hooks.UserPromptSubmit.push({
      hooks: [{ type: 'command', command: 'echo user hook' }]
    })
    fsState.files.set(SETTINGS_PATH, JSON.stringify(after))

    uninstallHooks()

    const final = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    expect(final.hooks?.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: 'echo user hook' }] }
    ])
    // Other events had no user hooks, so they should be gone entirely.
    expect(final.hooks?.PreToolUse).toBeUndefined()
  })
})
