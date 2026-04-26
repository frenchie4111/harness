import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// Mock child_process.spawn before importing JsonClaudeManager. Each spawn()
// call returns a fresh fake process: an EventEmitter with .stdout, .stderr,
// .stdin, and .kill — enough for the manager to wire its handlers and for
// the test to fire 'exit' / 'data' events at will.
function makeFakeProc() {
  const stdout = new EventEmitter() as EventEmitter & { on: typeof EventEmitter.prototype.on }
  const stderr = new EventEmitter()
  const stdin = { write: vi.fn(), end: vi.fn() }
  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout
    stderr: typeof stderr
    stdin: typeof stdin
    kill: ReturnType<typeof vi.fn>
  }
  Object.assign(proc, { stdout, stderr, stdin, kill: vi.fn() })
  return proc
}

const spawnedProcs: ReturnType<typeof makeFakeProc>[] = []

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = makeFakeProc()
    spawnedProcs.push(proc)
    return proc
  })
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', setPath: () => {}, isPackaged: false }
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: () => false,
    readFileSync: () => ''
  }
})

import { Store } from './store'
import { JsonClaudeManager } from './json-claude-manager'

describe('JsonClaudeManager', () => {
  beforeEach(() => {
    spawnedProcs.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function makeManager(store: Store): JsonClaudeManager {
    return new JsonClaudeManager(store, {
      getClaudeCommand: () => 'claude',
      getApprovalSocketPath: (sid) => `/tmp/sock-${sid}`,
      closeApprovalSession: vi.fn(),
      getClaudeEnvVars: () => ({}),
      getControlServer: () => null,
      getControlBridgeScriptPath: () => '/tmp/bridge.js',
      isHarnessMcpEnabled: () => false,
      getCallerScope: () => null
    })
  }

  it("kill+create cycle: late exit from killed proc doesn't clobber the new instance", () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-A'
    const cwd = '/tmp/wt'

    // Initial spawn — instance A.
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId, worktreePath: cwd } })
    mgr.create(sessionId, cwd)
    const procA = spawnedProcs[0]
    expect(procA).toBeDefined()
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')

    // Kill A. SIGTERM is async; A's exit hasn't fired yet.
    mgr.kill(sessionId)
    expect(procA.kill).toHaveBeenCalledWith('SIGTERM')
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('exited')

    // The convertTabType path also clears the slice entry; mirror that
    // here so we see the same starting state the production code lands
    // in before the renderer fires its mount-time start.
    store.dispatch({ type: 'jsonClaude/sessionCleared', payload: { sessionId } })
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]).toBeUndefined()

    // Re-create — instance B. Same sessionId, fresh proc.
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId, worktreePath: cwd } })
    mgr.create(sessionId, cwd)
    const procB = spawnedProcs[1]
    expect(procB).toBeDefined()
    expect(procB).not.toBe(procA)
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')

    // Now the OS finally kills proc A — its 'exit' event fires LATE,
    // after B is already registered. Without the stale-exit guard, this
    // would dispatch state='exited' against B and close B's approval
    // socket. With the guard, it's a no-op.
    procA.emit('exit', null, 'SIGTERM')

    // B's state must still be 'running'.
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')
  })

  it("new proc's own exit event still updates state (guard doesn't block legitimate exits)", () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-B'
    const cwd = '/tmp/wt'

    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId, worktreePath: cwd } })
    mgr.create(sessionId, cwd)
    const proc = spawnedProcs[0]
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')

    // Subprocess exits on its own — guard should NOT bail because this is
    // the currently-registered instance's own exit.
    proc.emit('exit', 1, null)
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('exited')
  })
})
