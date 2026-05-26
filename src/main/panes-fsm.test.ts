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
