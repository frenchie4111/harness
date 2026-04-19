import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock electron + node-pty before importing PtyManager. The manager touches
// electron.app.getPath() transitively (debug.ts → log file) and spawns real
// PTY processes via node-pty. The test exercises only the tail buffer path,
// so we replace spawn with a stub that exposes the registered onData/onExit
// callbacks for the test to fire synthetic bytes through.

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    setPath: () => {},
    isPackaged: false
  }
}))

interface FakePty {
  id: string
  pid: number
  dataHandlers: Array<(data: string) => void>
  exitHandlers: Array<(e: { exitCode: number; signal?: number }) => void>
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
}

const fakePtys: FakePty[] = []

vi.mock('node-pty', () => ({
  spawn: (_shell: string, _args: string[], _opts: unknown): FakePty => {
    const fake: FakePty = {
      id: String(fakePtys.length),
      pid: 10000 + fakePtys.length,
      dataHandlers: [],
      exitHandlers: [],
      onData(cb) {
        this.dataHandlers.push(cb)
      },
      onExit(cb) {
        this.exitHandlers.push(cb)
      },
      write() {},
      resize() {},
      kill() {}
    }
    fakePtys.push(fake)
    return fake
  }
}))

vi.mock('./persistence', () => ({
  saveTerminalHistory: vi.fn(),
  loadTerminalHistory: vi.fn(() => null),
  clearTerminalHistory: vi.fn()
}))

vi.mock('./hooks', () => ({
  cleanupTerminalLog: vi.fn()
}))

vi.mock('./debug', () => ({
  log: vi.fn()
}))

// process.kill is called on kill() — stub it so the test doesn't try to signal
// our own process. spawning the FakePty with a fake pid above makes this safe
// to intercept: nothing real depends on it.
const originalProcessKill = process.kill
beforeEach(() => {
  fakePtys.length = 0
  process.kill = (() => true) as typeof process.kill
})

afterEach(() => {
  process.kill = originalProcessKill
})

import { PtyManager } from './pty-manager'

const TAIL_CAP_BYTES = 200 * 1024

function createTerminal(mgr: PtyManager, id: string): FakePty {
  mgr.create(id, '/tmp', '/bin/zsh', ['-il'])
  const fake = fakePtys[fakePtys.length - 1]
  if (!fake) throw new Error('fake pty not registered')
  return fake
}

function emit(fake: FakePty, data: string): void {
  for (const cb of fake.dataHandlers) cb(data)
}

function fireExit(fake: FakePty, exitCode = 0): void {
  for (const cb of fake.exitHandlers) cb({ exitCode })
}

describe('PtyManager tail buffer', () => {
  it('is empty on fresh create', () => {
    const mgr = new PtyManager()
    createTerminal(mgr, 'a')
    expect(mgr.getTerminalTail('a')).toBe('')
  })

  it('returns empty for unknown terminal id', () => {
    const mgr = new PtyManager()
    expect(mgr.getTerminalTail('ghost')).toBe('')
  })

  it('accumulates chunks appended through onData', () => {
    const mgr = new PtyManager()
    const fake = createTerminal(mgr, 'a')
    emit(fake, 'hello')
    emit(fake, ' world')
    expect(mgr.getTerminalTail('a')).toBe('hello world')
  })

  it('drops oldest chunks when total exceeds cap', () => {
    const mgr = new PtyManager()
    const fake = createTerminal(mgr, 'a')
    // Three chunks, each just over half the cap — first should get dropped
    // when the third arrives.
    const half = TAIL_CAP_BYTES - 10
    const chunkA = 'A'.repeat(half)
    const chunkB = 'B'.repeat(100)
    const chunkC = 'C'.repeat(100)
    emit(fake, chunkA)
    emit(fake, chunkB)
    emit(fake, chunkC)
    const tail = mgr.getTerminalTail('a')
    expect(tail.length).toBeLessThanOrEqual(TAIL_CAP_BYTES)
    // The early 'A' run must be gone because chunkA was dropped wholesale
    // once chunkB's append pushed total over the cap.
    expect(tail.startsWith('A')).toBe(false)
    // The most recent writes must survive.
    expect(tail.endsWith(chunkC)).toBe(true)
  })

  it('keeps exactly cap bytes when the last chunk fits to the byte', () => {
    const mgr = new PtyManager()
    const fake = createTerminal(mgr, 'a')
    const exact = 'X'.repeat(TAIL_CAP_BYTES)
    emit(fake, exact)
    expect(mgr.getTerminalTail('a').length).toBe(TAIL_CAP_BYTES)
  })

  it('truncates a single chunk larger than the cap to the cap size', () => {
    const mgr = new PtyManager()
    const fake = createTerminal(mgr, 'a')
    // A single chunk exceeding the cap — must still end up ≤ cap, and the
    // content must be the tail of the original chunk (front bytes dropped).
    const overflow = 'Z'.repeat(TAIL_CAP_BYTES + 5000)
    emit(fake, overflow)
    const tail = mgr.getTerminalTail('a')
    expect(tail.length).toBe(TAIL_CAP_BYTES)
    // All 'Z' — content-wise unchanged, just shorter.
    expect(tail).toBe('Z'.repeat(TAIL_CAP_BYTES))
  })

  it('clears the tail when the PTY exits', () => {
    const mgr = new PtyManager()
    const fake = createTerminal(mgr, 'a')
    emit(fake, 'bytes before exit')
    expect(mgr.getTerminalTail('a')).toBe('bytes before exit')
    fireExit(fake)
    expect(mgr.getTerminalTail('a')).toBe('')
  })

  it('clears the tail when kill() is called', () => {
    const mgr = new PtyManager()
    const fake = createTerminal(mgr, 'a')
    emit(fake, 'alive')
    expect(mgr.getTerminalTail('a')).toBe('alive')
    mgr.kill('a')
    expect(mgr.getTerminalTail('a')).toBe('')
  })

  it('starts fresh when a new PTY is created for a recycled id', () => {
    const mgr = new PtyManager()
    const first = createTerminal(mgr, 'a')
    emit(first, 'first session output')
    mgr.kill('a')
    expect(mgr.getTerminalTail('a')).toBe('')
    // A second create with the same id should give a fresh buffer, not
    // inherit anything from the first.
    const second = createTerminal(mgr, 'a')
    emit(second, 'second')
    expect(mgr.getTerminalTail('a')).toBe('second')
  })

  it('keeps separate tails per terminal id', () => {
    const mgr = new PtyManager()
    const a = createTerminal(mgr, 'a')
    const b = createTerminal(mgr, 'b')
    emit(a, 'alpha')
    emit(b, 'bravo')
    expect(mgr.getTerminalTail('a')).toBe('alpha')
    expect(mgr.getTerminalTail('b')).toBe('bravo')
  })
})
