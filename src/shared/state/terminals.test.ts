import { describe, it, expect } from 'vitest'
import {
  initialTerminals,
  terminalsReducer,
  type TerminalsEvent,
  type TerminalsState,
  type PaneNode,
  type PaneLeaf,
  getLeaves,
  findLeaf,
  findLeafByTabId,
  hasAnyTabs,
  mapLeaves,
  replaceNode,
  removeLeaf
} from './terminals'

function apply(state: TerminalsState, event: TerminalsEvent): TerminalsState {
  return terminalsReducer(state, event)
}

function leaf(id: string, tabIds: string[] = [], activeTabId?: string): PaneLeaf {
  const tabs = tabIds.map((tid) => ({ id: tid, type: 'shell' as const, label: tid }))
  return { type: 'leaf', id, tabs, activeTabId: activeTabId ?? tabs[0]?.id ?? '' }
}

describe('tree helpers', () => {
  it('getLeaves returns leaves in order', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        leaf('a', ['t1']),
        {
          type: 'split',
          id: 's2',
          direction: 'vertical',
          ratio: 0.5,
          children: [leaf('b', ['t2']), leaf('c', ['t3'])]
        }
      ]
    }
    expect(getLeaves(tree).map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })

  it('findLeaf finds by pane id', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [leaf('a', ['t1']), leaf('b', ['t2'])]
    }
    expect(findLeaf(tree, 'b')?.id).toBe('b')
    expect(findLeaf(tree, 'missing')).toBeNull()
  })

  it('findLeafByTabId finds the leaf containing a tab', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [leaf('a', ['t1']), leaf('b', ['t2', 't3'])]
    }
    expect(findLeafByTabId(tree, 't3')?.id).toBe('b')
    expect(findLeafByTabId(tree, 'missing')).toBeNull()
  })

  it('hasAnyTabs detects tabs in nested trees', () => {
    expect(hasAnyTabs(leaf('a', ['t1']))).toBe(true)
    expect(hasAnyTabs(leaf('a', []))).toBe(false)
    const tree: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [leaf('a', []), leaf('b', ['t1'])]
    }
    expect(hasAnyTabs(tree)).toBe(true)
  })

  it('mapLeaves transforms all leaves', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [leaf('a', ['t1']), leaf('b', ['t2'])]
    }
    const mapped = mapLeaves(tree, (l) => ({ ...l, activeTabId: 'x' }))
    expect(getLeaves(mapped).every((l) => l.activeTabId === 'x')).toBe(true)
  })

  it('mapLeaves returns same reference when nothing changes', () => {
    const tree: PaneNode = leaf('a', ['t1'])
    const same = mapLeaves(tree, (l) => l)
    expect(same).toBe(tree)
  })

  it('replaceNode replaces a target node', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [leaf('a', ['t1']), leaf('b', ['t2'])]
    }
    const newLeaf = leaf('c', ['t3'])
    const result = replaceNode(tree, 'b', newLeaf)
    expect(getLeaves(result).map((l) => l.id)).toEqual(['a', 'c'])
  })

  it('removeLeaf collapses parent split to sibling', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [leaf('a', ['t1']), leaf('b', ['t2'])]
    }
    const result = removeLeaf(tree, 'a')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('leaf')
    expect((result as PaneLeaf).id).toBe('b')
  })

  it('removeLeaf returns null when removing the only leaf', () => {
    expect(removeLeaf(leaf('a', ['t1']), 'a')).toBeNull()
  })

  it('removeLeaf handles deep nesting', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        leaf('a', ['t1']),
        {
          type: 'split',
          id: 's2',
          direction: 'vertical',
          ratio: 0.5,
          children: [leaf('b', ['t2']), leaf('c', ['t3'])]
        }
      ]
    }
    const result = removeLeaf(tree, 'b')!
    expect(result.type).toBe('split')
    expect(getLeaves(result).map((l) => l.id)).toEqual(['a', 'c'])
  })
})

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
      lastActive: {},
      sessions: {}
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
      lastActive: {},
      sessions: {}
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
    const pane = leaf('p1', ['t1'])
    const next = apply(initialTerminals, {
      type: 'terminals/panesReplaced',
      payload: { '/wt/a': pane }
    })
    expect(next.panes).toEqual({ '/wt/a': pane })
  })

  it('panesForWorktreeChanged updates one worktree without disturbing others', () => {
    const a = leaf('p1', ['t1'])
    const b = leaf('p2', ['t2'])
    const start: TerminalsState = {
      ...initialTerminals,
      panes: { '/wt/a': a, '/wt/b': b }
    }
    const updated = leaf('p1', ['t1', 't3'], 't3')
    const next = apply(start, {
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: '/wt/a', panes: updated }
    })
    expect(next.panes['/wt/a']).toEqual(updated)
    expect(next.panes['/wt/b']).toBe(start.panes['/wt/b'])
  })

  it('panesForWorktreeCleared drops the entry', () => {
    const start: TerminalsState = {
      ...initialTerminals,
      panes: { '/wt/a': leaf('p1'), '/wt/b': leaf('p2') }
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
      panes: { '/wt/a': leaf('p1') }
    }
    const next = apply(start, {
      type: 'terminals/panesForWorktreeCleared',
      payload: '/wt/missing'
    })
    expect(next).toBe(start)
  })

  it('paneRatioChanged updates a split node ratio', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [leaf('a', ['t1']), leaf('b', ['t2'])]
    }
    const start: TerminalsState = { ...initialTerminals, panes: { '/wt/a': tree } }
    const next = apply(start, {
      type: 'terminals/paneRatioChanged',
      payload: { worktreePath: '/wt/a', splitId: 's1', ratio: 0.3 }
    })
    const updated = next.panes['/wt/a'] as PaneNode
    expect(updated.type).toBe('split')
    expect((updated as any).ratio).toBe(0.3)
  })

  it('lastActiveChanged sets the timestamp for a worktree', () => {
    const next = apply(initialTerminals, {
      type: 'terminals/lastActiveChanged',
      payload: { worktreePath: '/wt/a', ts: 1234 }
    })
    expect(next.lastActive['/wt/a']).toBe(1234)
  })

  describe('sessions (controller/spectator)', () => {
    it('clientJoined creates a session with the joiner as controller when none exists', () => {
      const next = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      expect(next.sessions['term-1']).toEqual({
        controllerClientId: 'client-A',
        spectatorClientIds: [],
        size: null
      })
    })

    it('clientJoined with existing controller adds joiner as spectator', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-B' }
      })
      expect(s2.sessions['term-1'].controllerClientId).toBe('client-A')
      expect(s2.sessions['term-1'].spectatorClientIds).toEqual(['client-B'])
    })

    it('clientJoined promotes joiner to controller when controller is null', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, {
        type: 'terminals/controlReleased',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s3 = apply(s2, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-B' }
      })
      expect(s3.sessions['term-1'].controllerClientId).toBe('client-B')
    })

    it('clientJoined is a no-op if the client already joined', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      expect(s2).toBe(s1)
    })

    it('controlTaken moves previous controller to spectators and sets size', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, {
        type: 'terminals/controlTaken',
        payload: { terminalId: 'term-1', clientId: 'client-B', cols: 100, rows: 40 }
      })
      expect(s2.sessions['term-1'].controllerClientId).toBe('client-B')
      expect(s2.sessions['term-1'].spectatorClientIds).toEqual(['client-A'])
      expect(s2.sessions['term-1'].size).toEqual({ cols: 100, rows: 40 })
    })

    it('controlTaken removes the new controller from spectators if present', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-B' }
      })
      const s3 = apply(s2, {
        type: 'terminals/controlTaken',
        payload: { terminalId: 'term-1', clientId: 'client-B', cols: 80, rows: 24 }
      })
      expect(s3.sessions['term-1'].controllerClientId).toBe('client-B')
      expect(s3.sessions['term-1'].spectatorClientIds).toEqual(['client-A'])
    })

    it('controlReleased on the controller leaves controller null', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, {
        type: 'terminals/controlReleased',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      expect(s2.sessions['term-1'].controllerClientId).toBeNull()
    })

    it('controlReleased on a spectator removes them from the list', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-B' }
      })
      const s3 = apply(s2, {
        type: 'terminals/controlReleased',
        payload: { terminalId: 'term-1', clientId: 'client-B' }
      })
      expect(s3.sessions['term-1'].spectatorClientIds).toEqual([])
      expect(s3.sessions['term-1'].controllerClientId).toBe('client-A')
    })

    it('clientDisconnected sweeps all terminals globally', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-2', clientId: 'client-A' }
      })
      const s3 = apply(s2, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-2', clientId: 'client-B' }
      })
      const s4 = apply(s3, {
        type: 'terminals/clientDisconnected',
        payload: { clientId: 'client-A' }
      })
      expect(s4.sessions['term-1'].controllerClientId).toBeNull()
      // Disconnect clears the controller to null; promotion requires an
      // explicit takeControl so state can't silently move between clients.
      expect(s4.sessions['term-2'].controllerClientId).toBeNull()
      expect(s4.sessions['term-2'].spectatorClientIds).toEqual(['client-B'])
    })

    it('clientDisconnected with no matching client returns same reference', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, {
        type: 'terminals/clientDisconnected',
        payload: { clientId: 'client-never-joined' }
      })
      expect(s2).toBe(s1)
    })

    it('sizeChanged updates size on existing session', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, {
        type: 'terminals/sizeChanged',
        payload: { terminalId: 'term-1', cols: 100, rows: 40 }
      })
      expect(s2.sessions['term-1'].size).toEqual({ cols: 100, rows: 40 })
    })

    it('sizeChanged is a no-op if size is unchanged', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, {
        type: 'terminals/sizeChanged',
        payload: { terminalId: 'term-1', cols: 100, rows: 40 }
      })
      const s3 = apply(s2, {
        type: 'terminals/sizeChanged',
        payload: { terminalId: 'term-1', cols: 100, rows: 40 }
      })
      expect(s3).toBe(s2)
    })

    it('terminals/removed also clears the session entry', () => {
      const s1 = apply(initialTerminals, {
        type: 'terminals/clientJoined',
        payload: { terminalId: 'term-1', clientId: 'client-A' }
      })
      const s2 = apply(s1, { type: 'terminals/removed', payload: 'term-1' })
      expect(s2.sessions['term-1']).toBeUndefined()
    })
  })

  it('sessionIdDiscovered backfills a session id in pane tree', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'leaf', id: 'p1', tabs: [{ id: 'agent-1', type: 'agent', label: 'Claude', agentKind: 'claude' }], activeTabId: 'agent-1' },
        leaf('p2', ['t2'])
      ]
    }
    const start: TerminalsState = { ...initialTerminals, panes: { '/wt/a': tree } }
    const next = apply(start, {
      type: 'terminals/sessionIdDiscovered',
      payload: { terminalId: 'agent-1', sessionId: 'sess-abc' }
    })
    const leaves = getLeaves(next.panes['/wt/a'])
    const agentTab = leaves[0].tabs[0]
    expect(agentTab.sessionId).toBe('sess-abc')
  })
})
