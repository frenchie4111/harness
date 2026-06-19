import { describe, it, expect } from 'vitest'
import type { PaneLeaf, PaneNode, TerminalTab } from '../shared/state/terminals'
import {
  agentKindOfTab,
  deriveSpawnSpec,
  newestResumableSession,
  pickForkSource,
  resolveTabBirth,
  type SessionBirthDeps
} from './session-birth'

const WT = '/wt/feature'

// --- builders -------------------------------------------------------------

function chatTab(id: string, sessionId?: string): TerminalTab {
  return { id, type: 'json-claude', label: 'Chat', sessionId, mode: 'awake' }
}
function claudeTab(id: string, sessionId?: string): TerminalTab {
  return { id, type: 'agent', agentKind: 'claude', label: 'Claude', sessionId }
}
function codexTab(id: string, sessionId?: string): TerminalTab {
  return { id, type: 'agent', agentKind: 'codex', label: 'Codex', sessionId }
}
function shellTab(id: string): TerminalTab {
  return { id, type: 'shell', label: 'Shell' }
}
function leaf(id: string, tabs: TerminalTab[], activeTabId?: string): PaneLeaf {
  return { type: 'leaf', id, tabs, activeTabId: activeTabId ?? tabs[0]?.id ?? '' }
}
function split(dir: 'horizontal' | 'vertical', a: PaneNode, b: PaneNode): PaneNode {
  return { type: 'split', id: `${a.id}-${b.id}`, direction: dir, ratio: 0.5, children: [a, b] }
}

/** Deps backed by an explicit set of on-disk transcript ids + an ordered
 *  (newest-first) session list, so tests control disk facts precisely. */
function deps(opts: {
  transcripts?: string[]
  sessions?: string[]
}): SessionBirthDeps {
  const present = new Set(opts.transcripts ?? [])
  const sessions = (opts.sessions ?? []).map((sessionId, i) => ({
    sessionId,
    mtimeMs: 1000 - i
  }))
  return {
    hasTranscript: (id) => present.has(id),
    listSessions: () => sessions
  }
}

// --- agentKindOfTab -------------------------------------------------------

describe('agentKindOfTab', () => {
  it('maps json-claude → claude, agent → its kind, others → null', () => {
    expect(agentKindOfTab(chatTab('c'))).toBe('claude')
    expect(agentKindOfTab(claudeTab('a'))).toBe('claude')
    expect(agentKindOfTab(codexTab('x'))).toBe('codex')
    expect(agentKindOfTab(shellTab('s'))).toBeNull()
    expect(
      agentKindOfTab({ id: 'a', type: 'agent', label: 'Agent' })
    ).toBe('claude')
  })
})

// --- resolveTabBirth: target claude ---------------------------------------

describe('resolveTabBirth (claude)', () => {
  const C = 'claude' as const

  it('brand-new worktree with no prior sessions → blank', () => {
    expect(resolveTabBirth(undefined, WT, C, deps({}))).toEqual({ kind: 'blank' })
  })

  it('no agent tabs + prior sessions on disk → resume the newest', () => {
    const spec = resolveTabBirth(undefined, WT, C, deps({ sessions: ['s-new', 's-old'] }))
    expect(spec).toEqual({ kind: 'resume', resumeSessionId: 's-new' })
  })

  it('only a shell tab open (no agent) → still resumes last known', () => {
    const tree = leaf('p1', [shellTab('sh1')])
    expect(resolveTabBirth(tree, WT, C, deps({ sessions: ['s1'] }))).toEqual({
      kind: 'resume',
      resumeSessionId: 's1'
    })
  })

  it('a chat tab with a transcript open → fork from it', () => {
    const tree = leaf('p1', [chatTab('c1', 'c1')])
    expect(resolveTabBirth(tree, WT, C, deps({ transcripts: ['c1'] }))).toEqual({
      kind: 'fork',
      srcSessionId: 'c1'
    })
  })

  it('an xterm CLAUDE tab with a transcript → new claude forks it (cross-surface)', () => {
    const tree = leaf('p1', [claudeTab('a1', 'sid-a1')])
    expect(resolveTabBirth(tree, WT, C, deps({ transcripts: ['sid-a1'] }))).toEqual({
      kind: 'fork',
      srcSessionId: 'sid-a1'
    })
  })

  it('a same-kind tab with no transcript yet → blank, not fork', () => {
    const tree = leaf('p1', [claudeTab('a1', 'sid-a1')])
    expect(resolveTabBirth(tree, WT, C, deps({ transcripts: [] }))).toEqual({
      kind: 'blank'
    })
  })

  it('only a CODEX tab open (target claude) → blank (no claude to fork, agent present)', () => {
    const tree = leaf('p1', [codexTab('x1', 'sid-x1')])
    expect(
      resolveTabBirth(tree, WT, C, deps({ transcripts: ['sid-x1'], sessions: ['s1'] }))
    ).toEqual({ kind: 'blank' })
  })

  it('forks from the same-kind tab active in the TARGET pane across a split', () => {
    const tree = split(
      'vertical',
      leaf('pL', [chatTab('cL', 'cL')]),
      leaf('pR', [claudeTab('aR', 'cR')])
    )
    const d = deps({ transcripts: ['cL', 'cR'] })
    expect(resolveTabBirth(tree, WT, C, d, 'pR')).toEqual({ kind: 'fork', srcSessionId: 'cR' })
    expect(resolveTabBirth(tree, WT, C, d, 'pL')).toEqual({ kind: 'fork', srcSessionId: 'cL' })
  })
})

// --- resolveTabBirth: target codex ----------------------------------------

describe('resolveTabBirth (codex)', () => {
  const X = 'codex' as const

  it('a codex tab with a transcript open → fork it', () => {
    const tree = leaf('p1', [codexTab('x1', 'sid-x1')])
    expect(resolveTabBirth(tree, WT, X, deps({ transcripts: ['sid-x1'] }))).toEqual({
      kind: 'fork',
      srcSessionId: 'sid-x1'
    })
  })

  it('a claude chat open (target codex) → blank (cannot fork claude into codex)', () => {
    const tree = leaf('p1', [chatTab('c1', 'c1')])
    expect(
      resolveTabBirth(tree, WT, X, deps({ transcripts: ['c1'], sessions: ['s1'] }))
    ).toEqual({ kind: 'blank' })
  })

  it('no agent tabs + codex sessions on disk → resume newest codex session', () => {
    expect(resolveTabBirth(undefined, WT, X, deps({ sessions: ['cx-new', 'cx-old'] }))).toEqual({
      kind: 'resume',
      resumeSessionId: 'cx-new'
    })
  })
})

// --- newestResumableSession ----------------------------------------------

describe('newestResumableSession', () => {
  it('returns the newest session not already open', () => {
    const open = [chatTab('t1', 's-open')]
    expect(
      newestResumableSession(WT, open, deps({ sessions: ['s-open', 's-free'] }))
    ).toBe('s-free')
  })

  it('excludes by both tab id and tab sessionId', () => {
    const open = [chatTab('s-byid'), chatTab('t2', 's-bysid')]
    expect(
      newestResumableSession(WT, open, deps({ sessions: ['s-byid', 's-bysid', 's-free'] }))
    ).toBe('s-free')
  })

  it('undefined when every session is already open', () => {
    const open = [chatTab('t1', 's1'), chatTab('t2', 's2')]
    expect(
      newestResumableSession(WT, open, deps({ sessions: ['s1', 's2'] }))
    ).toBeUndefined()
  })

  it('undefined when there are no sessions on disk', () => {
    expect(newestResumableSession(WT, [], deps({}))).toBeUndefined()
  })
})

// --- pickForkSource -------------------------------------------------------

describe('pickForkSource', () => {
  it('prefers the tab active in the target pane', () => {
    const tabs = [chatTab('cA', 'cA'), claudeTab('cB', 'cB')]
    const tree = leaf('p1', tabs, 'cB')
    expect(pickForkSource(tree, tabs, WT, deps({ transcripts: ['cA', 'cB'] }), 'p1')).toBe('cB')
  })

  it('falls back to the first same-kind tab with a transcript when active has none', () => {
    const tabs = [chatTab('cA', 'cA'), chatTab('cB', 'cB')]
    const tree = leaf('p1', tabs, 'cA')
    expect(pickForkSource(tree, tabs, WT, deps({ transcripts: ['cB'] }), 'p1')).toBe('cB')
  })

  it('undefined when no same-kind tab has a transcript', () => {
    const tabs = [chatTab('cA', 'cA')]
    const tree = leaf('p1', tabs, 'cA')
    expect(pickForkSource(tree, tabs, WT, deps({ transcripts: [] }), 'p1')).toBeUndefined()
  })

  it('uses tab id as the fork source when sessionId is unset', () => {
    const tabs = [chatTab('cA')]
    const tree = leaf('p1', tabs, 'cA')
    expect(pickForkSource(tree, tabs, WT, deps({ transcripts: ['cA'] }), 'p1')).toBe('cA')
  })
})

// --- deriveSpawnSpec ------------------------------------------------------

describe('deriveSpawnSpec', () => {
  it('resumes the tab’s own id when only that transcript exists (blank tab reload)', () => {
    const tree = leaf('p1', [chatTab('tab1', 'tab1')])
    expect(deriveSpawnSpec('tab1', tree, WT, deps({ transcripts: ['tab1'] }))).toEqual({
      kind: 'resume',
      resumeSessionId: 'tab1'
    })
  })

  it('resumes the decoupled sessionId when it differs and has a transcript (forked tab reload)', () => {
    const tree = leaf('p1', [chatTab('tab1', 'forked-sid')])
    expect(deriveSpawnSpec('tab1', tree, WT, deps({ transcripts: ['forked-sid'] }))).toEqual({
      kind: 'resume',
      resumeSessionId: 'forked-sid'
    })
  })

  it('works for an xterm agent tab too (resumes its decoupled sessionId)', () => {
    const tree = leaf('p1', [codexTab('tab1', 'codex-sid')])
    expect(deriveSpawnSpec('tab1', tree, WT, deps({ transcripts: ['codex-sid'] }))).toEqual({
      kind: 'resume',
      resumeSessionId: 'codex-sid'
    })
  })

  it('blank when no transcript exists for either id', () => {
    const tree = leaf('p1', [chatTab('tab1', 'tab1')])
    expect(deriveSpawnSpec('tab1', tree, WT, deps({}))).toEqual({ kind: 'blank' })
  })
})
