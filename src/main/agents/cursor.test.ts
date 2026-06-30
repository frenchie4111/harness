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
  makeHookCommand: (event: string) =>
    `bash -c 'd=/tmp/harness-status; printf "${event}" >> "$d/$h.ndjson"'`
}))

import { homedir } from 'os'
import { join } from 'path'
import { hooksInstalled, installHooks, hookEvents, uninstallHooks, buildSpawnArgs } from './cursor'

const HOOKS_PATH = join(homedir(), '.cursor', 'hooks.json')

beforeEach(() => {
  fsState.files.clear()
})

describe('cursor hook install / dedup', () => {
  it('hooksInstalled() recognizes entries with the status-dir signature', () => {
    const data = {
      version: 1,
      hooks: {
        preToolUse: [
          {
            command:
              "bash -c 'd=/tmp/harness-status; printf hi >> \"$d/$h.ndjson\"'",
            timeout: 5
          }
        ]
      }
    }
    fsState.files.set(HOOKS_PATH, JSON.stringify(data))
    expect(hooksInstalled()).toBe(true)
  })

  it('hooksInstalled() returns false when only user-authored hooks exist', () => {
    fsState.files.set(
      HOOKS_PATH,
      JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [{ command: 'echo user hook', timeout: 5 }]
        }
      })
    )
    expect(hooksInstalled()).toBe(false)
  })

  it('installHooks() called twice yields exactly one harness entry per event', () => {
    installHooks()
    installHooks()
    const data = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    for (const event of hookEvents) {
      const entries = data.hooks[event]
      expect(entries).toHaveLength(1)
      expect(entries[0].command).toContain('/tmp/harness-status')
    }
  })

  it('uninstallHooks() removes harness entries but preserves user-authored hooks', () => {
    installHooks()
    const after = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    after.hooks.preToolUse.push({ command: 'echo user hook' })
    fsState.files.set(HOOKS_PATH, JSON.stringify(after))

    uninstallHooks()

    const final = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    expect(final.hooks?.preToolUse).toEqual([{ command: 'echo user hook' }])
    expect(final.hooks?.postToolUse).toBeUndefined()
  })
})

describe('cursor buildSpawnArgs', () => {
  it('appends --model when configured', () => {
    expect(
      buildSpawnArgs({
        command: 'agent',
        cwd: '/tmp',
        model: 'composer-2.5'
      })
    ).toBe("agent --model 'composer-2.5'")
  })

  it('starts fresh when the session is not on disk yet', () => {
    expect(
      buildSpawnArgs({
        command: 'agent',
        cwd: '/tmp',
        sessionId: 'abc-123'
      })
    ).toBe('agent')
  })
})
