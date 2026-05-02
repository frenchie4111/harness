import { describe, it, expect } from 'vitest'
import type { JsonClaudeSession } from './json-claude'
import { getLatestTodos, type TodoItem } from './json-claude-todos'

function makeSession(
  entries: JsonClaudeSession['entries']
): JsonClaudeSession {
  return {
    sessionId: 's1',
    worktreePath: '/tmp/wt',
    state: 'running',
    exitCode: null,
    exitReason: null,
    entries,
    busy: false,
    permissionMode: 'default',
    slashCommands: [],
    autoApprovedDecisions: {},
    sessionToolApprovals: [],
    sessionAllowedDecisions: {}
  }
}

const todos1: TodoItem[] = [
  { content: 'first', status: 'pending', activeForm: 'doing first' }
]
const todos2: TodoItem[] = [
  { content: 'a', status: 'completed', activeForm: 'A' },
  { content: 'b', status: 'in_progress', activeForm: 'B' }
]

describe('getLatestTodos', () => {
  it('returns null for null/undefined session', () => {
    expect(getLatestTodos(null)).toBeNull()
    expect(getLatestTodos(undefined)).toBeNull()
  })

  it('returns null when session has no entries', () => {
    expect(getLatestTodos(makeSession([]))).toBeNull()
  })

  it('returns null when entries contain no TodoWrite tool_use', () => {
    const session = makeSession([
      { entryId: 'e1', kind: 'user', text: 'hi', timestamp: 1 },
      {
        entryId: 'e2',
        kind: 'assistant',
        timestamp: 2,
        blocks: [
          { type: 'text', text: 'sure' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: '/x' } }
        ]
      }
    ])
    expect(getLatestTodos(session)).toBeNull()
  })

  it('returns the input.todos of a single TodoWrite call', () => {
    const session = makeSession([
      {
        entryId: 'e1',
        kind: 'assistant',
        timestamp: 1,
        blocks: [
          { type: 'tool_use', id: 'tu1', name: 'TodoWrite', input: { todos: todos1 } }
        ]
      }
    ])
    expect(getLatestTodos(session)).toEqual(todos1)
  })

  it('returns the latest TodoWrite when there are multiple', () => {
    const session = makeSession([
      {
        entryId: 'e1',
        kind: 'assistant',
        timestamp: 1,
        blocks: [
          { type: 'tool_use', id: 'tu1', name: 'TodoWrite', input: { todos: todos1 } }
        ]
      },
      {
        entryId: 'e2',
        kind: 'assistant',
        timestamp: 2,
        blocks: [
          { type: 'text', text: 'updating' },
          { type: 'tool_use', id: 'tu2', name: 'TodoWrite', input: { todos: todos2 } }
        ]
      }
    ])
    expect(getLatestTodos(session)).toEqual(todos2)
  })

  it('finds TodoWrite even when nested under a parentToolUseId (sub-agent)', () => {
    const session = makeSession([
      {
        entryId: 'e1',
        kind: 'assistant',
        timestamp: 1,
        parentToolUseId: 'task-parent-1',
        blocks: [
          { type: 'tool_use', id: 'tu1', name: 'TodoWrite', input: { todos: todos1 } }
        ]
      }
    ])
    expect(getLatestTodos(session)).toEqual(todos1)
  })

  it('returns an empty array when the latest TodoWrite has no todos field', () => {
    const session = makeSession([
      {
        entryId: 'e1',
        kind: 'assistant',
        timestamp: 1,
        blocks: [{ type: 'tool_use', id: 'tu1', name: 'TodoWrite', input: {} }]
      }
    ])
    expect(getLatestTodos(session)).toEqual([])
  })
})
