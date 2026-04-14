import { describe, it, expect } from 'vitest'
import {
  initialTerminals,
  terminalsReducer,
  type TerminalsEvent,
  type TerminalsState,
  type WorkspacePane
} from './terminals'

function apply(state: TerminalsState, event: TerminalsEvent): TerminalsState {
  return terminalsReducer(state, event)
}

describe('terminalsReducer', () => {
  it('statusChanged sets status and clears pendingTool when not needs-approval', () => {
    const next = apply(initialTerminals, {
      type: 'terminals/statusChanged',
      payload: { id: 'term-1', status: 'processing', pendingTool: null }
    })
    expect(next.statuses['term-1']).toBe('processing')
    expect(next.pendingTools['term-1']).toBeNull()
  })

  it('statusChanged with needs-approval keeps pendingTool', () => {
    const tool = { name: 'Bash', input: { command: 'rm -rf /tmp/x' } }
    const next = apply(initialTerminals, {
      type: 'terminals/statusChanged',
      payload: { id: 'term-1', status: 'needs-approval', pendingTool: tool }
    })
    expect(next.statuses['term-1']).toBe('needs-approval')
    expect(next.pendingTools['term-1']).toEqual(tool)
  })

  it('statusChanged drops a previously-set pendingTool when status leaves needs-approval', () => {
    const tool = { name: 'Bash', input: {} }
    const s1 = apply(initialTerminals, {
      type: 'terminals/statusChanged',
      payload: { id: 'term-1', status: 'needs-approval', pendingTool: tool }
    })
    expect(s1.pendingTools['term-1']).toEqual(tool)
    const s2 = apply(s1, {
      type: 'terminals/statusChanged',
      payload: { id: 'term-1', status: 'processing', pendingTool: null }
    })
    expect(s2.pendingTools['term-1']).toBeNull()
  })

  it('statusChanged on one terminal leaves others alone', () => {
    const s1 = apply(initialTerminals, {
      type: 'terminals/statusChanged',
      payload: { id: 'term-a', status: 'processing', pendingTool: null }
    })
    const s2 = apply(s1, {
      type: 'terminals/statusChanged',
      payload: { id: 'term-b', status: 'idle', pendingTool: null }
    })
    expect(s2.statuses).toEqual({ 'term-a': 'processing', 'term-b': 'idle' })
  })

  it('shellActivityChanged sets the active flag and process name', () => {
    const next = apply(initialTerminals, {
      type: 'terminals/shellActivityChanged',
      payload: { id: 'term-1', active: true, processName: 'vim' }
    })
    expect(next.shellActivity['term-1']).toEqual({ active: true, processName: 'vim' })
  })

  it('removed clears all three maps for that id', () => {
    const start: TerminalsState = {
      statuses: { 'term-1': 'processing', 'term-2': 'idle' },
      pendingTools: { 'term-1': { name: 'Bash', input: {} } },
      shellActivity: { 'term-1': { active: true } },
      panes: {},
      lastActive: {}
    }
    const next = apply(start, { type: 'terminals/removed', payload: 'term-1' })
    expect(next.statuses).toEqual({ 'term-2': 'idle' })
    expect(next.pendingTools).toEqual({})
    expect(next.shellActivity).toEqual({})
  })

  it('removed on an unknown id is a no-op (returns same reference)', () => {
    const start: TerminalsState = {
      statuses: { 'term-1': 'idle' },
      pendingTools: {},
      shellActivity: {},
      panes: {},
      lastActive: {}
    }
    const next = apply(start, { type: 'terminals/removed', payload: 'missing' })
    expect(next).toBe(start)
  })

  it('returns a new object reference on real changes', () => {
    const next = apply(initialTerminals, {
      type: 'terminals/statusChanged',
      payload: { id: 'term-1', status: 'idle', pendingTool: null }
    })
    expect(next).not.toBe(initialTerminals)
  })

  it('panesReplaced replaces the whole panes map', () => {
    const pane: WorkspacePane = {
      id: 'p1',
      tabs: [{ id: 't1', type: 'shell', label: 'Shell' }],
      activeTabId: 't1'
    }
    const next = apply(initialTerminals, {
      type: 'terminals/panesReplaced',
      payload: { '/wt/a': [pane] }
    })
    expect(next.panes).toEqual({ '/wt/a': [pane] })
  })

  it('panesForWorktreeChanged updates one worktree without disturbing others', () => {
    const a: WorkspacePane = {
      id: 'p1',
      tabs: [{ id: 't1', type: 'shell', label: 'Shell' }],
      activeTabId: 't1'
    }
    const b: WorkspacePane = {
      id: 'p2',
      tabs: [{ id: 't2', type: 'shell', label: 'Shell' }],
      activeTabId: 't2'
    }
    const start: TerminalsState = {
      ...initialTerminals,
      panes: { '/wt/a': [a], '/wt/b': [b] }
    }
    const updated: WorkspacePane = {
      id: 'p1',
      tabs: [
        { id: 't1', type: 'shell', label: 'Shell' },
        { id: 't3', type: 'claude', label: 'Claude' }
      ],
      activeTabId: 't3'
    }
    const next = apply(start, {
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: '/wt/a', panes: [updated] }
    })
    expect(next.panes['/wt/a']).toEqual([updated])
    expect(next.panes['/wt/b']).toBe(start.panes['/wt/b'])
  })

  it('panesForWorktreeCleared drops the entry', () => {
    const start: TerminalsState = {
      ...initialTerminals,
      panes: { '/wt/a': [], '/wt/b': [] }
    }
    const next = apply(start, {
      type: 'terminals/panesForWorktreeCleared',
      payload: '/wt/a'
    })
    expect(Object.keys(next.panes)).toEqual(['/wt/b'])
  })

  it('panesForWorktreeCleared on a missing key is a no-op', () => {
    const start: TerminalsState = {
      ...initialTerminals,
      panes: { '/wt/a': [] }
    }
    const next = apply(start, {
      type: 'terminals/panesForWorktreeCleared',
      payload: '/wt/missing'
    })
    expect(next).toBe(start)
  })

  it('lastActiveChanged sets the timestamp for a worktree', () => {
    const next = apply(initialTerminals, {
      type: 'terminals/lastActiveChanged',
      payload: { worktreePath: '/wt/a', ts: 1234 }
    })
    expect(next.lastActive['/wt/a']).toBe(1234)
  })
})
