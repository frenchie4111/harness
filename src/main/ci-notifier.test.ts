import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

import { Store } from './store'
import { CiNotifier, buildCiFailureMessage } from './ci-notifier'
import { initialState, type AppState } from '../shared/state'
import type { PRStatus, CheckStatus } from '../shared/state/prs'
import type { JsonClaudeSession } from '../shared/state/json-claude'

const A = '/wt/a'
const B = '/wt/b'

function check(name: string, state: CheckStatus['state']): CheckStatus {
  return { name, state, description: `${name} said no` }
}

function pr(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 7,
    title: 'Add a thing',
    state: 'open',
    url: 'https://github.com/o/r/pull/7',
    branch: 'feat/thing',
    headSha: 'abc123',
    author: null,
    checks: [check('build', 'failure'), check('lint', 'success')],
    checksOverall: 'failure',
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: [],
    linkedIssues: [],
    labels: [],
    ...overrides
  }
}

function session(
  worktreePath: string,
  lastTs: number
): JsonClaudeSession {
  return {
    sessionId: 'ignored',
    worktreePath,
    state: 'running',
    exitCode: null,
    exitReason: null,
    entries: [{ entryId: 'e1', kind: 'user', timestamp: lastTs }],
    entriesHydrated: true,
    busy: false,
    permissionMode: 'acceptEdits',
    slashCommands: [],
    autoApprovedDecisions: {},
    sessionToolApprovals: [],
    sessionAllowedDecisions: {}
  }
}

function makeState(
  sessions: Record<string, JsonClaudeSession>,
  opts: { globalDefault?: boolean; overrides?: Record<string, boolean> } = {}
): AppState {
  return {
    ...initialState,
    settings: {
      ...initialState.settings,
      notifyChatOnCiFailure: opts.globalDefault ?? true
    },
    ciNotify: { byPath: { ...(opts.overrides ?? {}) } },
    jsonClaude: { ...initialState.jsonClaude, sessions }
  }
}

function setup(
  state: AppState,
  liveSessionIds: string[] = Object.keys(state.jsonClaude.sessions)
) {
  const store = new Store(state)
  const send = vi.fn()
  const notifier = new CiNotifier(store, {
    send,
    hasSession: (id) => liveSessionIds.includes(id)
  })
  notifier.start()
  return { store, send, notifier }
}

function bulk(store: Store, payload: Record<string, PRStatus | null>): void {
  store.dispatch({ type: 'prs/bulkStatusChanged', payload })
}

describe('CiNotifier transitions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('notifies when checks transition into failure', () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    expect(send).not.toHaveBeenCalled()
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('s1')
    expect(send.mock.calls[0][1]).toContain('CI is failing on PR #7')
  })

  it('does not notify on the first poll for an already-failing PR', () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).not.toHaveBeenCalled()
  })

  it('seeds from pre-existing store state so a pre-start poll is not a transition', () => {
    const state = makeState({ s1: session(A, 100) })
    const store = new Store({
      ...state,
      prs: { ...state.prs, byPath: { [A]: pr({ checksOverall: 'failure' }) } }
    })
    const send = vi.fn()
    new CiNotifier(store, { send, hasSession: () => true }).start()
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not notify on success or pending', () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'success' }) })
    expect(send).not.toHaveBeenCalled()
  })

  it('handles prs/statusChanged the same way as a bulk update', () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    store.dispatch({
      type: 'prs/statusChanged',
      payload: { path: A, status: pr({ checksOverall: 'success' }) }
    })
    store.dispatch({
      type: 'prs/statusChanged',
      payload: { path: A, status: pr({ checksOverall: 'failure' }) }
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('only notifies the worktree whose checks went red', () => {
    const { store, send } = setup(
      makeState({ s1: session(A, 100), s2: session(B, 100) })
    )
    bulk(store, {
      [A]: pr({ checksOverall: 'pending' }),
      [B]: pr({ checksOverall: 'pending' })
    })
    bulk(store, {
      [A]: pr({ checksOverall: 'failure' }),
      [B]: pr({ checksOverall: 'success' })
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('s1')
  })
})

describe('CiNotifier dedup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('notifies once per head commit even when the failure flaps', () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('re-notifies when a new head commit also fails', () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    bulk(store, { [A]: pr({ headSha: 'def456', checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ headSha: 'def456', checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('repeated failure polls without an intervening state change notify once', () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    bulk(store, { [A]: pr({ checksOverall: 'success' }) })
    for (let i = 0; i < 5; i++) {
      bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    }
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('falls back to the PR number when headSha is absent', () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    bulk(store, { [A]: pr({ headSha: undefined, checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ headSha: undefined, checksOverall: 'failure' }) })
    bulk(store, { [A]: pr({ headSha: undefined, checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ headSha: undefined, checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('drops caches when a worktree leaves the payload', () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
    bulk(store, {})
    // Re-appearing is a first observation again — record, don't notify.
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('CiNotifier enablement', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does nothing when the global default is off and there is no override', () => {
    const { store, send } = setup(
      makeState({ s1: session(A, 100) }, { globalDefault: false })
    )
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).not.toHaveBeenCalled()
  })

  it('a per-worktree true override beats a false global default', () => {
    const { store, send } = setup(
      makeState(
        { s1: session(A, 100) },
        { globalDefault: false, overrides: { [A]: true } }
      )
    )
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a per-worktree false override beats a true global default', () => {
    const { store, send } = setup(
      makeState(
        { s1: session(A, 100) },
        { globalDefault: true, overrides: { [A]: false } }
      )
    )
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('CiNotifier session selection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('skips worktrees with no chat session', () => {
    const { store, send } = setup(makeState({ s1: session(B, 100) }))
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).not.toHaveBeenCalled()
  })

  it('skips sessions with no live subprocess', () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }), [])
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).not.toHaveBeenCalled()
  })

  it('picks the most recently active session when a worktree has several', () => {
    const { store, send } = setup(
      makeState({ s1: session(A, 100), s2: session(A, 900), s3: session(A, 500) })
    )
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('s2')
  })

  it('ignores non-live sessions when picking the most recent', () => {
    const { store, send } = setup(
      makeState({ s1: session(A, 100), s2: session(A, 900) }),
      ['s1']
    )
    bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send.mock.calls[0][0]).toBe('s1')
  })
})

describe('buildCiFailureMessage', () => {
  it('lists failing checks with descriptions and detail urls', () => {
    const msg = buildCiFailureMessage(
      pr({
        checks: [
          { name: 'build', state: 'failure', description: 'exit code 1', detailsUrl: 'https://ci/1' },
          { name: 'lint', state: 'success', description: '' },
          { name: 'e2e', state: 'error', description: '', detailsUrl: 'https://ci/2' }
        ]
      })
    )
    expect(msg).toContain('CI is failing on PR #7 (feat/thing)')
    expect(msg).toContain('- build: exit code 1 — https://ci/1')
    expect(msg).toContain('- e2e — https://ci/2')
    expect(msg).not.toContain('lint')
  })

  it('falls back to the PR url when no individual check is failing', () => {
    const msg = buildCiFailureMessage(pr({ checks: [] }))
    expect(msg).toContain('https://github.com/o/r/pull/7')
  })

  it('truncates a very long failing-check list', () => {
    const checks = Array.from({ length: 14 }, (_, i) => check(`c${i}`, 'failure'))
    const msg = buildCiFailureMessage(pr({ checks }))
    expect(msg).toContain('…and 4 more')
  })
})
