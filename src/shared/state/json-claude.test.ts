import { describe, it, expect } from 'vitest'
import {
  initialJsonClaude,
  jsonClaudeReducer,
  type JsonClaudeState,
  type JsonClaudeChatEntry
} from './json-claude'

const WT = '/tmp/wt'
const SID = 'session-1'

function seedSession(state: JsonClaudeState): JsonClaudeState {
  return jsonClaudeReducer(state, {
    type: 'jsonClaude/sessionStarted',
    payload: { sessionId: SID, worktreePath: WT }
  })
}

describe('jsonClaudeReducer', () => {
  it('sessionStarted creates a connecting session with empty entries', () => {
    const next = seedSession(initialJsonClaude)
    expect(next.sessions[SID].state).toBe('connecting')
    expect(next.sessions[SID].worktreePath).toBe(WT)
    expect(next.sessions[SID].entries).toEqual([])
    expect(next.sessions[SID].busy).toBe(false)
  })

  it('sessionStateChanged updates state + exit info', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId: SID, state: 'running' }
    })
    expect(state.sessions[SID].state).toBe('running')
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionStateChanged',
      payload: {
        sessionId: SID,
        state: 'exited',
        exitCode: 0,
        exitReason: 'clean'
      }
    })
    expect(state.sessions[SID].state).toBe('exited')
    expect(state.sessions[SID].exitCode).toBe(0)
    expect(state.sessions[SID].exitReason).toBe('clean')
  })

  it('sessionStateChanged is a no-op for unknown session', () => {
    const next = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId: 'missing', state: 'running' }
    })
    expect(next).toBe(initialJsonClaude)
  })

  it('entryAppended appends to the session transcript', () => {
    let state = seedSession(initialJsonClaude)
    const entry: JsonClaudeChatEntry = {
      entryId: 'e1',
      kind: 'user',
      text: 'hi',
      timestamp: 1
    }
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: { sessionId: SID, entry }
    })
    expect(state.sessions[SID].entries).toEqual([entry])
  })

  it('toolResultAttached appends a tool_result entry', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/toolResultAttached',
      payload: {
        sessionId: SID,
        toolUseId: 'toolu_abc',
        content: 'ok',
        isError: false
      }
    })
    expect(state.sessions[SID].entries).toHaveLength(1)
    expect(state.sessions[SID].entries[0].kind).toBe('tool_result')
    expect(state.sessions[SID].entries[0].blocks?.[0].toolUseId).toBe('toolu_abc')
  })

  it('busyChanged toggles the busy flag', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/busyChanged',
      payload: { sessionId: SID, busy: true }
    })
    expect(state.sessions[SID].busy).toBe(true)
  })

  it('sessionCleared drops session + any pending approvals from it', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/approvalRequested',
      payload: {
        requestId: 'r1',
        sessionId: SID,
        toolName: 'Write',
        input: { file_path: '/tmp/x' },
        timestamp: 0
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionCleared',
      payload: { sessionId: SID }
    })
    expect(state.sessions[SID]).toBeUndefined()
    expect(state.pendingApprovals.r1).toBeUndefined()
  })

  it('approvalRequested + approvalResolved flow through pendingApprovals', () => {
    let state = initialJsonClaude
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/approvalRequested',
      payload: {
        requestId: 'r1',
        sessionId: SID,
        toolName: 'Bash',
        input: { command: 'ls' },
        toolUseId: 'toolu_1',
        timestamp: 10
      }
    })
    expect(state.pendingApprovals.r1.toolName).toBe('Bash')
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/approvalResolved',
      payload: { requestId: 'r1' }
    })
    expect(state.pendingApprovals.r1).toBeUndefined()
  })

  it('approvalResolved for an unknown id is a no-op', () => {
    const next = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/approvalResolved',
      payload: { requestId: 'missing' }
    })
    expect(next).toBe(initialJsonClaude)
  })

  it('permissionModeChanged flips the mode on an existing session', () => {
    let state = seedSession(initialJsonClaude)
    expect(state.sessions[SID].permissionMode).toBe('default')
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/permissionModeChanged',
      payload: { sessionId: SID, mode: 'acceptEdits' }
    })
    expect(state.sessions[SID].permissionMode).toBe('acceptEdits')
  })

  it('permissionModeChanged is a no-op for unknown session', () => {
    const next = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/permissionModeChanged',
      payload: { sessionId: 'missing', mode: 'acceptEdits' }
    })
    expect(next).toBe(initialJsonClaude)
  })
})
