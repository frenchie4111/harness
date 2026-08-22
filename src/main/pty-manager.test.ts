import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'

// Regression coverage for bug #203: `createShell` must register the PTY
// synchronously so an agent's follow-up `read_shell_output` sees an alive
// shell instead of an empty buffer. The pre-spawn in `src/main/index.ts`
// depends on two load-bearing properties of `PtyManager.create`:
//   1. `hasTerminal(id)` becomes true immediately after `create()` returns.
//   2. A second `create()` for the same id is a no-op — required because
//      the renderer's XTerminal fires `pty:create` on mount, which would
//      otherwise kill+respawn the eagerly-spawned PTY.

// Minimal node-pty mock. The real spawn wants a compiled binary; the
// manager only touches the returned handle for onData/onExit/kill so a
// bare fake is enough.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 12345
  }))
}))

vi.mock('./debug', () => ({ log: vi.fn() }))

vi.mock('./hooks', () => ({ cleanupTerminalLog: vi.fn() }))

vi.mock('./persistence', () => ({
  saveTerminalHistory: vi.fn(),
  loadTerminalHistory: vi.fn(() => null),
  clearTerminalHistory: vi.fn()
}))

import { PtyManager } from './pty-manager'
import * as pty from 'node-pty'
import { loadTerminalHistory } from './persistence'

describe('PtyManager.create — eager spawn contract for createShell (#203)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the PTY synchronously so a follow-up hasTerminal check succeeds', () => {
    const mgr = new PtyManager()
    const id = 'shell-eager-1'
    mgr.create(id, tmpdir(), '', ['-ilc', 'echo hi'], undefined, true)
    expect(mgr.hasTerminal(id)).toBe(true)
    expect(pty.spawn).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — a second create for the same id (renderer XTerminal mount) does not respawn', () => {
    const mgr = new PtyManager()
    const id = 'shell-eager-2'
    mgr.create(id, tmpdir(), '', ['-ilc', 'echo hi'], undefined, true)
    mgr.create(id, tmpdir(), '', ['-ilc', 'echo hi'], undefined, true)
    expect(mgr.hasTerminal(id)).toBe(true)
    expect(pty.spawn).toHaveBeenCalledTimes(1)
  })

  it('does not register a PTY when cwd is missing (pre-flight guard)', () => {
    const mgr = new PtyManager()
    const id = 'shell-eager-3'
    mgr.create(id, '/definitely/does/not/exist', '', ['-il'], undefined, true)
    expect(mgr.hasTerminal(id)).toBe(false)
    expect(pty.spawn).not.toHaveBeenCalled()
  })
})

// On a cold app start the renderer asks for scrollback BEFORE it spawns, so
// getHistory has to reach the persisted file itself — reading only the
// in-memory map left restored tabs blank until something else seeded it.
describe('PtyManager.getHistory — persisted scrollback across an app restart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the persisted scrollback when nothing is in memory yet', () => {
    vi.mocked(loadTerminalHistory).mockReturnValueOnce('previous run output')
    const mgr = new PtyManager()
    expect(mgr.getHistory('shell-restored-1')).toBe('previous run output')
  })

  it('returns empty string when no history was persisted', () => {
    const mgr = new PtyManager()
    expect(mgr.getHistory('shell-restored-2')).toBe('')
  })

  it('reads the file once per id — the spawn that follows reuses the buffer', () => {
    vi.mocked(loadTerminalHistory).mockReturnValueOnce('previous run output')
    const mgr = new PtyManager()
    const id = 'shell-restored-3'
    mgr.getHistory(id)
    mgr.create(id, tmpdir(), '', ['-il'], undefined, true)
    expect(loadTerminalHistory).toHaveBeenCalledTimes(1)
    expect(mgr.getHistory(id)).toBe('previous run output')
  })

  it('drops both the buffer and the file on forgetHistory so a closed tab does not resurrect', () => {
    vi.mocked(loadTerminalHistory).mockReturnValue('previous run output')
    const mgr = new PtyManager()
    const id = 'shell-restored-4'
    expect(mgr.getHistory(id)).toBe('previous run output')
    vi.mocked(loadTerminalHistory).mockReturnValue(null)
    mgr.forgetHistory(id)
    expect(mgr.getHistory(id)).toBe('')
  })
})
