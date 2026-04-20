import type { ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  FileText,
  Folder,
  FolderOpen,
  GitCommit,
  GitPullRequest,
  LayoutGrid,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'

export type MockStatus = 'idle' | 'processing' | 'waiting' | 'needs-approval' | 'merged'

export interface MockWorktree {
  id: string
  branch: string
  path: string
  status: MockStatus
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
  | 'right-column-button'
  | null

export type PanelMode = 'terminal' | 'new-worktree-flow'

export interface MockHarnessState {
  activeWorktreeId: string
  worktrees: MockWorktree[]
  highlightedElement: HighlightedElement
  highlightedWorktreeId?: string
  panelMode: PanelMode
  /** Optional count shown on the (always-collapsed) Merged / Closed header. */
  mergedClosedCount?: number
  /** When true, the right column (PR / commits / files / editor) is visible
   * to the right of the terminal. */
  rightPanelOpen?: boolean
}

const STATUS_COLORS: Record<MockStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success animate-pulse',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger animate-pulse',
  merged: 'bg-accent'
}

const TAB_STATUS_COLORS: Record<MockStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger',
  merged: 'bg-accent'
}

const PR_ICON_COLOR: Record<'success' | 'failure' | 'pending' | 'none', string> = {
  success: 'text-success',
  failure: 'text-danger',
  pending: 'text-warning',
  none: 'text-dim'
}

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

function MockSidebar({ state }: { state: MockHarnessState }) {
  const sidebarGlow = state.highlightedElement === 'sidebar'

  const needsAttention = state.worktrees.filter((w) => w.pr?.checks === 'failure')
  const openPRs = state.worktrees.filter((w) => w.pr && w.pr.checks !== 'failure')
  const activeNoPR = state.worktrees.filter((w) => !w.pr)
  const mergedCount = state.mergedClosedCount ?? 3

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
      <svg width="0" height="0" className="absolute" aria-hidden="true">
        <defs>
          <linearGradient id="harness-add-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f59e0b" />
            <stop offset="50%" stopColor="#ef4444" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
      </svg>

      <div className="h-10 relative shrink-0">
        <span className="gradient-text text-xs font-semibold absolute left-20 top-[11px]">
          Harness
        </span>
      </div>

      <div className="px-2 pt-1 pb-1 shrink-0">
        <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded transition-colors text-muted hover:bg-panel-raised hover:text-fg">
          <LayoutGrid size={14} className="text-dim" />
          <span className="text-sm font-medium">Command Center</span>
        </button>
      </div>

      <div className="px-3 py-1.5 flex items-center gap-2 shrink-0">
        <span className="text-xs font-medium text-dim">WORKTREES</span>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
        {needsAttention.length > 0 && (
          <>
            <GroupHeader label="Needs Attention" count={needsAttention.length} expanded />
            {needsAttention.map((wt) => (
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
          </>
        )}

        {openPRs.length > 0 && (
          <>
            <GroupHeader label="Open PRs" count={openPRs.length} expanded />
            {openPRs.map((wt) => (
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
          </>
        )}

        {activeNoPR.length > 0 && (
          <>
            <GroupHeader label="Active" count={activeNoPR.length} expanded />
            {activeNoPR.map((wt) => (
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
          </>
        )}

        <GroupHeader label="Merged / Closed" count={mergedCount} expanded={false} />

        <NewWorktreeRow highlighted={state.highlightedElement === 'new-worktree-button'} />
      </div>

      <div className="border-t border-border p-2 flex justify-center gap-1 shrink-0">
        <button
          className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors"
          aria-label="Refresh worktrees"
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors"
          aria-label="Add repository"
        >
          <FolderOpen size={14} />
        </button>
        <button
          className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors"
          aria-label="Clean up old worktrees"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </motion.div>
  )
}

function GroupHeader({
  label,
  count,
  expanded
}: {
  label: string
  count: number
  expanded: boolean
}) {
  return (
    <div className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-dim">
      {expanded ? (
        <ChevronDown size={12} className="shrink-0" />
      ) : (
        <ChevronRight size={12} className="shrink-0" />
      )}
      <span className="font-medium">{label}</span>
      <span className="text-faint ml-auto">{count}</span>
    </div>
  )
}

function NewWorktreeRow({ highlighted }: { highlighted: boolean }) {
  return (
    <motion.div
      animate={{
        boxShadow: highlighted
          ? '0 0 24px rgba(168, 85, 247, 0.30)'
          : '0 0 0px rgba(168, 85, 247, 0)'
      }}
      transition={{ type: 'spring', stiffness: 220, damping: 24 }}
      className={`group relative w-full flex items-center gap-2 px-3 py-2 mt-1 text-dim hover:bg-panel-raised overflow-hidden cursor-pointer transition-colors ${
        highlighted ? 'brand-gradient-flow-text-active bg-panel-raised' : ''
      }`}
    >
      <span
        className={`absolute left-0 top-0 bottom-0 w-0.5 brand-gradient-flow-bar transition-opacity ${
          highlighted ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      />
      <Plus
        size={13}
        className="shrink-0 transition-colors"
        style={highlighted ? { stroke: 'url(#harness-add-gradient)' } : undefined}
      />
      <span className="text-sm font-medium brand-gradient-flow-text-hover">Add worktree</span>
      <span className="ml-auto text-[10px] font-mono text-faint border border-border-strong rounded px-1 py-[1px]">
        ⌘T
      </span>
    </motion.div>
  )
}

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

function MockTerminalPanel({ state }: { state: MockHarnessState }) {
  const active = state.worktrees.find((w) => w.id === state.activeWorktreeId) ?? state.worktrees[0]
  const terminalGlow = state.highlightedElement === 'terminal'
  const rightColumnGlow = state.highlightedElement === 'right-column-button'

  return (
    <div className="flex-1 flex min-w-0">
      <motion.div
        animate={{
          boxShadow: terminalGlow
            ? 'inset 0 0 0 1px rgba(245, 158, 11, 0.4)'
            : 'inset 0 0 0 0px rgba(245, 158, 11, 0)'
        }}
        transition={{ type: 'spring', stiffness: 200, damping: 30 }}
        className="flex-1 min-w-0 flex flex-col bg-app relative"
      >
        <div className="h-10 shrink-0 border-b border-border bg-panel flex items-center">
          <div className="shrink-0 flex items-center gap-1.5 px-3 h-full text-xs whitespace-nowrap">
            <span className="font-medium text-cyan-400">
              {repoNameFromPath(active?.path ?? '')}
            </span>
            <span className="text-faint">/</span>
            <span className="text-fg-bright font-medium">{active?.branch}</span>
          </div>

          <div className="flex items-center h-full overflow-x-auto pl-2 flex-1 min-w-0">
            <div className="shrink-0 flex items-center gap-1.5 px-3 h-full text-xs border-b-2 border-muted text-fg-bright">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  TAB_STATUS_COLORS[active?.status ?? 'processing']
                }`}
              />
              <span>Claude</span>
            </div>
            <div className="shrink-0 flex items-center gap-1.5 px-3 h-full text-xs border-b-2 border-transparent text-dim hover:text-fg">
              <span className="w-1.5 h-1.5 rounded-full bg-faint" />
              <span>shell</span>
            </div>
            <button className="shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors">
              <Sparkles size={12} />
            </button>
            <button className="shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors">
              <Plus size={12} />
            </button>
          </div>

          <button
            className="shrink-0 px-3 h-full text-faint hover:text-fg transition-colors"
            aria-label="Open worktree in editor"
          >
            <Code2 size={13} />
          </button>
          <motion.button
            animate={{
              boxShadow: rightColumnGlow
                ? '0 0 0 2px rgba(245, 158, 11, 0.6), 0 0 18px rgba(245, 158, 11, 0.35)'
                : '0 0 0 0px rgba(245, 158, 11, 0)',
              scale: rightColumnGlow ? 1.08 : 1
            }}
            transition={{ type: 'spring', stiffness: 220, damping: 22 }}
            className="shrink-0 pr-3 pl-1 h-full text-faint hover:text-fg transition-colors rounded"
            aria-label={state.rightPanelOpen ? 'Hide right column' : 'Show right column'}
          >
            {state.rightPanelOpen ? (
              <PanelRightClose size={13} />
            ) : (
              <PanelRightOpen size={13} />
            )}
          </motion.button>
        </div>

        <div className="flex-1 min-h-0 relative">
          <ClaudeTUI active={active} />
        </div>
      </motion.div>

      <AnimatePresence initial={false}>
        {state.rightPanelOpen && (
          <motion.div
            key="right-panel"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 288, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 220, damping: 30 }}
            className="shrink-0 overflow-hidden border-l border-border"
          >
            <MockRightPanel active={active} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function repoNameFromPath(path: string): string {
  const head = path.split('/')[0]
  return head || 'harness'
}

/** Renders a screenshot of Claude Code's fullscreen TUI as seen inside a
 * Harness terminal pane. Layout mirrors the real thing: banner at top,
 * empty working area, effort indicator + path-terminated separators, the
 * input prompt (or an approval prompt when the worktree is blocked), and
 * the "accept edits on" status line. */
function ClaudeTUI({ active }: { active: MockWorktree }) {
  const needsApproval = active.status === 'needs-approval'
  const repoName = 'claude-harness/' + active.path.replace(/^harness\//, '')
  return (
    <div className="h-full flex flex-col font-mono text-[11px] leading-[1.55] bg-app px-4 py-3 overflow-hidden">
      <div className="flex gap-3 shrink-0">
        <pre
          className="leading-[1.1] text-[11px] m-0"
          style={{ color: '#f59e0b' }}
        >
{` ▐▛███▜▌
▝▜█████▛▘
  ▘▘ ▝▝`}
        </pre>
        <div className="leading-[1.4] pt-[1px]">
          <div>
            <span className="text-fg-bright">Claude Code</span>
            <span className="text-dim"> v2.1.114</span>
          </div>
          <div className="text-dim">Opus 4.7 (1M context) · Claude Max</div>
          <div className="text-dim truncate">~/{active.path}</div>
        </div>
      </div>

      <div className="mt-3 text-dim shrink-0 truncate">
        <span className="text-success">/remote-control</span> is active · Code in CLI or at{' '}
        <span className="text-info">
          https://claude.ai/code/session_01EypUSUvzm5dfZ1KwhmWpLN
        </span>
      </div>

      <div className="flex-1" />

      <AnimatePresence mode="wait" initial={false}>
        {needsApproval && (
          <motion.div
            key="approval"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.25 }}
            className="shrink-0 mb-3"
          >
            <div>
              <span className="text-accent">⏺</span>{' '}
              <span className="text-fg-bright">Bash</span>{' '}
              <span className="text-dim">(npx prisma migrate deploy)</span>
            </div>
            <div className="text-dim">
              <span>  ⎿  </span>Do you want to proceed?
            </div>
            <div className="pl-5 text-fg">
              <div>
                <span className="text-warning">❯</span> 1. Yes
              </div>
              <div className="pl-3 text-dim">
                2. Yes, and don't ask again this session{' '}
                <span className="text-faint">(shift+tab)</span>
              </div>
              <div className="pl-3 text-dim">
                3. No, and tell Claude what to do differently{' '}
                <span className="text-faint">(esc)</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="text-right text-dim text-[10px] shrink-0">
        <span className="text-success">◉</span> high{' '}
        <span className="text-faint">· /effort</span>
      </div>

      <div className="flex items-center gap-2 shrink-0 mt-0.5">
        <div className="flex-1 border-t border-border-strong" />
        <span className="text-dim text-[10px] whitespace-nowrap">{repoName}</span>
        <div className="w-3 border-t border-border-strong" />
      </div>

      <div className="shrink-0 py-1.5 min-h-[22px] flex items-center">
        {!needsApproval && (
          <>
            <span className="text-accent">❯</span>
            <span className="inline-block w-[6px] h-[12px] bg-fg-bright caret-blink ml-1 align-middle" />
          </>
        )}
      </div>

      <div className="border-t border-border-strong shrink-0" />

      <div className="mt-1.5 text-dim shrink-0">
        <span className="text-accent">⏵⏵</span> accept edits on{' '}
        <span className="text-faint">(shift+tab to cycle)</span>
      </div>
    </div>
  )
}

function MockRightPanel({ active }: { active: MockWorktree }) {
  return (
    <div className="w-[288px] h-full bg-panel flex flex-col">
      <RightPanelSection title="PR Status">
        <div className="px-3 py-2.5 flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <GitPullRequest size={12} className="text-success shrink-0" />
            <span className="text-xs text-fg-bright font-medium truncate">
              Onboarding flow ready for review
            </span>
          </div>
          <div className="text-[10px] text-dim">
            #142 · opened 2 days ago by{' '}
            <span className="text-fg">mike</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 text-[10px] text-success">
              <Check size={10} /> 7 checks passing
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] text-success">
              <Check size={10} /> mergeable
            </span>
          </div>
          <button className="mt-1 px-2 py-1 text-[10px] font-semibold rounded bg-surface hover:bg-surface-hover text-fg-bright transition-colors w-fit">
            Merge locally
          </button>
        </div>
      </RightPanelSection>

      <RightPanelSection title="Branch Commits">
        <div className="px-2 py-1 flex flex-col">
          {[
            { sha: 'a1b2c3d', msg: 'Fix typo in welcome copy' },
            { sha: 'b2c3d4e', msg: 'Add onboarding slide deck' },
            { sha: 'c3d4e5f', msg: 'Wire up onboarding router' },
            { sha: 'd4e5f6a', msg: 'Init feat/onboarding branch' }
          ].map((c) => (
            <div
              key={c.sha}
              className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] text-muted hover:bg-panel-raised/40 rounded"
            >
              <GitCommit size={10} className="text-dim shrink-0" />
              <span className="font-mono text-faint text-[10px] shrink-0">{c.sha}</span>
              <span className="text-fg truncate">{c.msg}</span>
            </div>
          ))}
        </div>
      </RightPanelSection>

      <RightPanelSection title="Changed Files" collapsed={false} grow>
        <div className="px-2 py-1 flex flex-col overflow-y-auto">
          {[
            { name: 'src/welcome.tsx', kind: 'A', add: 142, del: 0 },
            { name: 'src/auth/signup.ts', kind: 'M', add: 56, del: 12 },
            { name: 'src/auth/login.ts', kind: 'M', add: 24, del: 8 },
            { name: 'src/router.ts', kind: 'M', add: 4, del: 2 },
            { name: 'src/onboarding/steps.ts', kind: 'A', add: 88, del: 0 },
            { name: 'src/onboarding/index.ts', kind: 'A', add: 14, del: 0 },
            { name: 'tests/onboarding.spec.ts', kind: 'A', add: 62, del: 0 }
          ].map((f) => (
            <div
              key={f.name}
              className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] rounded text-muted hover:bg-panel-raised/40"
            >
              <span
                className={`font-mono text-[10px] w-3 text-center ${
                  f.kind === 'A' ? 'text-success' : 'text-warning'
                }`}
              >
                {f.kind}
              </span>
              <span className="flex-1 truncate">{f.name}</span>
              <span className="text-[10px] font-mono leading-none">
                <span className="text-success">+{f.add}</span>
                {f.del > 0 && <span className="text-danger ml-0.5">−{f.del}</span>}
              </span>
            </div>
          ))}
        </div>
      </RightPanelSection>

      <MockAllFilesPanel />

      <RightPanelSection title="Cost" collapsed />

      <div className="truncate px-3 py-1 text-[10px] text-dim shrink-0">{active.path}</div>
    </div>
  )
}

type TreeEntry =
  | { kind: 'dir'; name: string; open: boolean; depth: number }
  | { kind: 'file'; name: string; depth: number }

const ALL_FILES_TREE: TreeEntry[] = [
  { kind: 'dir', name: 'src', open: true, depth: 0 },
  { kind: 'dir', name: 'auth', open: true, depth: 1 },
  { kind: 'file', name: 'login.ts', depth: 2 },
  { kind: 'file', name: 'signup.ts', depth: 2 },
  { kind: 'dir', name: 'onboarding', open: false, depth: 1 },
  { kind: 'file', name: 'router.ts', depth: 1 },
  { kind: 'file', name: 'welcome.tsx', depth: 1 },
  { kind: 'dir', name: 'tests', open: false, depth: 0 },
  { kind: 'file', name: 'package.json', depth: 0 },
  { kind: 'file', name: 'tsconfig.json', depth: 0 },
  { kind: 'file', name: 'README.md', depth: 0 }
]

function MockAllFilesPanel() {
  return (
    <div className="flex flex-col flex-1 min-h-0 border-b border-border">
      <div className="flex items-center gap-1.5 h-9 px-3 border-b border-border shrink-0">
        <ChevronDown size={12} className="text-faint" />
        <span className="text-[10px] font-medium text-muted uppercase tracking-wider">
          All Files
        </span>
        <RefreshCw size={11} className="ml-auto text-faint" />
      </div>

      <div className="shrink-0 p-2 border-b border-border">
        <div className="w-full bg-panel-raised border border-border rounded px-2 py-1 text-[11px] text-faint">
          Filter files...
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto text-[11px] py-1">
        {ALL_FILES_TREE.map((entry, i) =>
          entry.kind === 'dir' ? (
            <MockDirRow key={i} name={entry.name} depth={entry.depth} open={entry.open} />
          ) : (
            <MockFileRow key={i} name={entry.name} depth={entry.depth} />
          )
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-border text-[10px] text-faint shrink-0 flex items-center justify-between">
        <span>48 files</span>
        <span className="font-mono">⌘P fuzzy open</span>
      </div>
    </div>
  )
}

function MockDirRow({
  name,
  depth,
  open
}: {
  name: string
  depth: number
  open: boolean
}) {
  return (
    <div
      className="flex items-center gap-1 px-2 py-0.5 hover:bg-panel-raised cursor-pointer select-none"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <ChevronRight
        size={10}
        className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
      />
      {open ? (
        <FolderOpen size={11} className="shrink-0 text-info" />
      ) : (
        <Folder size={11} className="shrink-0 text-info" />
      )}
      <span className="truncate text-fg">{name}</span>
    </div>
  )
}

function MockFileRow({ name, depth }: { name: string; depth: number }) {
  return (
    <div
      className="flex items-center gap-1 px-2 py-0.5 hover:bg-panel-raised cursor-pointer"
      style={{ paddingLeft: 8 + depth * 12 + 10 }}
    >
      <FileText size={11} className="shrink-0 text-faint" />
      <span className="truncate text-fg">{name}</span>
    </div>
  )
}

function RightPanelSection({
  title,
  children,
  collapsed = false,
  grow = false
}: {
  title: string
  children?: ReactNode
  collapsed?: boolean
  grow?: boolean
}) {
  return (
    <div
      className={`flex flex-col border-b border-border ${grow && !collapsed ? 'flex-1 min-h-0' : 'shrink-0'}`}
    >
      <div
        className={`flex items-center gap-1.5 h-9 px-3 ${collapsed ? '' : 'border-b border-border'}`}
      >
        {collapsed ? (
          <ChevronRight size={12} className="text-faint" />
        ) : (
          <ChevronDown size={12} className="text-faint" />
        )}
        <span className="text-[10px] font-medium text-muted uppercase tracking-wider">
          {title}
        </span>
      </div>
      {!collapsed && children}
    </div>
  )
}

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
