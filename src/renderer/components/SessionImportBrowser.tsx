import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Clock,
  FolderGit2,
  FolderClosed,
  GitBranch,
  GitPullRequest,
  HelpCircle,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { useBackend } from '../backend'
import { useSessionImport } from '../store'
import type {
  BranchNode,
  DiscoveredSession,
  SessionGroupKind,
  SessionGroupNode
} from '../../shared/session-import-types'

/** Browser for Claude Code sessions found on disk, so work started outside
 *  Ness can be pulled into a worktree.
 *
 *  The design constraint is volume: a real corpus is thousands of sessions,
 *  most of them uninteresting one-shots in scratch directories. Nothing is
 *  hidden — a filter the user can't see is one they can't correct — so
 *  everything is reachable and collapse does the work instead. Groups start
 *  closed, so a bucket of 6000 sessions costs one row. Long lists reveal
 *  incrementally rather than rendering thousands of nodes at once. */

const SESSIONS_PER_PAGE = 15
const BRANCHES_PER_PAGE = 20

function formatAgo(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const days = Math.floor(diff / 86_400_000)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** For sessions read whole the turn count is exact and worth showing. For the
 *  large ones only head+tail was read, so the count is a lower bound —
 *  rendering "1 turn" on an hour-long session would be a lie, and "1+" reads
 *  like a glitch. Those show transcript size instead, which is honest and is
 *  the better size signal for agentic sessions anyway. */
function sessionMetric(session: DiscoveredSession): string {
  if (!session.userTurnsExact) return formatSize(session.sizeBytes)
  return session.userTurns === 1 ? '1 turn' : `${session.userTurns} turns`
}

function GroupIcon({ kind }: { kind: SessionGroupKind }): JSX.Element {
  if (kind === 'repo') return <FolderGit2 className="icon-sm text-accent" />
  if (kind === 'unknown') return <HelpCircle className="icon-sm text-dim" />
  return <FolderClosed className="icon-sm text-dim" />
}

function matchesQuery(session: DiscoveredSession, query: string): boolean {
  if (!query) return true
  const haystack = [
    session.title ?? '',
    session.gitBranch ?? '',
    session.cwd ?? '',
    session.prNumber ? `#${session.prNumber}` : ''
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

function filterTree(tree: SessionGroupNode[], query: string): SessionGroupNode[] {
  if (!query) return tree
  const out: SessionGroupNode[] = []
  for (const group of tree) {
    const branches: BranchNode[] = []
    for (const branch of group.branches) {
      const sessions = branch.sessions.filter((s) => matchesQuery(s, query))
      if (sessions.length > 0) {
        branches.push({ ...branch, sessions, sessionCount: sessions.length })
      }
    }
    if (branches.length > 0) {
      out.push({
        ...group,
        branches,
        sessionCount: branches.reduce((n, b) => n + b.sessionCount, 0)
      })
    }
  }
  return out
}

interface SessionRowProps {
  session: DiscoveredSession
  targetWorktreePath: string
  onImported: (label: string) => void
}

function SessionRow({ session, targetWorktreePath, onImported }: SessionRowProps): JSX.Element {
  const api = useBackend()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const willFork = session.cwd !== targetWorktreePath

  const handleImport = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await api.importSession({
        sessionId: session.sessionId,
        targetWorktreePath
      })
      if (!outcome.ok) {
        setError(outcome.reason ?? 'Import failed')
        return
      }
      onImported(session.title ?? 'Imported chat')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [api, session.sessionId, session.title, targetWorktreePath, onImported])

  return (
    <div className="flex items-center gap-2 pl-12 pr-3 py-1.5 hover:bg-surface-hover group">
      <MessageSquare className="icon-xs text-dim shrink-0" />
      <span className="text-sm text-fg truncate flex-1" title={session.title ?? undefined}>
        {session.title ?? <span className="text-dim italic">Untitled session</span>}
      </span>
      {session.prNumber !== null && (
        <span
          className="flex items-center gap-1 text-xs text-dim shrink-0"
          title={session.prUrl ?? undefined}
        >
          <GitPullRequest className="icon-2xs" />
          {session.prNumber}
        </span>
      )}
      <span className="text-xs text-dim shrink-0 tabular-nums">{sessionMetric(session)}</span>
      <span className="text-xs text-dim shrink-0 tabular-nums w-16 text-right">
        {formatAgo(session.lastTimestamp ?? session.mtimeMs)}
      </span>
      {error ? (
        <span className="text-xs text-danger shrink-0 max-w-40 truncate" title={error}>
          {error}
        </span>
      ) : (
        <button
          onClick={handleImport}
          disabled={busy}
          className="text-xs px-2 py-0.5 rounded border border-border text-dim opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-fg-bright hover:border-accent transition-all cursor-pointer disabled:cursor-wait shrink-0"
          title={
            willFork
              ? 'Copy this conversation into the current worktree and open it'
              : 'Resume this conversation in place'
          }
        >
          {busy ? (
            <Loader2 className="icon-2xs animate-spin" />
          ) : willFork ? (
            'Copy here'
          ) : (
            'Resume'
          )}
        </button>
      )}
    </div>
  )
}

interface BranchSectionProps {
  branch: BranchNode
  expanded: boolean
  onToggle: () => void
  targetWorktreePath: string
  onImported: (label: string) => void
}

function BranchSection({
  branch,
  expanded,
  onToggle,
  targetWorktreePath,
  onImported
}: BranchSectionProps): JSX.Element {
  const [shown, setShown] = useState(SESSIONS_PER_PAGE)
  const visible = branch.sessions.slice(0, shown)
  const remaining = branch.sessionCount - visible.length

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 pl-7 pr-3 py-1.5 hover:bg-surface-hover cursor-pointer text-left"
      >
        {expanded ? (
          <ChevronDown className="icon-xs text-dim shrink-0" />
        ) : (
          <ChevronRight className="icon-xs text-dim shrink-0" />
        )}
        <GitBranch className="icon-xs text-dim shrink-0" />
        <span className="text-sm text-fg truncate flex-1">
          {branch.branch ?? <span className="text-dim italic">No branch</span>}
        </span>
        {branch.prCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-dim shrink-0">
            <GitPullRequest className="icon-2xs" />
            {branch.prCount}
          </span>
        )}
        <span className="text-xs text-dim shrink-0 tabular-nums">{branch.sessionCount}</span>
      </button>
      {expanded && (
        <div>
          {visible.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              targetWorktreePath={targetWorktreePath}
              onImported={onImported}
            />
          ))}
          {remaining > 0 && (
            <button
              onClick={() => setShown((n) => n + SESSIONS_PER_PAGE * 4)}
              className="w-full text-left pl-12 pr-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer"
            >
              Show {remaining} more…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

interface GroupSectionProps {
  group: SessionGroupNode
  expanded: boolean
  onToggle: () => void
  expandedBranches: Set<string>
  onToggleBranch: (key: string) => void
  targetWorktreePath: string
  onImported: (label: string) => void
}

function GroupSection({
  group,
  expanded,
  onToggle,
  expandedBranches,
  onToggleBranch,
  targetWorktreePath,
  onImported
}: GroupSectionProps): JSX.Element {
  const [shown, setShown] = useState(BRANCHES_PER_PAGE)
  const visible = group.branches.slice(0, shown)
  const remaining = group.branches.length - visible.length

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-hover cursor-pointer text-left"
      >
        {expanded ? (
          <ChevronDown className="icon-sm text-dim shrink-0" />
        ) : (
          <ChevronRight className="icon-sm text-dim shrink-0" />
        )}
        <GroupIcon kind={group.kind} />
        <span className="text-sm font-medium text-fg-bright truncate flex-1" title={group.path ?? undefined}>
          {group.label}
        </span>
        {group.prCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-dim shrink-0">
            <GitPullRequest className="icon-2xs" />
            {group.prCount}
          </span>
        )}
        <span className="text-xs text-dim shrink-0">
          {group.branches.length} {group.branches.length === 1 ? 'branch' : 'branches'}
        </span>
        <span className="text-xs text-dim shrink-0 tabular-nums w-14 text-right">
          {group.sessionCount}
        </span>
      </button>
      {expanded && (
        <div className="pb-1">
          {visible.map((branch) => (
            <BranchSection
              key={branch.key}
              branch={branch}
              expanded={expandedBranches.has(branch.key)}
              onToggle={() => onToggleBranch(branch.key)}
              targetWorktreePath={targetWorktreePath}
              onImported={onImported}
            />
          ))}
          {remaining > 0 && (
            <button
              onClick={() => setShown((n) => n + BRANCHES_PER_PAGE * 4)}
              className="w-full text-left pl-7 pr-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer"
            >
              Show {remaining} more {remaining === 1 ? 'branch' : 'branches'}…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

interface SessionImportBrowserProps {
  isOpen: boolean
  onClose: () => void
  /** Worktree an imported session is attached to. */
  targetWorktreePath: string
}

export function SessionImportBrowser({
  isOpen,
  onClose,
  targetWorktreePath
}: SessionImportBrowserProps): JSX.Element | null {
  const api = useBackend()
  const scan = useSessionImport()
  const [tree, setTree] = useState<SessionGroupNode[] | null>(null)
  const [query, setQuery] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)

  const loadTree = useCallback(async () => {
    const next = await api.getImportableSessionTree()
    setTree(next)
  }, [api])

  const rescan = useCallback(async () => {
    await api.scanImportableSessions()
    await loadTree()
  }, [api, loadTree])

  useEffect(() => {
    if (!isOpen) return
    // A scan that has never run has nothing to show; one that has run is
    // cheap to re-read from the cache, so refresh on every open rather than
    // showing a stale tree from a previous session.
    void rescan()
  }, [isOpen, rescan])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = useMemo(() => filterTree(tree ?? [], normalizedQuery), [tree, normalizedQuery])

  // A search that matched deep in the tree is useless behind collapsed rows,
  // so searching expands what it found and clearing restores manual control.
  const searchExpandedGroups = useMemo(
    () => (normalizedQuery ? new Set(filtered.map((g) => g.key)) : null),
    [normalizedQuery, filtered]
  )
  const searchExpandedBranches = useMemo(
    () =>
      normalizedQuery
        ? new Set(filtered.flatMap((g) => g.branches.map((b) => b.key)))
        : null,
    [normalizedQuery, filtered]
  )

  const effectiveGroups = searchExpandedGroups ?? expandedGroups
  const effectiveBranches = searchExpandedBranches ?? expandedBranches

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleBranch = useCallback((key: string) => {
    setExpandedBranches((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const handleImported = useCallback(
    (label: string) => {
      setToast(`Opened “${label}”`)
      onClose()
    },
    [onClose]
  )

  if (!isOpen) return null

  const scanning = scan.status === 'scanning'
  const totalShown = filtered.reduce((n, g) => n + g.sessionCount, 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/80 backdrop-blur-sm">
      <div className="bg-panel border border-border rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare className="icon-sm text-accent" />
            <h2 className="text-sm font-semibold text-fg-bright">Import chat history</h2>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void rescan()}
              disabled={scanning}
              className="flex items-center gap-1.5 text-xs text-dim hover:text-fg transition-colors cursor-pointer disabled:cursor-wait"
              title="Rescan ~/.claude/projects"
            >
              <RefreshCw className={`icon-xs ${scanning ? 'animate-spin' : ''}`} />
              Rescan
            </button>
            <button
              onClick={onClose}
              className="text-dim hover:text-fg transition-colors cursor-pointer"
              aria-label="Close"
            >
              <X className="icon-sm" />
            </button>
          </div>
        </div>

        <div className="px-5 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Search className="icon-sm text-dim shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, branch, path or PR number…"
              className="flex-1 bg-transparent text-sm text-fg placeholder:text-dim outline-none"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {scanning && tree === null ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-dim">
              <Loader2 className="icon-lg animate-spin" />
              <span className="text-sm">
                {scan.total > 0
                  ? `Scanning ${scan.scanned.toLocaleString()} of ${scan.total.toLocaleString()}…`
                  : 'Scanning ~/.claude/projects…'}
              </span>
            </div>
          ) : scan.status === 'error' ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16">
              <span className="text-sm text-danger">Scan failed</span>
              <span className="text-xs text-dim">{scan.error}</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-dim">
              <Clock className="icon-lg" />
              <span className="text-sm">
                {normalizedQuery ? 'No sessions match that search' : 'No sessions found on disk'}
              </span>
            </div>
          ) : (
            filtered.map((group) => (
              <GroupSection
                key={group.key}
                group={group}
                expanded={effectiveGroups.has(group.key)}
                onToggle={() => toggleGroup(group.key)}
                expandedBranches={effectiveBranches}
                onToggleBranch={toggleBranch}
                targetWorktreePath={targetWorktreePath}
                onImported={handleImported}
              />
            ))
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-2 border-t border-border shrink-0 text-xs text-dim">
          <span>
            {totalShown.toLocaleString()} {totalShown === 1 ? 'session' : 'sessions'}
            {normalizedQuery ? ' matching' : ''} in {filtered.length}{' '}
            {filtered.length === 1 ? 'location' : 'locations'}
          </span>
          {toast ? (
            <span className="text-accent">{toast}</span>
          ) : (
            <span>Resuming keeps history in place; copying leaves the original untouched</span>
          )}
        </div>
      </div>
    </div>
  )
}
