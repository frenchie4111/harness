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

  it('entryAppended carries subprocess-exit error fields verbatim', () => {
    let state = seedSession(initialJsonClaude)
    const entry: JsonClaudeChatEntry = {
      entryId: 'e1',
      kind: 'error',
      timestamp: 42,
      errorKind: 'subprocess-exit',
      errorMessage: 'spawn ENOTDIR',
      exitWasClean: false
    }
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: { sessionId: SID, entry }
    })
    expect(state.sessions[SID].entries).toEqual([entry])
    const stored = state.sessions[SID].entries[0]
    expect(stored.kind).toBe('error')
    expect(stored.errorKind).toBe('subprocess-exit')
    expect(stored.errorMessage).toBe('spawn ENOTDIR')
    expect(stored.exitWasClean).toBe(false)
  })

  it('entriesSeeded replaces the session entries array in one shot', () => {
    let state = seedSession(initialJsonClaude)
    const entries: JsonClaudeChatEntry[] = [
      { entryId: 'e1', kind: 'user', text: 'hi', timestamp: 1 },
      {
        entryId: 'e2',
        kind: 'assistant',
        blocks: [{ type: 'text', text: 'hello' }],
        timestamp: 2
      }
    ]
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entriesSeeded',
      payload: { sessionId: SID, entries }
    })
    expect(state.sessions[SID].entries).toEqual(entries)
  })

  it('entriesSeeded is a no-op for unknown session', () => {
    const next = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/entriesSeeded',
      payload: { sessionId: 'missing', entries: [] }
    })
    expect(next).toBe(initialJsonClaude)
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

  it('assistantThinkingDelta appends to the last thinking block', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: {
          entryId: 'a1',
          kind: 'assistant',
          blocks: [{ type: 'thinking', text: '' }],
          timestamp: 1,
          isPartial: true
        }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantThinkingDelta',
      payload: { sessionId: SID, entryId: 'a1', textDelta: 'Let me ' }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantThinkingDelta',
      payload: { sessionId: SID, entryId: 'a1', textDelta: 'think.' }
    })
    expect(state.sessions[SID].entries[0].blocks?.[0].type).toBe('thinking')
    expect(state.sessions[SID].entries[0].blocks?.[0].text).toBe(
      'Let me think.'
    )
  })

  it('assistantThinkingDelta targets thinking, not text, when both exist', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: {
          entryId: 'a1',
          kind: 'assistant',
          blocks: [
            { type: 'thinking', text: 'thought ' },
            { type: 'text', text: 'said ' }
          ],
          timestamp: 1,
          isPartial: true
        }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantThinkingDelta',
      payload: { sessionId: SID, entryId: 'a1', textDelta: 'more' }
    })
    const blocks = state.sessions[SID].entries[0].blocks!
    expect(blocks[0].text).toBe('thought more')
    expect(blocks[1].text).toBe('said ')
  })

  it('assistantThinkingDelta appends a thinking block when none exists', () => {
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
      type: 'jsonClaude/assistantThinkingDelta',
      payload: { sessionId: SID, entryId: 'a1', textDelta: 'hmm' }
    })
    const blocks = state.sessions[SID].entries[0].blocks!
    expect(blocks).toHaveLength(2)
    expect(blocks[1].type).toBe('thinking')
    expect(blocks[1].text).toBe('hmm')
  })

  it('assistantThinkingDelta is a no-op for an unknown entry', () => {
    const state = seedSession(initialJsonClaude)
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantThinkingDelta',
      payload: { sessionId: SID, entryId: 'missing', textDelta: 'x' }
    })
    expect(next).toBe(state)
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

  it('assistantBlockAppended preserves reference identity for untouched entries', () => {
    let state = seedSession(initialJsonClaude)
    const e1: JsonClaudeChatEntry = {
      entryId: 'u1',
      kind: 'user',
      text: 'hi',
      timestamp: 1
    }
    const e2: JsonClaudeChatEntry = {
      entryId: 'a1',
      kind: 'assistant',
      blocks: [{ type: 'text', text: 'hello' }],
      timestamp: 2,
      isPartial: true
    }
    const e3: JsonClaudeChatEntry = {
      entryId: 'u2',
      kind: 'user',
      text: 'follow',
      timestamp: 3
    }
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entriesSeeded',
      payload: { sessionId: SID, entries: [e1, e2, e3] }
    })
    const before = state.sessions[SID].entries
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantBlockAppended',
      payload: {
        sessionId: SID,
        entryId: 'a1',
        block: { type: 'tool_use', id: 't1', name: 'Read' }
      }
    })
    const after = next.sessions[SID].entries
    expect(after).not.toBe(before)
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(after[1]).not.toBe(before[1])
    expect(after[1].blocks).toHaveLength(2)
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

  it('assistantEntryFinalized preserves reference identity for untouched entries', () => {
    let state = seedSession(initialJsonClaude)
    const e1: JsonClaudeChatEntry = {
      entryId: 'u1',
      kind: 'user',
      text: 'hi',
      timestamp: 1
    }
    const e2: JsonClaudeChatEntry = {
      entryId: 'a1',
      kind: 'assistant',
      blocks: [{ type: 'text', text: 'hello' }],
      timestamp: 2,
      isPartial: true
    }
    const e3: JsonClaudeChatEntry = {
      entryId: 'u2',
      kind: 'user',
      text: 'follow',
      timestamp: 3
    }
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entriesSeeded',
      payload: { sessionId: SID, entries: [e1, e2, e3] }
    })
    const before = state.sessions[SID].entries
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantEntryFinalized',
      payload: {
        sessionId: SID,
        entryId: 'a1',
        blocks: [{ type: 'text', text: 'hello world' }]
      }
    })
    const after = next.sessions[SID].entries
    expect(after).not.toBe(before)
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(after[1]).not.toBe(before[1])
    expect(after[1].isPartial).toBeUndefined()
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

  it('approvalAutoApproved records the decision keyed by toolUseId', () => {
    let state = seedSession(initialJsonClaude)
    expect(state.sessions[SID].autoApprovedDecisions).toEqual({})
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/approvalAutoApproved',
      payload: {
        sessionId: SID,
        toolUseId: 'toolu_99',
        model: 'claude-haiku-4-5',
        reason: 'plain Read inside worktree',
        timestamp: 12345
      }
    })
    expect(state.sessions[SID].autoApprovedDecisions['toolu_99']).toEqual({
      model: 'claude-haiku-4-5',
      reason: 'plain Read inside worktree',
      timestamp: 12345
    })
  })

  it('approvalAutoApproved is a no-op for unknown session', () => {
    const next = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/approvalAutoApproved',
      payload: {
        sessionId: 'missing',
        toolUseId: 'toolu_x',
        model: 'm',
        reason: 'r',
        timestamp: 1
      }
    })
    expect(next).toBe(initialJsonClaude)
  })

  it('approvalRequested carries an autoReview status when present', () => {
    const state = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/approvalRequested',
      payload: {
        requestId: 'r1',
        sessionId: SID,
        toolName: 'Bash',
        input: { command: 'ls' },
        toolUseId: 'tu1',
        timestamp: 1,
        autoReview: { state: 'pending' }
      }
    })
    expect(state.pendingApprovals.r1.autoReview).toEqual({ state: 'pending' })
  })

  it('approvalAutoReviewFinished updates the autoReview field on the matching request', () => {
    let state = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/approvalRequested',
      payload: {
        requestId: 'r1',
        sessionId: SID,
        toolName: 'Bash',
        input: { command: 'ls' },
        toolUseId: 'tu1',
        timestamp: 1,
        autoReview: { state: 'pending' }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/approvalAutoReviewFinished',
      payload: {
        requestId: 'r1',
        decision: 'ask',
        reason: 'reviewer wants a human'
      }
    })
    expect(state.pendingApprovals.r1.autoReview).toEqual({
      state: 'finished',
      decision: 'ask',
      reason: 'reviewer wants a human',
      model: undefined
    })
  })

  it('approvalAutoReviewFinished is a no-op for an unknown request', () => {
    const next = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/approvalAutoReviewFinished',
      payload: { requestId: 'missing', decision: 'ask', reason: 'x' }
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

  it('userEntriesUnqueued clears isQueued from all user entries', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: {
          entryId: 'u1',
          kind: 'user',
          text: 'queued one',
          timestamp: 1,
          isQueued: true
        }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: {
          entryId: 'u2',
          kind: 'user',
          text: 'queued two',
          timestamp: 2,
          isQueued: true
        }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/userEntriesUnqueued',
      payload: { sessionId: SID }
    })
    expect(state.sessions[SID].entries[0].isQueued).toBeUndefined()
    expect(state.sessions[SID].entries[1].isQueued).toBeUndefined()
  })

  it('userEntriesUnqueued is a no-op when no entries are queued', () => {
    const state = seedSession(initialJsonClaude)
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/userEntriesUnqueued',
      payload: { sessionId: SID }
    })
    expect(next).toBe(state)
  })

  it('userEntriesUnqueued is a no-op when entries exist but none are queued', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entriesSeeded',
      payload: {
        sessionId: SID,
        entries: [
          { entryId: 'u1', kind: 'user', text: 'a', timestamp: 1 },
          { entryId: 'u2', kind: 'user', text: 'b', timestamp: 2 }
        ]
      }
    })
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/userEntriesUnqueued',
      payload: { sessionId: SID }
    })
    expect(next).toBe(state)
  })

  it('userEntriesUnqueued preserves reference identity for non-queued entries', () => {
    let state = seedSession(initialJsonClaude)
    const plain: JsonClaudeChatEntry = {
      entryId: 'u1',
      kind: 'user',
      text: 'plain',
      timestamp: 1
    }
    const queued: JsonClaudeChatEntry = {
      entryId: 'u2',
      kind: 'user',
      text: 'queued',
      timestamp: 2,
      isQueued: true
    }
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entriesSeeded',
      payload: { sessionId: SID, entries: [plain, queued] }
    })
    const before = state.sessions[SID].entries
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/userEntriesUnqueued',
      payload: { sessionId: SID }
    })
    const after = next.sessions[SID].entries
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[1].isQueued).toBeUndefined()
  })

  it('entryRemoved drops the matching entry by id', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: { entryId: 'u1', kind: 'user', text: 'a', timestamp: 1 }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: { entryId: 'u2', kind: 'user', text: 'b', timestamp: 2 }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryRemoved',
      payload: { sessionId: SID, entryId: 'u1' }
    })
    expect(state.sessions[SID].entries.map((e) => e.entryId)).toEqual(['u2'])
  })

  it('entryRemoved is a no-op when the id is absent', () => {
    const state = seedSession(initialJsonClaude)
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryRemoved',
      payload: { sessionId: SID, entryId: 'missing' }
    })
    expect(next).toBe(state)
  })

  it('slashCommandsChanged populates the per-session list', () => {
    let state = seedSession(initialJsonClaude)
    expect(state.sessions[SID].slashCommands).toEqual([])
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/slashCommandsChanged',
      payload: { sessionId: SID, slashCommands: ['clear', 'compact', 'review'] }
    })
    expect(state.sessions[SID].slashCommands).toEqual([
      'clear',
      'compact',
      'review'
    ])
  })

  it('slashCommandsChanged is a no-op for unknown session', () => {
    const next = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/slashCommandsChanged',
      payload: { sessionId: 'missing', slashCommands: ['clear'] }
    })
    expect(next).toBe(initialJsonClaude)
  })

  it('sessionStarted preserves slashCommands across re-attach', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/slashCommandsChanged',
      payload: { sessionId: SID, slashCommands: ['clear', 'review'] }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId: SID, worktreePath: WT }
    })
    expect(state.sessions[SID].slashCommands).toEqual(['clear', 'review'])
  })

  it('compactBoundaryReceived appends a compact entry with metadata', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/compactBoundaryReceived',
      payload: {
        sessionId: SID,
        entryId: 'c1',
        trigger: 'manual',
        preTokens: 119466,
        postTokens: 7263,
        timestamp: 5
      }
    })
    expect(state.sessions[SID].entries).toEqual([
      {
        entryId: 'c1',
        kind: 'compact',
        timestamp: 5,
        compactTrigger: 'manual',
        compactPreTokens: 119466,
        compactPostTokens: 7263
      }
    ])
  })

  it('compactBoundaryReceived omits absent metadata fields', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/compactBoundaryReceived',
      payload: { sessionId: SID, entryId: 'c1', timestamp: 5 }
    })
    const entry = state.sessions[SID].entries[0]
    expect(entry.kind).toBe('compact')
    expect(entry.compactTrigger).toBeUndefined()
    expect(entry.compactPreTokens).toBeUndefined()
    expect(entry.compactPostTokens).toBeUndefined()
  })

  it('compactBoundaryReceived is a no-op for unknown session', () => {
    const next = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/compactBoundaryReceived',
      payload: { sessionId: 'missing', entryId: 'c1', timestamp: 1 }
    })
    expect(next).toBe(initialJsonClaude)
  })

  it('sessionStarted seeds empty sessionToolApprovals + sessionAllowedDecisions', () => {
    const state = seedSession(initialJsonClaude)
    expect(state.sessions[SID].sessionToolApprovals).toEqual([])
    expect(state.sessions[SID].sessionAllowedDecisions).toEqual({})
  })

  it('sessionToolApprovalsGranted adds tool names dedup-merged', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionToolApprovalsGranted',
      payload: { sessionId: SID, toolNames: ['Edit', 'Write'] }
    })
    expect(state.sessions[SID].sessionToolApprovals).toEqual(['Edit', 'Write'])
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionToolApprovalsGranted',
      payload: { sessionId: SID, toolNames: ['Write', 'MultiEdit'] }
    })
    expect(state.sessions[SID].sessionToolApprovals).toEqual([
      'Edit',
      'Write',
      'MultiEdit'
    ])
  })

  it('sessionToolApprovalsGranted is a no-op when nothing new', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionToolApprovalsGranted',
      payload: { sessionId: SID, toolNames: ['Edit'] }
    })
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionToolApprovalsGranted',
      payload: { sessionId: SID, toolNames: ['Edit'] }
    })
    expect(next).toBe(state)
  })

  it('sessionToolApprovalsGranted is a no-op for unknown session', () => {
    const next = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/sessionToolApprovalsGranted',
      payload: { sessionId: 'missing', toolNames: ['Edit'] }
    })
    expect(next).toBe(initialJsonClaude)
  })

  it('sessionToolApprovalsCleared without toolNames clears the whole set', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionToolApprovalsGranted',
      payload: { sessionId: SID, toolNames: ['Edit', 'Write'] }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionToolApprovalsCleared',
      payload: { sessionId: SID }
    })
    expect(state.sessions[SID].sessionToolApprovals).toEqual([])
  })

  it('sessionToolApprovalsCleared with toolNames removes only those', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionToolApprovalsGranted',
      payload: { sessionId: SID, toolNames: ['Edit', 'Write', 'Bash'] }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionToolApprovalsCleared',
      payload: { sessionId: SID, toolNames: ['Write'] }
    })
    expect(state.sessions[SID].sessionToolApprovals).toEqual(['Edit', 'Bash'])
  })

  it('sessionToolApprovalsCleared is a no-op when set is already empty', () => {
    const state = seedSession(initialJsonClaude)
    const next = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionToolApprovalsCleared',
      payload: { sessionId: SID }
    })
    expect(next).toBe(state)
  })

  it('approvalSessionAllowed records an audit entry keyed by toolUseId', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/approvalSessionAllowed',
      payload: {
        sessionId: SID,
        toolUseId: 'toolu_42',
        toolName: 'Edit',
        timestamp: 999
      }
    })
    expect(state.sessions[SID].sessionAllowedDecisions['toolu_42']).toEqual({
      toolName: 'Edit',
      timestamp: 999
    })
  })

  it('approvalSessionAllowed is a no-op for unknown session', () => {
    const next = jsonClaudeReducer(initialJsonClaude, {
      type: 'jsonClaude/approvalSessionAllowed',
      payload: {
        sessionId: 'missing',
        toolUseId: 'toolu_x',
        toolName: 'Edit',
        timestamp: 1
      }
    })
    expect(next).toBe(initialJsonClaude)
  })

  it('entryAppended persists parentToolUseId on a sub-agent assistant entry', () => {
    let state = seedSession(initialJsonClaude)
    const entry: JsonClaudeChatEntry = {
      entryId: 'a-sub-1',
      kind: 'assistant',
      blocks: [{ type: 'text', text: 'sub-agent work' }],
      timestamp: 1,
      parentToolUseId: 'toolu_parent_task'
    }
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: { sessionId: SID, entry }
    })
    expect(state.sessions[SID].entries[0].parentToolUseId).toBe(
      'toolu_parent_task'
    )
  })

  it('assistantTextDelta preserves parentToolUseId on the entry', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: {
          entryId: 'a-sub-1',
          kind: 'assistant',
          blocks: [{ type: 'text', text: '' }],
          timestamp: 1,
          isPartial: true,
          parentToolUseId: 'toolu_parent_task'
        }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantTextDelta',
      payload: { sessionId: SID, entryId: 'a-sub-1', textDelta: 'hi' }
    })
    expect(state.sessions[SID].entries[0].parentToolUseId).toBe(
      'toolu_parent_task'
    )
    expect(state.sessions[SID].entries[0].blocks?.[0].text).toBe('hi')
  })

  it('assistantBlockAppended preserves parentToolUseId on the entry', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: {
          entryId: 'a-sub-1',
          kind: 'assistant',
          blocks: [{ type: 'text', text: 'hi' }],
          timestamp: 1,
          isPartial: true,
          parentToolUseId: 'toolu_parent_task'
        }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantBlockAppended',
      payload: {
        sessionId: SID,
        entryId: 'a-sub-1',
        block: { type: 'tool_use', id: 't1', name: 'Read' }
      }
    })
    expect(state.sessions[SID].entries[0].parentToolUseId).toBe(
      'toolu_parent_task'
    )
  })

  it('assistantEntryFinalized preserves parentToolUseId on the entry', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: SID,
        entry: {
          entryId: 'a-sub-1',
          kind: 'assistant',
          blocks: [{ type: 'text', text: 'partial' }],
          timestamp: 1,
          isPartial: true,
          parentToolUseId: 'toolu_parent_task'
        }
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/assistantEntryFinalized',
      payload: {
        sessionId: SID,
        entryId: 'a-sub-1',
        blocks: [{ type: 'text', text: 'final' }]
      }
    })
    const finalized = state.sessions[SID].entries[0]
    expect(finalized.parentToolUseId).toBe('toolu_parent_task')
    expect(finalized.isPartial).toBeUndefined()
    expect(finalized.blocks?.[0].text).toBe('final')
  })

  it('sessionStarted preserves sessionToolApprovals + decisions across re-attach', () => {
    let state = seedSession(initialJsonClaude)
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionToolApprovalsGranted',
      payload: { sessionId: SID, toolNames: ['Edit', 'Write'] }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/approvalSessionAllowed',
      payload: {
        sessionId: SID,
        toolUseId: 'toolu_1',
        toolName: 'Edit',
        timestamp: 1
      }
    })
    state = jsonClaudeReducer(state, {
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId: SID, worktreePath: WT }
    })
    expect(state.sessions[SID].sessionToolApprovals).toEqual(['Edit', 'Write'])
    expect(state.sessions[SID].sessionAllowedDecisions['toolu_1']).toEqual({
      toolName: 'Edit',
      timestamp: 1
    })
  })
})
