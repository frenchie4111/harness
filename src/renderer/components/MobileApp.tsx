import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, GitBranch, GitPullRequest, Activity as ActivityIcon, ExternalLink, RefreshCw, List as ListIcon, Terminal as TerminalIcon, Loader2 } from 'lucide-react'
import { useWorktrees, usePanes, useTerminals, usePrs } from '../store'
import { groupWorktrees, type WorktreeGroup } from '../worktree-sort'
import { getLeaves } from '../../shared/state/terminals'
import type { PtyStatus, TerminalTab, Worktree, PRStatus } from '../types'
import { MobileTerminal } from './MobileTerminal'
import { useViewport } from '../hooks/useViewport'

type MobileView = 'list' | 'terminal' | 'pr'

const STATUS_DOT: Record<PtyStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger'
}

type RunnableTab = TerminalTab & { type: 'agent' | 'shell' }

function findFirstAgentTab(panes: ReturnType<typeof usePanes>, wtPath: string): RunnableTab | null {
  const tree = panes[wtPath]
  if (!tree) return null
  for (const leaf of getLeaves(tree)) {
    for (const tab of leaf.tabs) {
      if (tab.type === 'agent') return tab as RunnableTab
    }
  }
  // Fall back to the first agent/shell tab so the user still sees a
  // running session instead of an "empty" placeholder. Skip diff/file/
  // browser tabs — those have no PTY behind them.
  for (const leaf of getLeaves(tree)) {
    for (const tab of leaf.tabs) {
      if (tab.type === 'shell') return tab as RunnableTab
    }
  }
  return null
}

function aggregateStatus(tabs: TerminalTab[], statuses: Record<string, PtyStatus>): PtyStatus {
  let worst: PtyStatus = 'idle'
  for (const t of tabs) {
    const s = statuses[t.id]
    if (s === 'needs-approval') return 'needs-approval'
    if (s === 'waiting') worst = 'waiting'
    if (s === 'processing' && worst === 'idle') worst = 'processing'
  }
  return worst
}

export function MobileApp(): JSX.Element {
  const wtState = useWorktrees()
  const panes = usePanes()
  const terminals = useTerminals()
  const prs = usePrs()
  const { viewportHeight } = useViewport()

  const worktrees = wtState.list
  const [view, setView] = useState<MobileView>('list')
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(
    () => worktrees[0]?.path ?? null
  )

  // Force the visualViewport-derived height onto the root so children can
  // read it via 100% / flex without competing with the layout viewport
  // when the keyboard opens.
  useEffect(() => {
    if (viewportHeight > 0) {
      document.documentElement.style.setProperty('--viewport-h', `${viewportHeight}px`)
    }
  }, [viewportHeight])

  // Keep the active worktree in sync if it disappears (deleted, dismissed).
  useEffect(() => {
    if (!activeWorktreeId) return
    if (worktrees.some((w) => w.path === activeWorktreeId)) return
    setActiveWorktreeId(worktrees[0]?.path ?? null)
    setView('list')
  }, [activeWorktreeId, worktrees])

  // Make sure the active worktree's panes are initialized so we have a
  // tab to render when entering the terminal view.
  useEffect(() => {
    if (!activeWorktreeId) return
    void window.api.panesEnsureInitialized(activeWorktreeId)
  }, [activeWorktreeId])

  // Initial data refresh — the desktop App runs this at mount; mobile
  // needs the same kick so the worktree list is current after a reload.
  useEffect(() => {
    void window.api.refreshWorktreesList()
    void window.api.refreshPRsAllIfStale()
  }, [])

  const groups = useMemo<WorktreeGroup[]>(
    () => groupWorktrees(worktrees, prs.byPath, prs.mergedByPath),
    [worktrees, prs.byPath, prs.mergedByPath]
  )

  const terminalTabs = useMemo<Record<string, TerminalTab[]>>(() => {
    const out: Record<string, TerminalTab[]> = {}
    for (const [wtPath, tree] of Object.entries(panes)) {
      out[wtPath] = getLeaves(tree).flatMap((l) => l.tabs)
    }
    return out
  }, [panes])

  const worktreeStatuses = useMemo<Record<string, PtyStatus>>(() => {
    const out: Record<string, PtyStatus> = {}
    for (const wt of worktrees) {
      out[wt.path] = aggregateStatus(terminalTabs[wt.path] ?? [], terminals.statuses)
    }
    return out
  }, [worktrees, terminalTabs, terminals.statuses])

  const handleSelectWorktree = useCallback((wtPath: string) => {
    setActiveWorktreeId(wtPath)
    setView('terminal')
  }, [])

  const activeWorktree = useMemo(
    () => worktrees.find((w) => w.path === activeWorktreeId) ?? null,
    [worktrees, activeWorktreeId]
  )

  return (
    <div
      className="flex flex-col bg-app text-fg overflow-hidden"
      style={{
        height: 'var(--viewport-h, 100vh)',
        paddingTop: 'env(safe-area-inset-top, 0px)'
      }}
    >
      <div className="flex-1 min-h-0 overflow-hidden">
        {view === 'list' && (
          <WorktreeList
            groups={groups}
            statuses={worktreeStatuses}
            prStatuses={prs.byPath}
            activeWorktreeId={activeWorktreeId}
            loading={prs.loading}
            onSelect={handleSelectWorktree}
            onRefresh={() => void window.api.refreshPRsAll()}
          />
        )}
        {view === 'terminal' && activeWorktree && (
          <TerminalScreen
            worktree={activeWorktree}
            tab={findFirstAgentTab(panes, activeWorktree.path)}
            onBack={() => setView('list')}
          />
        )}
        {view === 'terminal' && !activeWorktree && (
          <EmptyScreen message="Select a worktree from the list to open its terminal." />
        )}
        {view === 'pr' && (
          <PrScreen
            worktrees={worktrees}
            prStatuses={prs.byPath}
            mergedPaths={prs.mergedByPath}
            loading={prs.loading}
            activeWorktreeId={activeWorktreeId}
            onSelect={handleSelectWorktree}
            onRefresh={() => void window.api.refreshPRsAll()}
          />
        )}
      </div>

      <BottomNav
        view={view}
        hasActive={!!activeWorktreeId}
        onChange={setView}
      />
    </div>
  )
}

interface BottomNavProps {
  view: MobileView
  hasActive: boolean
  onChange: (next: MobileView) => void
}

function BottomNav({ view, hasActive, onChange }: BottomNavProps): JSX.Element {
  const items: Array<{ id: MobileView; label: string; icon: JSX.Element; disabled?: boolean }> = [
    { id: 'list', label: 'Worktrees', icon: <ListIcon className="w-5 h-5" /> },
    { id: 'terminal', label: 'Terminal', icon: <TerminalIcon className="w-5 h-5" />, disabled: !hasActive },
    { id: 'pr', label: 'PRs', icon: <GitPullRequest className="w-5 h-5" /> }
  ]
  return (
    <nav
      className="shrink-0 grid grid-cols-3 border-t border-border bg-panel-raised"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {items.map((it) => {
        const active = view === it.id
        return (
          <button
            key={it.id}
            disabled={it.disabled}
            onClick={() => onChange(it.id)}
            className={
              'flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors ' +
              (active
                ? 'text-fg-bright'
                : it.disabled
                  ? 'text-faint cursor-not-allowed'
                  : 'text-dim hover:text-fg')
            }
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

interface WorktreeListProps {
  groups: WorktreeGroup[]
  statuses: Record<string, PtyStatus>
  prStatuses: Record<string, PRStatus | null>
  activeWorktreeId: string | null
  loading: boolean
  onSelect: (path: string) => void
  onRefresh: () => void
}

function WorktreeList({ groups, statuses, prStatuses, activeWorktreeId, loading, onSelect, onRefresh }: WorktreeListProps): JSX.Element {
  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border bg-panel">
        <h1 className="text-base font-semibold text-fg-bright">Harness</h1>
        <button
          onClick={onRefresh}
          className="inline-flex items-center justify-center w-8 h-8 rounded text-dim hover:text-fg hover:bg-surface"
          aria-label="Refresh"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </header>
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 && (
          <div className="p-6 text-center text-dim text-sm">
            No worktrees yet. Create one from the desktop app to get started.
          </div>
        )}
        {groups.map((group) => (
          <section key={group.key}>
            <h2 className="sticky top-0 z-10 px-4 py-1.5 text-[10px] uppercase tracking-wider text-dim font-semibold bg-app/95 backdrop-blur border-b border-border">
              {group.label}
            </h2>
            <ul className="divide-y divide-border">
              {group.worktrees.map((wt) => {
                const isActive = wt.path === activeWorktreeId
                const status = statuses[wt.path] ?? 'idle'
                const pr = prStatuses[wt.path] ?? null
                return (
                  <li key={wt.path}>
                    <button
                      onClick={() => onSelect(wt.path)}
                      className={
                        'w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ' +
                        (isActive ? 'bg-surface' : 'hover:bg-panel')
                      }
                    >
                      <span className={'shrink-0 mt-1.5 w-2 h-2 rounded-full ' + STATUS_DOT[status]} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-fg-bright truncate">
                            {wt.branch || wt.path.split('/').pop()}
                          </span>
                          {wt.isMain && (
                            <span className="text-[10px] uppercase tracking-wider text-dim">main</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-dim">
                          <span className="truncate">{wt.repoRoot.split('/').pop()}</span>
                          {pr && (
                            <span className="inline-flex items-center gap-1 shrink-0">
                              <GitPullRequest className="w-3 h-3" />
                              #{pr.number}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

interface TerminalScreenProps {
  worktree: Worktree
  tab: RunnableTab | null
  onBack: () => void
}

function TerminalScreen({ worktree, tab, onBack }: TerminalScreenProps): JSX.Element {
  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 flex items-center gap-2 px-2 py-2 border-b border-border bg-panel">
        <button
          onClick={onBack}
          className="inline-flex items-center justify-center w-8 h-8 rounded text-dim hover:text-fg hover:bg-surface"
          aria-label="Back"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fg-bright truncate flex items-center gap-1">
            <GitBranch className="w-3.5 h-3.5 text-dim shrink-0" />
            {worktree.branch || worktree.path.split('/').pop()}
          </div>
          <div className="text-[11px] text-dim truncate">
            {worktree.repoRoot.split('/').pop()}
          </div>
        </div>
      </header>
      <div className="flex-1 min-h-0">
        {tab ? (
          <MobileTerminal worktreePath={worktree.path} tab={tab} />
        ) : (
          <EmptyScreen message="No terminal yet for this worktree. Open it on desktop to spawn a session." />
        )}
      </div>
    </div>
  )
}

interface PrScreenProps {
  worktrees: Worktree[]
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  loading: boolean
  activeWorktreeId: string | null
  onSelect: (path: string) => void
  onRefresh: () => void
}

function PrScreen({ worktrees, prStatuses, loading, activeWorktreeId, onSelect, onRefresh }: PrScreenProps): JSX.Element {
  const withPrs = useMemo(
    () => worktrees.filter((w) => prStatuses[w.path]),
    [worktrees, prStatuses]
  )
  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border bg-panel">
        <h1 className="text-base font-semibold text-fg-bright">Pull Requests</h1>
        <button
          onClick={onRefresh}
          className="inline-flex items-center justify-center w-8 h-8 rounded text-dim hover:text-fg hover:bg-surface"
          aria-label="Refresh"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </header>
      <div className="flex-1 overflow-y-auto">
        {withPrs.length === 0 && (
          <div className="p-6 text-center text-dim text-sm">
            No open PRs across your worktrees.
          </div>
        )}
        <ul className="divide-y divide-border">
          {withPrs.map((wt) => {
            const pr = prStatuses[wt.path]!
            const isActive = wt.path === activeWorktreeId
            return (
              <li key={wt.path}>
                <div
                  className={
                    'flex items-start gap-3 px-4 py-3 ' +
                    (isActive ? 'bg-surface' : '')
                  }
                >
                  <GitPullRequest className="w-4 h-4 mt-0.5 text-info shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-fg-bright truncate">{pr.title}</div>
                    <div className="text-xs text-dim mt-0.5 flex items-center gap-2">
                      <span className="truncate">{wt.repoRoot.split('/').pop()}</span>
                      <span>#{pr.number}</span>
                      <span>{prStateLabel(pr)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => onSelect(wt.path)}
                      className="px-2 py-1 rounded text-[11px] text-fg bg-panel border border-border hover:bg-surface"
                    >
                      Open
                    </button>
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center w-7 h-7 rounded text-dim hover:text-fg"
                      aria-label="Open PR on GitHub"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
        <div className="p-4 text-[11px] text-dim text-center">
          <ActivityIcon className="inline w-3 h-3 mr-1 align-middle" />
          Detailed PR review and merge actions are desktop-only for now.
        </div>
      </div>
    </div>
  )
}

function prStateLabel(pr: PRStatus): string {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.state === 'draft') return 'draft'
  if (pr.checksOverall === 'failure') return 'checks failing'
  if (pr.reviewDecision === 'changes_requested') return 'changes requested'
  if (pr.reviewDecision === 'approved') return 'approved'
  return 'open'
}

function EmptyScreen({ message }: { message: string }): JSX.Element {
  return (
    <div className="h-full flex items-center justify-center px-6 text-center text-dim text-sm">
      {message}
    </div>
  )
}
