import { describe, it, expect } from 'vitest'
import type { JsonClaudeChatEntry } from '../../../shared/state/json-claude'
import { buildChildrenMap } from './grouping'

function user(id: string): JsonClaudeChatEntry {
  return { entryId: id, kind: 'user', text: id, timestamp: 0 }
}

function assistantText(
  id: string,
  parentToolUseId?: string
): JsonClaudeChatEntry {
  return {
    entryId: id,
    kind: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 0,
    ...(parentToolUseId ? { parentToolUseId } : {})
  }
}

function assistantWithTask(
  id: string,
  taskId: string,
  parentToolUseId?: string,
  toolName: 'Task' | 'Agent' = 'Task'
): JsonClaudeChatEntry {
  return {
    entryId: id,
    kind: 'assistant',
    blocks: [
      { type: 'text', text: 'spawning task' },
      { type: 'tool_use', id: taskId, name: toolName, input: {} }
    ],
    timestamp: 0,
    ...(parentToolUseId ? { parentToolUseId } : {})
  }
}

describe('buildChildrenMap', () => {
  it('returns all entries top-level when none have parentToolUseId', () => {
    const entries: JsonClaudeChatEntry[] = [
      user('u1'),
      assistantText('a1'),
      user('u2')
    ]
    const { topLevelEntries, childrenByParentToolUseId } =
      buildChildrenMap(entries)
    expect(topLevelEntries).toEqual(entries)
    expect(childrenByParentToolUseId.size).toBe(0)
  })

  it('one parent + one child → top level has only the parent', () => {
    const parent = assistantWithTask('a1', 'T1')
    const child = assistantText('a2-sub', 'T1')
    const { topLevelEntries, childrenByParentToolUseId } = buildChildrenMap([
      parent,
      child
    ])
    expect(topLevelEntries).toEqual([parent])
    expect(childrenByParentToolUseId.get('T1')).toEqual([child])
  })

  it('nested grandchildren produce a flat per-parent children map', () => {
    // Parent (T1) → child sub-agent that itself spawns Task T2 → grandchild
    const parent = assistantWithTask('a1', 'T1')
    const childWithTask = assistantWithTask('a2-sub', 'T2', 'T1')
    const grandchild = assistantText('a3-grand', 'T2')
    const { topLevelEntries, childrenByParentToolUseId } = buildChildrenMap([
      parent,
      childWithTask,
      grandchild
    ])
    expect(topLevelEntries).toEqual([parent])
    expect(childrenByParentToolUseId.get('T1')).toEqual([childWithTask])
    expect(childrenByParentToolUseId.get('T2')).toEqual([grandchild])
  })

  it('orphan child (no matching Task block) is in children map AND top level', () => {
    const orphan = assistantText('a-orphan', 'T-missing')
    const other = assistantText('a-plain')
    const { topLevelEntries, childrenByParentToolUseId } = buildChildrenMap([
      orphan,
      other
    ])
    expect(topLevelEntries).toEqual([orphan, other])
    expect(childrenByParentToolUseId.get('T-missing')).toEqual([orphan])
  })

  it('treats Agent (Claude Code 2.1.126+ alias) the same as Task', () => {
    const parent = assistantWithTask('a1', 'A1', undefined, 'Agent')
    const child = assistantText('a2-sub', 'A1')
    const { topLevelEntries, childrenByParentToolUseId } = buildChildrenMap([
      parent,
      child
    ])
    expect(topLevelEntries).toEqual([parent])
    expect(childrenByParentToolUseId.get('A1')).toEqual([child])
  })

  it('preserves child insertion order under a parent', () => {
    const parent = assistantWithTask('a1', 'T1')
    const c1 = assistantText('c1', 'T1')
    const c2 = assistantText('c2', 'T1')
    const c3 = assistantText('c3', 'T1')
    const { childrenByParentToolUseId } = buildChildrenMap([
      parent,
      c1,
      c2,
      c3
    ])
    expect(childrenByParentToolUseId.get('T1')?.map((e) => e.entryId)).toEqual([
      'c1',
      'c2',
      'c3'
    ])
  })
})
