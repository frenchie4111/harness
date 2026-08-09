import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Fresh temp dir per suite; os.homedir() is mocked below to point at it
// so transcriptPathFor lands its reads/writes here.
let tmpHome: string

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: (): string => tmpHome
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', setPath: () => {}, isPackaged: false }
}))

// Manager constructor never spawns; forkAt is a pure fs + store op. But
// child_process is imported at the module top, so keep the mock in
// place to avoid any accidental real spawn from unrelated code paths
// that some future refactor might add.
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
    Object.assign(proc, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: vi.fn(), end: vi.fn() },
      kill: vi.fn()
    })
    return proc
  })
}))

import { Store } from './store'
import { JsonClaudeManager } from './json-claude-manager'

function transcriptDir(worktreePath: string): string {
  return join(tmpHome, '.claude', 'projects', worktreePath.replace(/[^a-zA-Z0-9]/g, '-'))
}

function makeManager(store: Store): JsonClaudeManager {
  return new JsonClaudeManager(store, {
    getClaudeCommand: () => 'claude',
    getUseSystemClaude: () => false,
    getApprovalSocketPath: (sid) => `/tmp/sock-${sid}`,
    closeApprovalSession: vi.fn(),
    getClaudeEnvVars: () => ({}),
    getControlServer: () => null,
    getControlBridgeScriptPath: () => '/tmp/bridge.js',
    isHarnessMcpEnabled: () => false,
    getCallerScope: () => null,
    getLaunchSettings: () => ({ tuiFullscreen: true })
  })
}

/** Seed a source session in the store + a matching jsonl on disk with
 *  a synthetic transcript: two assistant turns split into text +
 *  tool_use lines each, plus a user turn between them. */
function seedSource(
  store: Store,
  sessionId: string,
  worktreePath: string
): { targetApiId: string; targetEntryId: string } {
  const dir = transcriptDir(worktreePath)
  mkdirSync(dir, { recursive: true })

  const firstApiId = 'msg_first'
  const secondApiId = 'msg_second'

  const lines = [
    // First assistant turn: text + tool_use (same message.id).
    JSON.stringify({
      type: 'assistant',
      sessionId,
      message: { id: firstApiId, content: [{ type: 'text', text: 'hi' }] }
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId,
      message: { id: firstApiId, content: [{ type: 'tool_use', id: 'tu1', name: 'X' }] }
    }),
    // User turn between the two assistant turns.
    JSON.stringify({
      type: 'user',
      sessionId,
      message: { content: [{ type: 'text', text: 'ok' }] }
    }),
    // Second assistant turn — this is what we DON'T want in the fork.
    JSON.stringify({
      type: 'assistant',
      sessionId,
      message: { id: secondApiId, content: [{ type: 'text', text: 'more' }] }
    })
  ]
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8')

  store.dispatch({
    type: 'jsonClaude/sessionStarted',
    payload: { sessionId, worktreePath }
  })
  const targetEntryId = `${sessionId}-e-1`
  store.dispatch({
    type: 'jsonClaude/entriesSeeded',
    payload: {
      sessionId,
      entries: [
        {
          entryId: `${sessionId}-e-0`,
          kind: 'assistant',
          text: 'hi',
          timestamp: 1,
          apiMessageId: firstApiId
        },
        {
          entryId: targetEntryId,
          kind: 'assistant',
          text: 'more',
          timestamp: 2,
          apiMessageId: secondApiId
        }
      ]
    }
  })
  return { targetApiId: firstApiId, targetEntryId }
}

describe('JsonClaudeManager.forkAt', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'harness-fork-'))
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('copies transcript prefix into a new session file and rewrites sessionId on each kept line', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sourceId = '11111111-1111-1111-1111-111111111111'
    const worktree = '/tmp/wt-fork'

    // Fork off entry 0 (first assistant turn). Should keep lines
    // [0..1] (text + tool_use for firstApiId) and drop everything
    // after, including the user + second assistant lines.
    seedSource(store, sourceId, worktree)
    const result = mgr.forkAt(sourceId, `${sourceId}-e-0`)

    expect(result.ok).toBe(true)
    expect(result.newSessionId).toBeTruthy()
    expect(result.newSessionId).not.toBe(sourceId)

    const dir = transcriptDir(worktree)
    const dest = join(dir, `${result.newSessionId}.jsonl`)
    expect(existsSync(dest)).toBe(true)

    const written = readFileSync(dest, 'utf8').trim().split('\n')
    expect(written.length).toBe(2)
    for (const line of written) {
      const parsed = JSON.parse(line)
      expect(parsed.sessionId).toBe(result.newSessionId)
    }
    // Both kept lines are the first assistant turn's blocks.
    expect(JSON.parse(written[0]).message.id).toBe('msg_first')
    expect(JSON.parse(written[1]).message.id).toBe('msg_first')

    // Source file untouched.
    const source = readFileSync(join(dir, `${sourceId}.jsonl`), 'utf8')
      .trim()
      .split('\n')
    expect(source.length).toBe(4)
    for (const line of source) {
      expect(JSON.parse(line).sessionId).toBe(sourceId)
    }
  })

  it('forks on the last assistant message too (no follow-ups needed)', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sourceId = '22222222-2222-2222-2222-222222222222'
    const worktree = '/tmp/wt-fork-2'

    const { targetEntryId } = seedSource(store, sourceId, worktree)
    const result = mgr.forkAt(sourceId, targetEntryId)

    expect(result.ok).toBe(true)
    const dest = join(transcriptDir(worktree), `${result.newSessionId}.jsonl`)
    const lines = readFileSync(dest, 'utf8').trim().split('\n')
    // Kept everything through the second assistant line (all 4 lines).
    expect(lines.length).toBe(4)
    expect(JSON.parse(lines[3]).message.id).toBe('msg_second')
  })

  it('fails when the target entry lacks an apiMessageId', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sourceId = '33333333-3333-3333-3333-333333333333'
    const worktree = '/tmp/wt-fork-3'
    mkdirSync(transcriptDir(worktree), { recursive: true })
    writeFileSync(join(transcriptDir(worktree), `${sourceId}.jsonl`), '', 'utf8')

    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId: sourceId, worktreePath: worktree }
    })
    store.dispatch({
      type: 'jsonClaude/entriesSeeded',
      payload: {
        sessionId: sourceId,
        entries: [
          {
            entryId: `${sourceId}-e-0`,
            kind: 'assistant',
            text: 'hi',
            timestamp: 1
            // no apiMessageId
          }
        ]
      }
    })
    const result = mgr.forkAt(sourceId, `${sourceId}-e-0`)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/API id/)
  })

  it('rejects forking off a non-assistant entry', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sourceId = '44444444-4444-4444-4444-444444444444'
    const worktree = '/tmp/wt-fork-4'
    mkdirSync(transcriptDir(worktree), { recursive: true })
    writeFileSync(join(transcriptDir(worktree), `${sourceId}.jsonl`), '', 'utf8')

    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId: sourceId, worktreePath: worktree }
    })
    store.dispatch({
      type: 'jsonClaude/entriesSeeded',
      payload: {
        sessionId: sourceId,
        entries: [
          {
            entryId: `${sourceId}-e-0`,
            kind: 'user',
            text: 'hey',
            timestamp: 1
          }
        ]
      }
    })
    const result = mgr.forkAt(sourceId, `${sourceId}-e-0`)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/assistant/)
  })
})
