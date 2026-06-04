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
import { buildSpawnArgs, hookEvents, stripGlobalHooks } from './claude'

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

  it('passes --plugin-dir pointing at the bundled Harness status plugin', () => {
    const result = buildSpawnArgs({ ...base })
    expect(result).toContain('--plugin-dir')
    expect(result).toContain('resources/plugins/harness-status')
  })
})

describe('stripGlobalHooks (legacy migration)', () => {
  it('returns false when settings.json has no Harness entries', () => {
    fsState.files.set(
      SETTINGS_PATH,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ type: 'command', command: 'echo user hook', timeout: 5 }]
            }
          ]
        }
      })
    )
    expect(stripGlobalHooks()).toBe(false)
    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    expect(after.hooks.UserPromptSubmit).toHaveLength(1)
  })

  it('returns false when settings.json does not exist', () => {
    expect(stripGlobalHooks()).toBe(false)
  })

  it('removes legacy Harness entries while preserving user-authored hooks', () => {
    const userHook = {
      hooks: [{ type: 'command', command: 'echo user hook', timeout: 10 }]
    }
    const harnessHook = {
      hooks: [
        {
          type: 'command',
          command:
            "bash -c 'd=/tmp/harness-status; printf hi >> \"$d/$h.ndjson\"'",
          timeout: 5
        }
      ]
    }
    fsState.files.set(
      SETTINGS_PATH,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [userHook, harnessHook],
          PreToolUse: [harnessHook]
        },
        unrelatedKey: 'preserve-me'
      })
    )

    expect(stripGlobalHooks()).toBe(true)
    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    expect(after.unrelatedKey).toBe('preserve-me')
    // User hook survives; harness entry stripped.
    expect(after.hooks.UserPromptSubmit).toEqual([userHook])
    // Event with only harness entry → key removed entirely.
    expect(after.hooks.PreToolUse).toBeUndefined()
  })

  it('drops the hooks object entirely when no events remain', () => {
    fsState.files.set(
      SETTINGS_PATH,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'bash -c \'d=/tmp/harness-status; echo x\'',
                  timeout: 5
                }
              ]
            }
          ]
        },
        otherKey: 'keep'
      })
    )

    expect(stripGlobalHooks()).toBe(true)
    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    expect(after.hooks).toBeUndefined()
    expect(after.otherKey).toBe('keep')
  })
})

describe('hookEvents', () => {
  it('exports the events the bundled plugin must register', () => {
    expect(hookEvents).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'Notification'
    ])
  })
})
