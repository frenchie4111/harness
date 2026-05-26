// Drift detector: the static hooks.json shipped under
// resources/plugins/harness-status/hooks/hooks.json must match what
// makeHookCommand() would generate today. If src/main/hooks.ts ever
// changes the hook command shape, this test fails so the static file
// gets regenerated in the same commit.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { makeHookCommand } from './hooks'

const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification'
]

function expectedHooksJson(): string {
  const hooks: Record<string, unknown[]> = {}
  for (const event of HOOK_EVENTS) {
    hooks[event] = [
      { hooks: [{ type: 'command', command: makeHookCommand(event), timeout: 5 }] }
    ]
  }
  return JSON.stringify({ hooks }, null, 2) + '\n'
}

describe('bundled harness-status plugin', () => {
  it('hooks.json matches makeHookCommand() output', () => {
    // Resolve from cwd (vitest runs from the repo root) so this test
    // doesn't break when the file gets compiled into out/ by tsc -b.
    const path = join(process.cwd(), 'resources', 'plugins', 'harness-status', 'hooks', 'hooks.json')
    const actual = readFileSync(path, 'utf-8')
    expect(actual).toBe(expectedHooksJson())
  })
})
