import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronDown,
  GitPullRequest,
  LayoutGrid,
  Loader2,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'

export type MockStatus = 'idle' | 'processing' | 'waiting' | 'needs-approval' | 'merged'

export interface MockWorktree {
  id: string
  /** Branch name shown as the primary label. */
  branch: string
  /** Shown as the secondary repo/path line under the branch. */
  path: string
  status: MockStatus
  /** When present, shows a GitPullRequest icon + ± stats. */
  pr?: {
    checks: 'success' | 'failure' | 'pending' | 'none'
    additions: number
    deletions: number
  }
}

export type HighlightedElement =
  | 'sidebar'
  | 'worktree-row'
  | 'new-worktree-button'
  | 'terminal'
  | null

export type PanelMode = 'terminal' | 'new-worktree-flow'

export interface MockHarnessState {
  activeWorktreeId: string
  worktrees: MockWorktree[]
  highlightedElement: HighlightedElement
  /** Which worktree row to emphasize when highlightedElement === 'worktree-row'. */
  highlightedWorktreeId?: string
  panelMode: PanelMode
}

/* ---- Status → class maps lifted from src/renderer/components/WorktreeTab.tsx ---- */

const STATUS_COLORS: Record<MockStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success animate-pulse',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger animate-pulse',
  merged: 'bg-accent'
}

const PR_ICON_COLOR: Record<'success' | 'failure' | 'pending' | 'none', string> = {
  success: 'text-success',
  failure: 'text-danger',
  pending: 'text-warning',
  none: 'text-dim'
}

/* ---- Root ---- */

export function MockHarness({ state }: { state: MockHarnessState }) {
  return (
    <div
      className="w-full h-full rounded-xl overflow-hidden border border-border-strong shadow-2xl shadow-black/70 bg-app flex flex-col font-sans select-none"
      style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}
    >
      <TrafficLights />
      <div className="flex flex-1 min-h-0">
        <MockSidebar state={state} />
        <AnimatePresence mode="wait" initial={false}>
          {state.panelMode === 'terminal' ? (
            <motion.div
              key="terminal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="flex-1 flex flex-col min-w-0 bg-app"
            >
              <MockTerminalPanel state={state} />
            </motion.div>
          ) : (
            <motion.div
              key="new-worktree"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="flex-1 flex flex-col min-w-0"
            >
              <MockNewWorktreeScreen />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function TrafficLights() {
  return (
    <div className="absolute top-0 left-0 h-10 flex items-center gap-2 px-4 z-10 pointer-events-none">
      <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
      <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
      <span className="w-3 h-3 rounded-full bg-[#28c840]" />
    </div>
  )
}

/* ---- Sidebar — structurally lifted from src/renderer/components/Sidebar.tsx ---- */

function MockSidebar({ state }: { state: MockHarnessState }) {
  const sidebarGlow = state.highlightedElement === 'sidebar'

  return (
    <motion.div
      animate={{
        boxShadow: sidebarGlow
          ? 'inset 0 0 0 1px rgba(245, 158, 11, 0.55), inset 0 0 48px rgba(245, 158, 11, 0.10)'
          : 'inset 0 0 0 0px rgba(245, 158, 11, 0)'
      }}
      transition={{ type: 'spring', stiffness: 200, damping: 30 }}
      className="shrink-0 bg-panel flex flex-col h-full relative"
      style={{ width: 240 }}
    >
      {/* Title bar drag region with gradient "Harness" — left-20 leaves room
       * for macOS traffic lights, same as the real app. */}
      <div className="h-10 relative shrink-0">
        <span className="gradient-text text-xs font-semibold absolute left-20 top-[11px]">
          Harness
        </span>
      </div>

      {/* Command Center entry */}
      <div className="px-2 pt-1 pb-1 shrink-0">
        <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded transition-colors text-muted hover:bg-panel-raised hover:text-fg">
          <LayoutGrid size={14} className="text-dim" />
          <span className="text-sm font-medium">Command Center</span>
        </button>
      </div>

      {/* Worktrees header */}
      <div className="px-3 py-1.5 flex items-center gap-2 shrink-0">
        <span className="text-xs font-medium text-dim">WORKTREES</span>
      </div>

      {/* Worktree list, grouped like the real app */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
        <GroupHeader label="Open PRs" count={state.worktrees.length} />
        <div>
          {state.worktrees.map((wt) => (
            <MockWorktreeTab
              key={wt.id}
              worktree={wt}
              isActive={wt.id === state.activeWorktreeId}
              highlighted={
                state.highlightedElement === 'worktree-row' &&
                wt.id === state.highlightedWorktreeId
              }
            />
          ))}
        </div>
      </div>

      {/* Footer buttons — new worktree + refresh + settings */}
      <div className="shrink-0 border-t border-border px-2 py-1.5 flex items-center gap-1">
        <NewWorktreeButton highlighted={state.highlightedElement === 'new-worktree-button'} />
        <button
          className="text-dim hover:text-fg hover:bg-panel-raised rounded p-1.5 transition-colors"
          aria-label="Refresh"
        >
          <RefreshCw size={13} />
        </button>
        <div className="flex-1" />
        <button
          className="text-dim hover:text-fg hover:bg-panel-raised rounded p-1.5 transition-colors"
          aria-label="Settings"
        >
          <SettingsIcon size={13} />
        </button>
      </div>
    </motion.div>
  )
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-dim">
      <ChevronDown size={12} className="shrink-0" />
      <span className="font-medium">{label}</span>
      <span className="text-faint ml-auto">{count}</span>
    </div>
  )
}

function NewWorktreeButton({ highlighted }: { highlighted: boolean }) {
  return (
    <motion.button
      animate={{
        boxShadow: highlighted
          ? '0 0 0 2px rgba(168, 85, 247, 0.55), 0 0 24px rgba(168, 85, 247, 0.45)'
          : '0 0 0 0px rgba(168, 85, 247, 0)',
        scale: highlighted ? 1.04 : 1
      }}
      transition={{ type: 'spring', stiffness: 220, damping: 22 }}
      className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-semibold bg-surface text-fg-bright hover:bg-surface-hover transition-colors"
      aria-label="New worktree"
    >
      <Plus size={13} />
      New
    </motion.button>
  )
}

/* ---- WorktreeTab — JSX lifted from src/renderer/components/WorktreeTab.tsx ---- */

function MockWorktreeTab({
  worktree,
  isActive,
  highlighted
}: {
  worktree: MockWorktree
  isActive: boolean
  highlighted: boolean
}) {
  const glowColor = worktree.status === 'needs-approval' ? '239, 68, 68' : '245, 158, 11'
  return (
    <motion.div
      animate={{
        boxShadow: highlighted
          ? `inset 0 0 0 1px rgba(${glowColor}, 0.55), 0 0 18px rgba(${glowColor}, 0.18)`
          : 'inset 0 0 0 0px rgba(0,0,0,0)'
      }}
      transition={{ type: 'spring', stiffness: 220, damping: 26 }}
      className={`group w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
        isActive ? 'bg-surface text-fg-bright' : 'text-muted hover:bg-panel-raised hover:text-fg'
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[worktree.status]}`}
        title={worktree.status}
      />
      {worktree.pr && (
        <span className="relative shrink-0">
          <GitPullRequest size={13} className={PR_ICON_COLOR[worktree.pr.checks]} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{worktree.branch}</div>
        <div className="text-xs text-faint truncate">{worktree.path}</div>
      </div>
      {worktree.pr && (
        <span className="text-[10px] font-mono shrink-0 leading-none">
          <span className="text-success">+{worktree.pr.additions}</span>
          <span className="text-danger ml-0.5">−{worktree.pr.deletions}</span>
        </span>
      )}
    </motion.div>
  )
}

/* ---- Terminal panel — structurally matches TerminalPanel.tsx tab bar + body ---- */

function MockTerminalPanel({ state }: { state: MockHarnessState }) {
  const active = state.worktrees.find((w) => w.id === state.activeWorktreeId) ?? state.worktrees[0]
  const showApprovalCard = active?.status === 'needs-approval'
  const terminalGlow = state.highlightedElement === 'terminal'

  return (
    <motion.div
      animate={{
        boxShadow: terminalGlow
          ? 'inset 0 0 0 1px rgba(245, 158, 11, 0.4)'
          : 'inset 0 0 0 0px rgba(245, 158, 11, 0)'
      }}
      transition={{ type: 'spring', stiffness: 200, damping: 30 }}
      className="flex-1 min-w-0 flex flex-col bg-app relative"
    >
      {/* Drag-region title bar (10px tall in the real app). We leave it empty
       * — no buttons — so it reads as pure window chrome. */}
      <div className="h-10 shrink-0 border-b border-border flex items-center px-4 text-xs text-dim">
        <span className="font-mono">
          {active?.path}
          <span className="text-faint mx-1">·</span>
          <span className="text-fg">{active?.branch}</span>
        </span>
      </div>

      {/* Tab bar lifted from TerminalPanel.tsx */}
      <div className="h-8 shrink-0 border-b border-border flex items-stretch px-2 bg-panel">
        <div className="shrink-0 flex items-center gap-1.5 px-3 h-full text-xs cursor-pointer border-b-2 border-muted text-fg-bright">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              STATUS_COLORS[active?.status ?? 'processing']
            }`}
          />
          <Sparkles size={10} className="text-accent" />
          <span>Claude</span>
        </div>
        <div className="shrink-0 flex items-center gap-1.5 px-3 h-full text-xs border-b-2 border-transparent text-dim hover:text-fg">
          <span className="w-1.5 h-1.5 rounded-full bg-faint" />
          <span>shell</span>
        </div>
        <div className="flex-1" />
        <button className="text-dim hover:text-fg self-center p-1 rounded">
          <Plus size={12} />
        </button>
      </div>

      {/* Terminal body */}
      <div className="flex-1 min-h-0 relative">
        <TerminalBody showApprovalCard={showApprovalCard} />
      </div>

      {/* Claude status line mimicking the real "accept edits on (shift+tab to cycle)" footer */}
      <div className="h-6 shrink-0 border-t border-border bg-panel flex items-center px-3 text-[10px] font-mono text-dim gap-3">
        <span className="text-accent">⏵⏵</span>
        <span className="text-fg">accept edits on</span>
        <span className="text-faint">(shift+tab to cycle)</span>
        <span className="flex-1" />
        <span className="text-dim">
          <span className="text-accent">○</span> medium · /effort
        </span>
      </div>
    </motion.div>
  )
}

function TerminalBody({ showApprovalCard }: { showApprovalCard: boolean }) {
  return (
    <div className="h-full font-mono text-[11px] leading-[1.55] text-fg p-4 overflow-hidden bg-app">
      {/* Banner — mirrors the "╭─╮ ✻ Welcome back" frame Claude Code draws. */}
      <div className="text-accent">╭──────────────────────────────────────────────╮</div>
      <div className="text-accent flex">
        <span>│</span>
        <span className="flex-1 px-2">
          <span className="gradient-text font-semibold">✻</span>
          <span className="text-fg-bright font-semibold"> Welcome back, Mike</span>
        </span>
        <span>│</span>
      </div>
      <div className="text-accent flex">
        <span>│</span>
        <span className="flex-1 px-2 text-dim">
          <span className="text-fg">Claude Code</span> v2.1.109 · Opus 4.7 (1M) · /private/tmp/harness
        </span>
        <span>│</span>
      </div>
      <div className="text-accent">╰──────────────────────────────────────────────╯</div>

      <div className="h-3" />

      <div className="flex items-start gap-1 text-fg">
        <span className="text-accent">›</span>
        <span>add pagination to the users query</span>
      </div>

      <div className="h-2" />

      <div className="text-fg">
        <span className="text-success">●</span>{' '}
        <span className="text-dim">Reading</span>{' '}
        <span className="text-fg-bright">src/api/users.ts</span>
      </div>
      <div className="text-fg">
        <span className="text-success">●</span>{' '}
        <span className="text-dim">Reading</span>{' '}
        <span className="text-fg-bright">src/api/schema.ts</span>
      </div>
      <div className="text-fg">
        <span className="text-success">●</span>{' '}
        <span className="text-dim">Writing</span>{' '}
        <span className="text-fg-bright">src/api/users.ts</span>
      </div>

      <div className="h-2" />

      <AnimatePresence>
        {showApprovalCard && (
          <motion.div
            key="approval"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.25 }}
            className="border border-danger/40 bg-danger/5 rounded-md px-3 py-2.5 mt-1 mb-2 max-w-md"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />
              <span className="text-fg-bright font-semibold text-[10px] uppercase tracking-wider">
                Bash — approval needed
              </span>
            </div>
            <div className="text-fg text-[11px] mb-2 font-mono">
              <span className="text-dim">$</span>{' '}
              <span className="text-warning">npx</span> prisma migrate deploy
            </div>
            <div className="flex gap-1.5">
              <span className="px-2 py-0.5 rounded bg-success/20 border border-success/40 text-success text-[9px] font-semibold">
                1. Yes
              </span>
              <span className="px-2 py-0.5 rounded bg-surface border border-border-strong text-dim text-[9px]">
                2. Yes, and don't ask again
              </span>
              <span className="px-2 py-0.5 rounded bg-surface border border-border-strong text-dim text-[9px]">
                3. No, tell Claude what to do differently
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-1 text-fg-bright mt-1">
        <span className="text-dim">›</span>
        <span className="inline-block w-[7px] h-[13px] bg-fg-bright caret-blink" />
      </div>
    </div>
  )
}

/* ---- New-worktree screen — JSX lifted from NewWorktreeScreen.tsx (fresh mode) ---- */

function MockNewWorktreeScreen() {
  return (
    <div className="flex-1 flex flex-col min-w-0 bg-app brand-grid-bg relative">
      <div className="h-10 shrink-0 flex items-center justify-end pr-3">
        <button className="text-dim hover:text-fg p-1.5 rounded transition-colors">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-4">
          <div className="text-center mb-6">
            <img
              src="/icon.png"
              alt="Harness"
              className="w-14 h-14 mx-auto rounded-2xl mb-3 brand-glow-amber"
            />
            <h1 className="text-3xl font-extrabold tracking-tight mb-1">
              New <span className="brand-gradient-text">worktree</span>
            </h1>
            <p className="text-muted text-sm">Fork a branch and send a Claude into it.</p>
          </div>

          <div className="bg-panel/80 backdrop-blur border border-border rounded-2xl p-4 shadow-xl">
            <div className="flex p-1 bg-app border border-border-strong rounded-lg mb-4">
              <div className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-panel text-fg-bright shadow-sm">
                <Sparkles size={12} />
                Fresh start
              </div>
              <div className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md text-dim">
                <span className="w-3 h-3 rounded-full border border-dim" />
                Teleport from claude.ai
              </div>
            </div>

            <div className="block">
              <div className="mb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">
                  Branch name
                </span>
              </div>
              <div
                className="w-full bg-app border-2 border-accent rounded-lg px-3 py-2 font-mono text-fg-bright"
                style={{ fontSize: '13px' }}
              >
                feat/realtime-presence
                <span className="inline-block w-[1px] h-3.5 bg-fg-bright caret-blink ml-0.5 align-middle" />
              </div>
            </div>

            <div className="block mt-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">
                  Kickoff prompt
                </span>
                <span className="text-[10px] text-faint">optional</span>
              </div>
              <div className="w-full bg-app border-2 border-border-strong rounded-lg px-3 py-2 text-xs text-fg leading-relaxed min-h-[60px]">
                Add a presence indicator to the sidebar showing which teammates are currently
                viewing the same doc.
              </div>
            </div>

            <div className="flex items-center justify-between mt-4 gap-3">
              <div className="text-[10px] text-faint">
                <span className="font-mono">⌘⏎</span> to create ·{' '}
                <span className="font-mono">Esc</span> to cancel
              </div>
              <div className="flex items-center gap-2">
                <div className="px-3 py-1.5 text-xs text-dim">Cancel</div>
                <div className="brand-gradient-bg text-white font-semibold text-xs px-4 py-2 rounded-lg flex items-center gap-1.5 shadow-lg">
                  <Sparkles size={12} />
                  Create worktree
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
