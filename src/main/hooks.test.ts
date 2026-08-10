import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { Store } from './store'
import { tailLog, cleanupTerminalLog, makeHookCommand } from './hooks'
import type { AgentKind } from '../shared/state/terminals'
import { initialState, type StateEvent, type AppState } from '../shared/state'

// tailLog reads from the real status dir (/tmp/harness-status). We use a
// unique terminal id per test so the module-level offset/residual maps and
// the on-disk .ndjson file never collide with other tests, and clean both
// up afterward via cleanupTerminalLog.
const STATUS_DIR = '/tmp/harness-status'

// Build one NDJSON hook record line as the bash hook command would emit it.
function record(event: string, payload: Record<string, unknown> | null, ts = 1): string {
  return JSON.stringify({ event, ts, payload }) + '\n'
}

function statusEvents(store: Store): StateEvent[] {
  const events: StateEvent[] = []
  store.subscribe((ev) => {
    if (ev.type === 'terminals/statusChanged') events.push(ev)
  })
  return events
}

function sessionIdEvents(store: Store): StateEvent[] {
  const events: StateEvent[] = []
  store.subscribe((ev) => {
    if (ev.type === 'terminals/sessionIdDiscovered') events.push(ev)
  })
  return events
}

function storeWithAgentTab(terminalId: string, agentKind: AgentKind): Store {
  const state: AppState = {
    ...initialState,
    terminals: {
      ...initialState.terminals,
      panes: {
        '/wt/a': {
          type: 'leaf',
          id: 'pane-1',
          tabs: [{ id: terminalId, type: 'agent', label: 'Agent', agentKind }],
          activeTabId: terminalId
        }
      }
    }
  }
  return new Store(state)
}

describe('tailLog — boot-replay guard', () => {
  let terminalId: string
  let logPath: string
  let counter = 0

  beforeEach(() => {
    mkdirSync(STATUS_DIR, { recursive: true })
    counter += 1
    terminalId = `test-hooks-${counter}-${process.pid}`
    logPath = join(STATUS_DIR, `${terminalId}.ndjson`)
  })

  afterEach(() => {
    cleanupTerminalLog(terminalId)
  })

  it('dispatches only one statusChanged on first touch of a long history', () => {
    // A terminal whose .ndjson survived a restart: many historical records
    // ending in a Stop (current status = waiting).
    const history =
      record('UserPromptSubmit', { session_id: 's' }) +
      record('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }) +
      record('PostToolUse', { tool_name: 'Bash' }) +
      record('PreToolUse', { tool_name: 'Edit', tool_input: {} }) +
      record('PostToolUse', { tool_name: 'Edit' }) +
      record('Stop', { session_id: 's', transcript_path: '/tmp/t.jsonl' })
    writeFileSync(logPath, history)

    const store = new Store()
    const events = statusEvents(store)

    tailLog(terminalId, store)

    // Naive read-from-0 would dispatch 6 status changes; the guard collapses
    // to just the final record's status.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'terminals/statusChanged',
      payload: { id: terminalId, status: 'waiting' }
    })
  })

  it('marks Cursor preToolUse as needs-approval (no separate ask event fires)', () => {
    // Cursor's preToolUse fires BEFORE the agent decides whether to auto-run
    // or block on the TUI approval prompt, and there's no follow-up "asking"
    // event. Regression guard: Claude's PascalCase PreToolUse stays as
    // processing (approval already happened).
    writeFileSync(logPath, record('sessionStart', { session_id: 's' }))
    const store = new Store()
    const events = statusEvents(store)
    tailLog(terminalId, store)
    events.length = 0

    appendFileSync(
      logPath,
      record('preToolUse', { tool_name: 'Shell', tool_input: { command: 'rm -rf /' } })
    )
    tailLog(terminalId, store)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      payload: {
        status: 'needs-approval',
        pendingTool: { name: 'Shell', input: { command: 'rm -rf /' } }
      }
    })

    appendFileSync(
      logPath,
      record('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    )
    tailLog(terminalId, store)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ payload: { status: 'processing' } })
  })

  it('adopts the session id via the tab agent\'s extractor', () => {
    writeFileSync(logPath, record('SessionStart', { session_id: 'codex-sess-1' }))
    const store = storeWithAgentTab(terminalId, 'codex')
    const events = sessionIdEvents(store)
    tailLog(terminalId, store)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      payload: { terminalId, sessionId: 'codex-sess-1' }
    })
  })

  it("does not adopt an ID from another agent's field name", () => {
    // Cursor's extractor reads `conversation_id`. A codex-tab payload
    // carrying a coincidental `conversation_id` must not be adopted —
    // codex's extractor only reads `session_id`.
    writeFileSync(logPath, record('SessionStart', { conversation_id: 'not-mine' }))
    const store = storeWithAgentTab(terminalId, 'codex')
    const events = sessionIdEvents(store)
    tailLog(terminalId, store)
    expect(events).toHaveLength(0)
  })

  it('skips discovery for claude tabs (assignsSessionId)', () => {
    writeFileSync(logPath, record('SessionStart', { session_id: 'claude-sess-1' }))
    const store = storeWithAgentTab(terminalId, 'claude')
    const events = sessionIdEvents(store)
    tailLog(terminalId, store)
    expect(events).toHaveLength(0)
  })

  it('processes every newly-appended line on subsequent tails', () => {
    writeFileSync(logPath, record('Stop', { session_id: 's' }))

    const store = new Store()
    const events = statusEvents(store)

    // First touch: seed offset to EOF, one dispatch for the last record.
    tailLog(terminalId, store)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ payload: { status: 'waiting' } })

    // Two live events arrive after boot. Both must be processed now that the
    // offset is seeded — no first-touch collapse on subsequent tails.
    appendFileSync(
      logPath,
      record('PreToolUse', { tool_name: 'Bash', tool_input: {} }) +
        record('Stop', { session_id: 's' })
    )
    tailLog(terminalId, store)

    expect(events).toHaveLength(3)
    expect(events[1]).toMatchObject({ payload: { status: 'processing' } })
    expect(events[2]).toMatchObject({ payload: { status: 'waiting' } })
  })
})

describe('makeHookCommand', () => {
  // Guards issue #198: legacy shell tab ids persisted in panes.json
  // contain path separators. bash `>>` won't create the intermediate
  // dirs, so the append fires ENOENT and every tool call surfaces a
  // "hook error" until the next boot re-installs the fixed hook.
  it('succeeds when $HARNESS_TERMINAL_ID contains path separators', () => {
    const nestedId = `test-hooks-nested-${process.pid}/legacy/sub-${Date.now()}`
    const cmd = makeHookCommand('PreToolUse')
    const nestedFile = join('/tmp/harness-status', `${nestedId}.ndjson`)
    // Precondition: the intermediate dirs must not exist — the whole
    // point of this test is that the hook has to create them.
    const topLegacyDir = join('/tmp/harness-status', `test-hooks-nested-${process.pid}`)
    try { rmSync(topLegacyDir, { recursive: true, force: true }) } catch { /* noop */ }
    try {
      execFileSync('bash', ['-c', cmd], {
        env: { ...process.env, HARNESS_TERMINAL_ID: nestedId },
        input: '{"tool_name":"Bash","tool_input":{"command":"ls"}}',
        stdio: ['pipe', 'pipe', 'pipe']
      })
      expect(existsSync(nestedFile)).toBe(true)
      const line = readFileSync(nestedFile, 'utf-8').trim()
      const parsed = JSON.parse(line)
      expect(parsed.event).toBe('PreToolUse')
      expect(parsed.payload).toMatchObject({ tool_name: 'Bash' })
    } finally {
      try { rmSync(topLegacyDir, { recursive: true, force: true }) } catch { /* noop */ }
    }
  })
})
