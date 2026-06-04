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
  appendFileSync: (p: string, data: string) => {
    fsState.files.set(p, (fsState.files.get(p) ?? '') + data)
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
import { hooksInstalled, installHooks, hookEvents, uninstallHooks } from './codex'

const HOOKS_PATH = join(homedir(), '.codex', 'hooks.json')

beforeEach(() => {
  fsState.files.clear()
})

describe('codex hook install / dedup', () => {
  it('hooksInstalled() recognizes normalized entries with no _marker field', () => {
    const data = {
      hooks: {
        SessionStart: [
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
    fsState.files.set(HOOKS_PATH, JSON.stringify(data))
    expect(hooksInstalled()).toBe(true)
  })

  it('hooksInstalled() returns false when only user-authored hooks exist', () => {
    fsState.files.set(
      HOOKS_PATH,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo user hook', timeout: 5 }] }
          ]
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
      expect(entries[0].hooks[0].command).toContain('/tmp/harness-status')
    }
  })

  it('installHooks() collapses pre-existing duplicates left by buggy passes', () => {
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
    const data: { hooks: Record<string, unknown[]> } = { hooks: {} }
    for (const event of hookEvents) {
      data.hooks[event] = [dupEntry, dupEntry, dupEntry]
    }
    fsState.files.set(HOOKS_PATH, JSON.stringify(data))

    installHooks()

    const after = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    for (const event of hookEvents) {
      expect(after.hooks[event]).toHaveLength(1)
    }
  })

  it('installHooks() preserves user-authored hooks', () => {
    const userHook = {
      hooks: [{ type: 'command', command: 'echo user hook', timeout: 10 }]
    }
    fsState.files.set(
      HOOKS_PATH,
      JSON.stringify({
        hooks: { SessionStart: [userHook], PreToolUse: [userHook] }
      })
    )

    installHooks()

    const after = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    expect(after.hooks.SessionStart).toContainEqual(userHook)
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
    const after = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    after.hooks.SessionStart.push({
      hooks: [{ type: 'command', command: 'echo user hook' }]
    })
    fsState.files.set(HOOKS_PATH, JSON.stringify(after))

    uninstallHooks()

    const final = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    expect(final.hooks?.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'echo user hook' }] }
    ])
    expect(final.hooks?.PreToolUse).toBeUndefined()
  })
})
