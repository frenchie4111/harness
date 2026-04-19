import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, GitPullRequest, RefreshCw, Loader2, SquareTerminal, FileText, FileDiff, Globe, X, ExternalLink } from 'lucide-react'
import { useWorktrees, usePanes, useTerminals, usePrs } from '../store'
import { groupWorktrees, type WorktreeGroup } from '../worktree-sort'
import { getLeaves } from '../../shared/state/terminals'
import type { PtyStatus, TerminalTab, Worktree, PRStatus } from '../types'
import { MobileTerminal } from './MobileTerminal'
import { AgentIcon } from './AgentIcon'

type RunnableTab = TerminalTab & { type: 'agent' | 'shell' }

const STATUS_DOT: Record<PtyStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger'
}

function flatTabs(panes: ReturnType<typeof usePanes>, wtPath: string): TerminalTab[] {
  const tree = panes[wtPath]
  if (!tree) return []
  return getLeaves(tree).flatMap((l) => l.tabs)
}

function isRunnable(tab: TerminalTab): tab is RunnableTab {
  return tab.type === 'agent' || tab.type === 'shell'
}

function pickInitialTab(tabs: TerminalTab[]): string | null {
  return (
    tabs.find((t) => t.type === 'agent')?.id ??
    tabs.find((t) => t.type === 'shell')?.id ??
    tabs[0]?.id ??
    null
  )
}

export function MobileApp(): JSX.Element {
  const wtState = useWorktrees()
  const panes = usePanes()
  const terminals = useTerminals()
  const prs = usePrs()
  const worktrees = wtState.list
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(
    () => worktrees[0]?.path ?? null
  )
  // Mobile's own per-worktree tab focus. Independent of the desktop
  // pane-level activeTabId: changing the mobile selection shouldn't
  // yank another client's split pane around.
  const [selectedTabByWorktree, setSelectedTabByWorktree] = useState<Record<string, string>>({})
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (!activeWorktreeId) return
    if (worktrees.some((w) => w.path === activeWorktreeId)) return
    setActiveWorktreeId(worktrees[0]?.path ?? null)
  }, [activeWorktreeId, worktrees])

  useEffect(() => {
    if (!activeWorktreeId) return
    void window.api.panesEnsureInitialized(activeWorktreeId)
  }, [activeWorktreeId])

  useEffect(() => {
    void window.api.refreshWorktreesList()
    void window.api.refreshPRsAllIfStale()
  }, [])

  const activeWorktree = useMemo(
    () => worktrees.find((w) => w.path === activeWorktreeId) ?? null,
    [worktrees, activeWorktreeId]
  )

  const tabs = useMemo(
    () => (activeWorktree ? flatTabs(panes, activeWorktree.path) : []),
    [panes, activeWorktree]
  )

  // If the current mobile selection vanished (tab closed on desktop,
  // worktree switched), fall back to the first sensible tab.
  const selectedTabId = useMemo(() => {
    if (!activeWorktree) return null
    const claimed = selectedTabByWorktree[activeWorktree.path]
    if (claimed && tabs.some((t) => t.id === claimed)) return claimed
    return pickInitialTab(tabs)
  }, [activeWorktree, selectedTabByWorktree, tabs])

  const selectedTab = useMemo(
    () => tabs.find((t) => t.id === selectedTabId) ?? null,
    [tabs, selectedTabId]
  )

  const aggregateStatuses = useAggregateStatuses(worktrees, panes, terminals.statuses)

  const handleSelectWorktree = useCallback((wtPath: string) => {
    setActiveWorktreeId(wtPath)
    setPickerOpen(false)
  }, [])

  const handleSelectTab = useCallback(
    (tabId: string) => {
      if (!activeWorktree) return
      setSelectedTabByWorktree((prev) => ({ ...prev, [activeWorktree.path]: tabId }))
    },
    [activeWorktree]
  )

  return (
    <div
      className="flex flex-col bg-app text-fg overflow-hidden"
      style={{
        // 100dvh = the usable viewport height (without viewport-fit=cover
        // iOS reserves the notch / home-indicator areas for us, so we
        // don't need env(safe-area-inset-*) paddings and our layout
        // fits flush top-to-bottom with no voids). --viewport-h is set
        // by MobileTerminal while the textarea has focus so the
        // toolbar rides above the soft keyboard.
        height: 'var(--viewport-h, 100dvh)'
      }}
    >
      <Header
        worktree={activeWorktree}
        tabs={tabs}
        selectedTabId={selectedTabId}
        statuses={terminals.statuses}
        shellActivity={terminals.shellActivity}
        pickerOpen={pickerOpen}
        onTogglePicker={() => setPickerOpen((v) => !v)}
        onSelectTab={handleSelectTab}
      />

      <div className="flex-1 min-h-0 relative">
        {activeWorktree && selectedTab && isRunnable(selectedTab) && (
          <MobileTerminal worktreePath={activeWorktree.path} tab={selectedTab} />
        )}
        {activeWorktree && selectedTab && !isRunnable(selectedTab) && (
          <NonRunnableTabPlaceholder tab={selectedTab} />
        )}
        {activeWorktree && !selectedTab && (
          <EmptyScreen message="This worktree has no tabs yet. Open it on desktop to spawn one." />
        )}
        {!activeWorktree && worktrees.length === 0 && (
          <EmptyScreen message="No worktrees yet. Create one from the desktop app to get started." />
        )}
        {!activeWorktree && worktrees.length > 0 && (
          <EmptyScreen message="Pick a worktree above to open it." />
        )}

        {pickerOpen && (
          <WorktreePickerSheet
            worktrees={worktrees}
            prStatuses={prs.byPath}
            mergedPaths={prs.mergedByPath}
            loading={prs.loading}
            activeWorktreeId={activeWorktreeId}
            aggregateStatuses={aggregateStatuses}
            onSelect={handleSelectWorktree}
            onClose={() => setPickerOpen(false)}
            onRefresh={() => void window.api.refreshPRsAll()}
          />
        )}
      </div>
    </div>
  )
}

function useAggregateStatuses(
  worktrees: Worktree[],
  panes: ReturnType<typeof usePanes>,
  statuses: Record<string, PtyStatus>
): Record<string, PtyStatus> {
  return useMemo(() => {
    const out: Record<string, PtyStatus> = {}
    for (const wt of worktrees) {
      let worst: PtyStatus = 'idle'
      for (const tab of flatTabs(panes, wt.path)) {
        const s = statuses[tab.id]
        if (s === 'needs-approval') { worst = 'needs-approval'; break }
        if (s === 'waiting') worst = 'waiting'
        if (s === 'processing' && worst === 'idle') worst = 'processing'
      }
      out[wt.path] = worst
    }
    return out
  }, [worktrees, panes, statuses])
}

// -----------------------------------------------------------------------------
// Header: worktree picker button (left) + horizontal flat tab strip (right).
// -----------------------------------------------------------------------------

interface HeaderProps {
  worktree: Worktree | null
  tabs: TerminalTab[]
  selectedTabId: string | null
  statuses: Record<string, PtyStatus>
  shellActivity: Record<string, { active: boolean; processName?: string }>
  pickerOpen: boolean
  onTogglePicker: () => void
  onSelectTab: (tabId: string) => void
}

function Header({ worktree, tabs, selectedTabId, statuses, shellActivity, pickerOpen, onTogglePicker, onSelectTab }: HeaderProps): JSX.Element {
  const repoLabel = worktree ? worktree.repoRoot.split('/').pop() || worktree.repoRoot : null
  return (
    <header className="shrink-0 flex items-stretch border-b border-border bg-panel h-11">
      <button
        onClick={onTogglePicker}
        className={
          'shrink-0 flex items-center gap-1.5 px-3 h-full text-left border-r border-border ' +
          (pickerOpen ? 'bg-surface' : 'hover:bg-panel-raised')
        }
        style={{ maxWidth: '45%' }}
      >
        {worktree ? (
          <>
            <span className="min-w-0 flex flex-col leading-tight">
              <span className="text-[10px] uppercase tracking-wider text-dim truncate">{repoLabel}</span>
              <span className="text-xs font-medium text-fg-bright truncate">
                {worktree.branch || worktree.path.split('/').pop()}
              </span>
            </span>
            <ChevronDown className={'w-3.5 h-3.5 text-dim shrink-0 transition-transform ' + (pickerOpen ? 'rotate-180' : '')} />
          </>
        ) : (
          <span className="inline-flex items-center gap-1 text-sm text-fg">
            Select a worktree
            <ChevronDown className="w-3.5 h-3.5" />
          </span>
        )}
      </button>
      <div className="flex-1 min-w-0 flex items-stretch overflow-x-auto scrollbar-hidden">
        {tabs.map((tab) => (
          <TabChip
            key={tab.id}
            tab={tab}
            active={tab.id === selectedTabId}
            status={statuses[tab.id] ?? 'idle'}
            shellActivity={shellActivity[tab.id]}
            onSelect={() => onSelectTab(tab.id)}
          />
        ))}
      </div>
    </header>
  )
}

interface TabChipProps {
  tab: TerminalTab
  active: boolean
  status: PtyStatus
  shellActivity?: { active: boolean; processName?: string }
  onSelect: () => void
}

function TabChip({ tab, active, status, shellActivity, onSelect }: TabChipProps): JSX.Element {
  return (
    <button
      onClick={onSelect}
      className={
        'shrink-0 flex items-center gap-1.5 px-3 h-full text-xs whitespace-nowrap border-b-2 transition-colors ' +
        (active ? 'border-muted text-fg-bright bg-app' : 'border-transparent text-dim hover:text-fg')
      }
    >
      <TabIcon tab={tab} shellActivity={shellActivity} status={status} />
      <span className="max-w-[140px] truncate">{tab.label}</span>
    </button>
  )
}

function TabIcon({ tab, shellActivity, status }: { tab: TerminalTab; shellActivity?: { active: boolean; processName?: string }; status: PtyStatus }): JSX.Element {
  if (tab.type === 'agent') {
    return (
      <span className="inline-flex items-center gap-1">
        <AgentIcon kind={tab.agentKind ?? 'claude'} size={11} />
        <span className={'w-1.5 h-1.5 rounded-full ' + STATUS_DOT[status]} />
      </span>
    )
  }
  if (tab.type === 'shell') {
    return shellActivity?.active ? (
      <Loader2 size={11} className="animate-spin text-fg-bright" />
    ) : (
      <SquareTerminal size={11} className="text-dim" />
    )
  }
  if (tab.type === 'diff') return <FileDiff size={11} className="text-dim" />
  if (tab.type === 'file') return <FileText size={11} className="text-dim" />
  if (tab.type === 'browser') return <Globe size={11} className="text-dim" />
  return <span />
}

// -----------------------------------------------------------------------------
// Worktree picker sheet — full-body overlay below the header. Groups by PR
// status using the same groupWorktrees helper the desktop sidebar uses.
// -----------------------------------------------------------------------------

interface WorktreePickerSheetProps {
  worktrees: Worktree[]
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  loading: boolean
  activeWorktreeId: string | null
  aggregateStatuses: Record<string, PtyStatus>
  onSelect: (path: string) => void
  onClose: () => void
  onRefresh: () => void
}

function WorktreePickerSheet({ worktrees, prStatuses, mergedPaths, loading, activeWorktreeId, aggregateStatuses, onSelect, onClose, onRefresh }: WorktreePickerSheetProps): JSX.Element {
  const groups = useMemo<WorktreeGroup[]>(
    () => groupWorktrees(worktrees, prStatuses, mergedPaths),
    [worktrees, prStatuses, mergedPaths]
  )
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-app">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border bg-panel">
        <span className="text-xs uppercase tracking-wider text-dim font-semibold">Worktrees</span>
        <div className="flex items-center gap-1">
          <button
            onClick={onRefresh}
            className="inline-flex items-center justify-center w-8 h-8 rounded text-dim hover:text-fg hover:bg-surface"
            aria-label="Refresh"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          </button>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center w-8 h-8 rounded text-dim hover:text-fg hover:bg-surface"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
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
                const status = aggregateStatuses[wt.path] ?? 'idle'
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

// -----------------------------------------------------------------------------
// Fallback body content for non-runnable tabs (diff/file/browser) — mobile
// can't render them meaningfully, so we point the user back to desktop
// with a deep-link affordance where it makes sense.
// -----------------------------------------------------------------------------

function NonRunnableTabPlaceholder({ tab }: { tab: TerminalTab }): JSX.Element {
  const label =
    tab.type === 'diff' ? 'Diff view' :
    tab.type === 'file' ? 'File view' :
    tab.type === 'browser' ? 'Browser tab' : 'This tab'
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-sm text-fg-bright">{label} — desktop only</div>
      <div className="text-xs text-dim max-w-xs">
        {tab.label}
      </div>
      {tab.type === 'browser' && tab.url && (
        <a
          href={tab.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-accent underline"
        >
          <ExternalLink className="w-3 h-3" /> Open URL in browser
        </a>
      )}
    </div>
  )
}

function EmptyScreen({ message }: { message: string }): JSX.Element {
  return (
    <div className="h-full flex items-center justify-center px-6 text-center text-dim text-sm">
      {message}
    </div>
  )
}
