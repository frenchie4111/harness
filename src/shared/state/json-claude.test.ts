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

  it('assistantTextDelta appends to the matching entry text block', () => {
    let state = seedSession(initialJsonClaude)
    const entry: JsonClaudeChatEntry = {
      entryId: 'a1',
      kind: 'assistant',
      blocks: [{ type: 'text', text: '' }],
      timestamp: 1,
      isPartial: true
    }
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: { sessionId: SID, entry }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantTextDelta',
      payload: { sessionId: SID, entryId: 'a1', textDelta: 'Hello' }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantTextDelta',
      payload: { sessionId: SID, entryId: 'a1', textDelta: ' world' }
    })
    expect(state.sessions[SID].entries[0].blocks?.[0].text).toBe('Hello world')
    expect(state.sessions[SID].entries[0].isPartial).toBe(true)
  })

  it('assistantTextDelta targets the LAST text block when multiple exist', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: {
          entryId: 'a1',
          kind: 'assistant',
          blocks: [
            { type: 'text', text: 'first ' },
            { type: 'tool_use', id: 't1', name: 'Read' },
            { type: 'text', text: 'second ' }
          ],
          timestamp: 1,
          isPartial: true
        }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantTextDelta',
      payload: { sessionId: SID, entryId: 'a1', textDelta: 'tail' }
    })
    const blocks = state.sessions[SID].entries[0].blocks!
    expect(blocks[0].text).toBe('first ')
    expect(blocks[2].text).toBe('second tail')
  })

  it('assistantBlockAppended pushes a block onto the entry', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: {
          entryId: 'a1',
          kind: 'assistant',
          blocks: [{ type: 'text', text: 'hi' }],
          timestamp: 1,
          isPartial: true
        }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantBlockAppended',
      payload: {
        sessionId: SID,
        entryId: 'a1',
        block: { type: 'tool_use', id: 't1', name: 'Read' }
      }
    })
    const blocks = state.sessions[SID].entries[0].blocks!
    expect(blocks).toHaveLength(2)
    expect(blocks[1].type).toBe('tool_use')
    expect(blocks[1].name).toBe('Read')
  })

  it('assistantBlockAppended is a no-op for an unknown entry', () => {
    const state = seedSession(initialJsonClaude)
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantBlockAppended',
      payload: {
        sessionId: SID,
        entryId: 'missing',
        block: { type: 'tool_use', id: 't1', name: 'Read' }
      }
    })
    expect(next).toBe(state)
  })

  it('assistantTextDelta is a no-op for an unknown entry', () => {
    const state = seedSession(initialJsonClaude)
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantTextDelta',
      payload: { sessionId: SID, entryId: 'missing', textDelta: 'x' }
    })
    expect(next).toBe(state)
  })

  it('assistantEntryFinalized replaces blocks and clears isPartial', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: {
          entryId: 'a1',
          kind: 'assistant',
          blocks: [{ type: 'text', text: 'Hello wor' }],
          timestamp: 1,
          isPartial: true
        }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantEntryFinalized',
      payload: {
        sessionId: SID,
        entryId: 'a1',
        blocks: [
          { type: 'text', text: 'Hello world' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }
        ]
      }
    })
    const finalized = state.sessions[SID].entries[0]
    expect(finalized.isPartial).toBeUndefined()
    expect(finalized.blocks).toHaveLength(2)
    expect(finalized.blocks?.[0].text).toBe('Hello world')
    expect(finalized.blocks?.[1].type).toBe('tool_use')
  })

  it('assistantEntryFinalized is a no-op when entry not found', () => {
    const state = seedSession(initialJsonClaude)
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantEntryFinalized',
      payload: {
        sessionId: SID,
        entryId: 'missing',
        blocks: [{ type: 'text', text: 'x' }]
      }
    })
    expect(next).toBe(state)
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
