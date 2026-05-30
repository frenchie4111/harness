import { describe, it, expect, vi } from 'vitest'
import { Store } from './store'
import { PanesFSM } from './panes-fsm'
import type { PaneLeaf, PaneNode, TerminalTab } from '../shared/state/terminals'

vi.mock('./perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

vi.mock('./debug', () => ({
  log: vi.fn()
}))

function buildFSM(): { fsm: PanesFSM; store: Store } {
  const store = new Store()
  const fsm = new PanesFSM(store, {
    persist: () => {},
    getRepoRootForWorktree: () => undefined,
    getLatestClaudeSessionId: async () => null
  })
  return { fsm, store }
}

function seedLeaf(store: Store, wtPath: string, leaf: PaneLeaf): void {
  store.dispatch({
    type: 'terminals/panesForWorktreeChanged',
    payload: { worktreePath: wtPath, panes: leaf }
  })
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('PanesFSM.splitPane', () => {
  it('mints a UUID id for a json-claude clone so the Claude CLI accepts --session-id', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/json'
    const sourceTabId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    const sourceTab: TerminalTab = {
      id: sourceTabId,
      type: 'json-claude',
      label: 'Chat',
      sessionId: sourceTabId,
      mode: 'awake',
      model: 'opus'
    }
    const sourcePane: PaneLeaf = {
      type: 'leaf',
      id: 'pane-source',
      tabs: [sourceTab],
      activeTabId: sourceTabId
    }
    seedLeaf(store, wtPath, sourcePane)

    const newPane = fsm.splitPane(wtPath, 'pane-source', 'horizontal')

    expect(newPane).not.toBeNull()
    expect(newPane!.tabs).toHaveLength(1)
    const cloned = newPane!.tabs[0]
    expect(cloned.type).toBe('json-claude')
    expect(cloned.id).toMatch(UUID_RE)
    expect(cloned.id).not.toBe(sourceTabId)
    // tab.id and sessionId must agree — Chat tabs treat them as one value
    expect(cloned.sessionId).toBe(cloned.id)
    expect(cloned.mode).toBe('awake')
    // Inherits the source's model + label
    expect(cloned.model).toBe('opus')
    expect(cloned.label).toBe('Chat')
  })

  it('does not carry over initialPrompt/teleportSessionId from the source chat', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/json2'
    const sourceTabId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
    const sourceTab: TerminalTab = {
      id: sourceTabId,
      type: 'json-claude',
      label: 'Chat',
      sessionId: sourceTabId,
      mode: 'awake',
      initialPrompt: 'stale kickoff',
      teleportSessionId: 'stale-teleport'
    }
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-source',
      tabs: [sourceTab],
      activeTabId: sourceTabId
    })

    const newPane = fsm.splitPane(wtPath, 'pane-source', 'horizontal')
    const cloned = newPane!.tabs[0]
    expect(cloned.initialPrompt).toBeUndefined()
    expect(cloned.teleportSessionId).toBeUndefined()
  })

  it('clones an agent source into a fresh shell tab (regression check)', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/agent'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-agent',
      tabs: [
        {
          id: 'agent-1',
          type: 'agent',
          agentKind: 'claude',
          label: 'Claude',
          sessionId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
        }
      ],
      activeTabId: 'agent-1'
    })

    const newPane = fsm.splitPane(wtPath, 'pane-agent', 'horizontal')
    const cloned = newPane!.tabs[0]
    expect(cloned.type).toBe('shell')
    expect(cloned.id).toMatch(/^shell-/)
  })

  it('clones a diff source by copying the source tab with a new diff-prefixed id', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/diff'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-diff',
      tabs: [
        {
          id: 'diff-1',
          type: 'diff',
          label: 'src/foo.ts',
          filePath: 'src/foo.ts',
          staged: false
        }
      ],
      activeTabId: 'diff-1'
    })

    const newPane = fsm.splitPane(wtPath, 'pane-diff', 'horizontal')
    const cloned = newPane!.tabs[0]
    expect(cloned.type).toBe('diff')
    expect(cloned.id).toMatch(/^diff-/)
    expect(cloned.id).not.toBe('diff-1')
    expect(cloned.filePath).toBe('src/foo.ts')
  })

  it('wraps the source pane in a split node containing both children', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/split'
    const sourceTabId = 'dddddddd-dddd-4ddd-dddd-dddddddddddd'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-source',
      tabs: [
        {
          id: sourceTabId,
          type: 'json-claude',
          label: 'Chat',
          sessionId: sourceTabId,
          mode: 'awake'
        }
      ],
      activeTabId: sourceTabId
    })

    fsm.splitPane(wtPath, 'pane-source', 'vertical')
    const tree = store.getSnapshot().state.terminals.panes[wtPath] as PaneNode
    expect(tree.type).toBe('split')
    if (tree.type === 'split') {
      expect(tree.direction).toBe('vertical')
      expect(tree.children).toHaveLength(2)
      expect(tree.children[0].id).toBe('pane-source')
    }
  })
})

describe('PanesFSM.restoreFromConfig', () => {
  it('hydrates persisted shell and json-claude tabs as asleep, agent tabs as awake', async () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/restore'
    await fsm.restoreFromConfig({
      _ignored: {
        [wtPath]: {
          type: 'leaf',
          id: 'pane-1',
          tabs: [
            { id: 'sh-1', type: 'shell', label: 'Shell' },
            { id: 'agent-1', type: 'agent', label: 'Claude', agentKind: 'claude' },
            {
              id: 'chat-1',
              type: 'json-claude',
              label: 'Chat',
              sessionId: 'chat-1'
            }
          ],
          activeTabId: 'sh-1'
        }
      }
    })
    fsm.ensureInitialized(wtPath)
    const tree = store.getSnapshot().state.terminals.panes[wtPath]
    expect(tree?.type).toBe('leaf')
    const leaf = tree as PaneLeaf
    const shellTab = leaf.tabs.find((t) => t.id === 'sh-1')
    const agentTab = leaf.tabs.find((t) => t.id === 'agent-1')
    const chatTab = leaf.tabs.find((t) => t.id === 'chat-1')
    expect(shellTab?.mode).toBe('asleep')
    expect(agentTab?.mode).toBeUndefined()
    expect(chatTab?.mode).toBe('asleep')
  })
})

describe('PanesFSM.addTab background activation', () => {
  it('activate:false appends without changing the leaf activeTabId', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/bg'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'p1',
      tabs: [{ id: 'agent-1', type: 'agent', label: 'Claude' }],
      activeTabId: 'agent-1'
    })
    fsm.addTab(
      wtPath,
      { id: 'sh-1', type: 'shell', label: 'build', background: true },
      undefined,
      { activate: false }
    )
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.tabs.map((t) => t.id)).toEqual(['agent-1', 'sh-1'])
    expect(leaf.activeTabId).toBe('agent-1')
  })

  it('default (activate) makes the new tab active', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/fg'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'p1',
      tabs: [{ id: 'agent-1', type: 'agent', label: 'Claude' }],
      activeTabId: 'agent-1'
    })
    fsm.addTab(wtPath, { id: 'sh-1', type: 'shell', label: 'build' })
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.activeTabId).toBe('sh-1')
  })
})

describe('PanesFSM.selectTab', () => {
  it('clears the background flag when a background tab is selected', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/sel'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'p1',
      tabs: [
        { id: 'agent-1', type: 'agent', label: 'Claude' },
        { id: 'sh-1', type: 'shell', label: 'build', background: true }
      ],
      activeTabId: 'agent-1'
    })
    fsm.selectTab(wtPath, 'p1', 'sh-1')
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.activeTabId).toBe('sh-1')
    const shellTab = leaf.tabs.find((t) => t.id === 'sh-1')
    expect(shellTab?.background).toBeUndefined()
  })
})

describe('PanesFSM.openFileTab', () => {
  it('appends a file tab with the file-<path> id and basename label', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/files'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'sh-1', type: 'shell', label: 'Shell' }],
      activeTabId: 'sh-1'
    })

    fsm.openFileTab(wtPath, 'src/main/index.ts')

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const fileTab = leaf.tabs.find((t) => t.type === 'file')
    expect(fileTab?.id).toBe('file-src/main/index.ts')
    expect(fileTab?.filePath).toBe('src/main/index.ts')
    expect(fileTab?.label).toBe('index.ts')
    // newly added tab becomes active in its pane
    expect(leaf.activeTabId).toBe('file-src/main/index.ts')
  })

  it('opens the file in the pane containing nearTabId (split layout)', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/split'
    const split: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'leaf', id: 'pane-left', tabs: [{ id: 'agent-1', type: 'agent', label: 'Claude' }], activeTabId: 'agent-1' },
        { type: 'leaf', id: 'pane-right', tabs: [{ id: 'sh-1', type: 'shell', label: 'Shell' }], activeTabId: 'sh-1' }
      ]
    }
    store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: wtPath, panes: split }
    })

    // Clicked a file link in the right pane's shell.
    fsm.openFileTab(wtPath, 'src/x.ts', 'sh-1')

    const tree = store.getSnapshot().state.terminals.panes[wtPath] as PaneNode
    const right = (tree as { children: PaneLeaf[] }).children[1]
    expect(right.id).toBe('pane-right')
    expect(right.tabs.some((t) => t.id === 'file-src/x.ts')).toBe(true)
    expect(right.activeTabId).toBe('file-src/x.ts')
    // left pane untouched
    const left = (tree as { children: PaneLeaf[] }).children[0]
    expect(left.tabs.every((t) => t.type !== 'file')).toBe(true)
  })

  it('focuses an existing file tab for the same path instead of duplicating', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/files2'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: 'file-src/a.ts', type: 'file', label: 'a.ts', filePath: 'src/a.ts' },
        { id: 'sh-1', type: 'shell', label: 'Shell' }
      ],
      activeTabId: 'sh-1'
    })

    fsm.openFileTab(wtPath, 'src/a.ts')

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.tabs.filter((t) => t.type === 'file')).toHaveLength(1)
    expect(leaf.activeTabId).toBe('file-src/a.ts')
  })
})
