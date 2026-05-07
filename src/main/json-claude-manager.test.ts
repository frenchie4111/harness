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
    spawnArgs: string[]
  }
  Object.assign(proc, { stdout, stderr, stdin, kill: vi.fn(), spawnArgs: [] })
  return proc
}

const spawnedProcs: ReturnType<typeof makeFakeProc>[] = []
const spawnCalls: Array<{ command: string; args: string[] }> = []

vi.mock('child_process', () => ({
  spawn: vi.fn((command: string, args: string[]) => {
    spawnCalls.push({ command, args })
    const proc = makeFakeProc()
    proc.spawnArgs = args
    spawnedProcs.push(proc)
    return proc
  })
}))

/** Filter to the real json-claude session spawns, excluding the
 *  slash-command probe that JsonClaudeManager fires alongside each
 *  create(). The session command line passes --permission-prompt-tool;
 *  the probe doesn't. */
function sessionProcs(): typeof spawnedProcs {
  return spawnedProcs.filter((p) =>
    p.spawnArgs.some((a) => a.includes('--permission-prompt-tool'))
  )
}

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
import type { ClaudeLaunchSettings } from './claude-launch'

describe('JsonClaudeManager', () => {
  beforeEach(() => {
    spawnedProcs.length = 0
    spawnCalls.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function makeManager(
    store: Store,
    launchSettings: ClaudeLaunchSettings = { tuiFullscreen: true },
    useSystemClaude = false
  ): JsonClaudeManager {
    return new JsonClaudeManager(store, {
      getClaudeCommand: () => 'claude',
      getUseSystemClaude: () => useSystemClaude,
      getApprovalSocketPath: (sid) => `/tmp/sock-${sid}`,
      closeApprovalSession: vi.fn(),
      getClaudeEnvVars: () => ({}),
      getControlServer: () => null,
      getControlBridgeScriptPath: () => '/tmp/bridge.js',
      isHarnessMcpEnabled: () => false,
      getCallerScope: () => null,
      getLaunchSettings: () => launchSettings
    })
  }

  /** Return the last session spawn's CLI args joined as a string. For the
   *  bundled path this is the args array; for the system-claude path
   *  (`<user-shell> -ilc <cmdLine>`) it's the cmdLine inside -ilc. Skips the
   *  slash-command probe spawn (which doesn't pass --permission-prompt-tool). */
  function lastSpawnCmdLine(): string {
    const sessionCalls = spawnCalls.filter((c) =>
      c.args.some((a) => a.includes('--permission-prompt-tool'))
    )
    const call = sessionCalls[sessionCalls.length - 1]
    expect(call).toBeDefined()
    if (call.args[0] === '-ilc') {
      return call.args[1]
    }
    return call.args.join(' ')
  }

  it("kill+create cycle: late exit from killed proc doesn't clobber the new instance", () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-A'
    const cwd = '/tmp/wt'

    // Initial spawn — instance A.
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId, worktreePath: cwd } })
    mgr.create(sessionId, cwd)
    const procA = sessionProcs()[0]
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
    const procB = sessionProcs()[1]
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

  it("multi-client safety: re-entering sessionStarted after running doesn't get stuck on 'connecting'", () => {
    // Repro of the two-viewer bug: when desktop + mobile both watch the
    // same json-claude tab during a tab-type swap, both renderers fire
    // startJsonClaude. The IPC handler used to dispatch sessionStarted
    // unconditionally on every call, and sessionStarted resets state to
    // 'connecting' — leaving the slice stuck because create() would
    // short-circuit (instance already running) and never re-emit
    // 'running'.
    //
    // The fix gates the start path on hasSession() in the IPC handler.
    // This test models a caller that respects the guard.
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-C'
    const cwd = '/tmp/wt'

    function startIfFresh(): void {
      if (mgr.hasSession(sessionId)) return
      store.dispatch({
        type: 'jsonClaude/sessionStarted',
        payload: { sessionId, worktreePath: cwd }
      })
      mgr.create(sessionId, cwd)
    }

    startIfFresh()
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')

    // Second client mounts and races into the start path.
    startIfFresh()

    // Without the guard, state would be reset to 'connecting' here.
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')
    // Only one session proc was actually spawned — guard short-circuited
    // the second call. (Probes are per-cwd, also one.)
    expect(sessionProcs().length).toBe(1)
  })

  it('passes --append-system-prompt, --model, --name when launch settings are set (system claude path)', () => {
    const store = new Store()
    const mgr = makeManager(
      store,
      {
        systemPrompt: 'BASE\n\nMAIN',
        model: 'opus',
        sessionName: 'myrepo/feat-x',
        tuiFullscreen: true
      },
      true
    )
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId: 'sess-flags', worktreePath: '/tmp/wt' } })
    mgr.create('sess-flags', '/tmp/wt')
    const cmd = lastSpawnCmdLine()
    expect(cmd).toContain('--append-system-prompt')
    expect(cmd).toContain("'BASE\n\nMAIN'")
    expect(cmd).toContain('--model')
    expect(cmd).toContain("'opus'")
    expect(cmd).toContain('--name')
    expect(cmd).toContain("'myrepo/feat-x'")
  })

  // Regression: the system prompt contains literal backticks (e.g.
  // `key`, `zsh -ilc <command>`). When args were JSON.stringified into
  // double quotes, zsh -ilc would still command-substitute the
  // backticks (→ "command not found: key", exit 127) and parse-error
  // on the redirection token inside the substitution. Single-quoted
  // form makes everything inert. Specific to the system-claude path —
  // bundled spawn passes args as an array, no shell parses them.
  it('single-quotes args so backticks in the system prompt are not command-substituted (system claude path)', () => {
    const store = new Store()
    const mgr = makeManager(
      store,
      {
        systemPrompt: 'a `key` b',
        tuiFullscreen: true
      },
      true
    )
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId: 'sess-bt', worktreePath: '/tmp/wt' } })
    mgr.create('sess-bt', '/tmp/wt')
    const cmd = lastSpawnCmdLine()
    expect(cmd).toContain("'a `key` b'")
    expect(cmd).not.toContain('"a `key` b"')
  })

  it('bundled path: spawns the resolved binary directly with args as an array (no shell wrapping)', () => {
    const store = new Store()
    const mgr = makeManager(store, {
      systemPrompt: 'BASE',
      model: 'opus',
      sessionName: 'r/b',
      tuiFullscreen: true
    })
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId: 'sess-bundled', worktreePath: '/tmp/wt' } })
    mgr.create('sess-bundled', '/tmp/wt')
    const sessionCalls = spawnCalls.filter((c) =>
      c.args.some((a) => a.includes('--permission-prompt-tool'))
    )
    const call = sessionCalls[sessionCalls.length - 1]
    expect(call).toBeDefined()
    expect(call.args[0]).not.toBe('-ilc')
    // Resolves to the platform-matching native binary inside the bundled
    // optional subpackage. Filename is `claude` on POSIX, `claude.exe` on
    // Windows; either is fine here.
    expect(call.command).toMatch(/[/\\]claude(\.exe)?$/)
    expect(call.args).toContain('--append-system-prompt')
    expect(call.args).toContain('BASE')
    expect(call.args).toContain('--model')
    expect(call.args).toContain('opus')
    expect(call.args).toContain('--name')
    expect(call.args).toContain('r/b')
  })

  it('omits --append-system-prompt, --model, --name when launch settings are unset', () => {
    const store = new Store()
    const mgr = makeManager(store, { tuiFullscreen: true })
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId: 'sess-empty', worktreePath: '/tmp/wt' } })
    mgr.create('sess-empty', '/tmp/wt')
    const cmd = lastSpawnCmdLine()
    expect(cmd).not.toContain('--append-system-prompt')
    expect(cmd).not.toContain('--model')
    expect(cmd).not.toContain('--name')
  })

  it('rate_limit_event over threshold emits one warning card; back-to-back duplicates dedup', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-rl-warn'
    const cwd = '/tmp/wt'
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: cwd }
    })
    mgr.create(sessionId, cwd)
    const proc = sessionProcs()[0]
    const event = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'warning',
        utilization: 0.9,
        resetsAt: 1_700_000_000,
        rateLimitType: 'five_hour'
      }
    }
    const line = JSON.stringify(event) + '\n'
    proc.stdout.emit('data', Buffer.from(line))
    proc.stdout.emit('data', Buffer.from(line))
    const entries =
      store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []
    const warnings = entries.filter(
      (e) => e.errorKind === 'rate-limit-warning'
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0].kind).toBe('system')
    expect(warnings[0].rateLimitDetail?.utilization).toBe(0.9)
    expect(warnings[0].rateLimitDetail?.tier).toBe('five_hour')
    // resetsAt was seconds (< 1e12) → coerced to ms.
    expect(warnings[0].rateLimitDetail?.resetAt).toBe(1_700_000_000_000)
  })

  it('rate_limit_event below threshold does not emit a card and clears dedup', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-rl-low'
    const cwd = '/tmp/wt'
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: cwd }
    })
    mgr.create(sessionId, cwd)
    const proc = sessionProcs()[0]
    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed', utilization: 0.4 }
        }) + '\n'
      )
    )
    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'warning', utilization: 0.85 }
        }) + '\n'
      )
    )
    const entries =
      store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []
    const warnings = entries.filter(
      (e) => e.errorKind === 'rate-limit-warning'
    )
    // Only the over-threshold event surfaced.
    expect(warnings).toHaveLength(1)
  })

  it('result subtype error_during_execution with rate-limit terminal_reason emits an error card', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-rl-err'
    const cwd = '/tmp/wt'
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: cwd }
    })
    mgr.create(sessionId, cwd)
    const proc = sessionProcs()[0]
    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          terminal_reason: 'blocking_limit',
          errors: ['429 rate_limit: usage limit reached']
        }) + '\n'
      )
    )
    const entries =
      store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []
    const errs = entries.filter((e) => e.errorKind === 'rate-limit-error')
    expect(errs).toHaveLength(1)
    expect(errs[0].kind).toBe('error')
    expect(errs[0].errorMessage).toContain('429')
  })

  it("new proc's own exit event still updates state (guard doesn't block legitimate exits)", () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-B'
    const cwd = '/tmp/wt'

    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId, worktreePath: cwd } })
    mgr.create(sessionId, cwd)
    const proc = sessionProcs()[0]
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')

    // Subprocess exits on its own — guard should NOT bail because this is
    // the currently-registered instance's own exit.
    proc.emit('exit', 1, null)
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('exited')
  })

  it('answerAskUserQuestion writes a tool_result frame to stdin and dispatches toolResultAttached', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-auq'
    const cwd = '/tmp/wt'
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: cwd }
    })
    mgr.create(sessionId, cwd)
    const proc = sessionProcs()[0]
    proc.stdin.write.mockClear()

    mgr.answerAskUserQuestion(sessionId, 'tu_42', {
      'Which library?': ['Day.js'],
      'Which features?': ['SSO', 'MFA']
    })

    expect(proc.stdin.write).toHaveBeenCalledTimes(1)
    const writtenLine = proc.stdin.write.mock.calls[0][0] as string
    const parsed = JSON.parse(writtenLine.trimEnd())
    expect(parsed.type).toBe('user')
    expect(parsed.message.role).toBe('user')
    expect(parsed.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_42',
        content: expect.stringContaining(
          'User has answered your questions:'
        )
      }
    ])
    const content = parsed.message.content[0].content as string
    expect(content).toContain('"Which library?"="Day.js"')
    // multi-select labels are joined with ", "
    expect(content).toContain('"Which features?"="SSO, MFA"')

    // Optimistic dispatch flips the card to the answered state immediately.
    const entries =
      store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []
    const tr = entries.find((e) => e.kind === 'tool_result')
    expect(tr).toBeDefined()
    expect(tr?.blocks?.[0]?.toolUseId).toBe('tu_42')
    expect(tr?.blocks?.[0]?.content).toBe(content)
    expect(tr?.blocks?.[0]?.isError).toBe(false)
  })

  it('answerAskUserQuestion records "(no option selected)" when a question gets no picks', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-auq-skip'
    const cwd = '/tmp/wt'
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: cwd }
    })
    mgr.create(sessionId, cwd)
    const proc = sessionProcs()[0]
    proc.stdin.write.mockClear()

    mgr.answerAskUserQuestion(sessionId, 'tu_skip', {
      'Skipped question?': []
    })

    const writtenLine = proc.stdin.write.mock.calls[0][0] as string
    const parsed = JSON.parse(writtenLine.trimEnd())
    const content = parsed.message.content[0].content as string
    expect(content).toContain('"Skipped question?"=(no option selected)')
  })
})
