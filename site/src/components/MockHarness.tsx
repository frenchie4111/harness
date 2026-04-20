import { motion, AnimatePresence } from 'framer-motion'

export type MockStatus = 'idle' | 'working' | 'needs-attention' | 'done'

export interface MockWorktree {
  id: string
  name: string
  repo: string
  status: MockStatus
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

const STATUS_CLASSES: Record<MockStatus, string> = {
  idle: 'bg-ink-600',
  working: 'bg-status-working',
  'needs-attention': 'bg-status-attention',
  done: 'bg-status-done'
}

const STATUS_PULSES: Record<MockStatus, boolean> = {
  idle: false,
  working: true,
  'needs-attention': true,
  done: false
}

export function MockHarness({ state }: { state: MockHarnessState }) {
  return (
    <div className="w-full h-full rounded-2xl overflow-hidden border border-ink-800 shadow-2xl shadow-black/60 bg-ink-950 flex flex-col font-sans">
      <TitleBar />
      <div className="flex-1 flex min-h-0">
        <Sidebar state={state} />
        <MainPanel state={state} />
      </div>
    </div>
  )
}

function TitleBar() {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 bg-ink-900 border-b border-ink-800 flex-shrink-0">
      <div className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
        <span className="w-3 h-3 rounded-full bg-[#28c840]" />
      </div>
      <div className="flex-1 text-center text-[11px] text-ink-500 font-medium">Harness</div>
      <div className="w-12" />
    </div>
  )
}

function Sidebar({ state }: { state: MockHarnessState }) {
  const sidebarGlow = state.highlightedElement === 'sidebar'
  const buttonGlow = state.highlightedElement === 'new-worktree-button'
  return (
    <motion.div
      animate={{
        boxShadow: sidebarGlow
          ? 'inset 0 0 0 1px rgba(245, 158, 11, 0.55), inset 0 0 32px rgba(245, 158, 11, 0.14)'
          : 'inset 0 0 0 0px rgba(245, 158, 11, 0)'
      }}
      transition={{ type: 'spring', stiffness: 200, damping: 30 }}
      className="w-52 border-r border-ink-800 bg-ink-900/70 flex flex-col relative"
    >
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-ink-800">
        <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
          Worktrees
        </div>
        <motion.button
          animate={{
            boxShadow: buttonGlow
              ? '0 0 0 2px rgba(168, 85, 247, 0.55), 0 0 20px rgba(168, 85, 247, 0.45)'
              : '0 0 0 0px rgba(168, 85, 247, 0)',
            scale: buttonGlow ? 1.08 : 1
          }}
          transition={{ type: 'spring', stiffness: 200, damping: 20 }}
          className="w-5 h-5 rounded flex items-center justify-center bg-ink-800 text-ink-300 hover:bg-ink-700"
          aria-label="New worktree"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </motion.button>
      </div>
      <div className="flex-1 overflow-hidden py-1.5">
        <div className="px-2 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-ink-600">
          Active
        </div>
        <div className="flex flex-col">
          {state.worktrees.map((wt) => (
            <WorktreeRow
              key={wt.id}
              worktree={wt}
              active={wt.id === state.activeWorktreeId}
              highlighted={
                state.highlightedElement === 'worktree-row' &&
                wt.id === state.highlightedWorktreeId
              }
            />
          ))}
        </div>
      </div>
    </motion.div>
  )
}

function WorktreeRow({
  worktree,
  active,
  highlighted
}: {
  worktree: MockWorktree
  active: boolean
  highlighted: boolean
}) {
  const pulses = STATUS_PULSES[worktree.status]
  const glowColor = worktree.status === 'needs-attention' ? '239, 68, 68' : '245, 158, 11'
  return (
    <motion.div
      layout
      animate={{
        backgroundColor: active
          ? 'rgba(245, 158, 11, 0.08)'
          : highlighted
            ? `rgba(${glowColor}, 0.08)`
            : 'rgba(0, 0, 0, 0)',
        boxShadow: highlighted
          ? `inset 0 0 0 1px rgba(${glowColor}, 0.6), 0 0 20px rgba(${glowColor}, 0.22)`
          : active
            ? 'inset 2px 0 0 0 rgba(245, 158, 11, 0.9)'
            : 'inset 0 0 0 0px rgba(0,0,0,0)'
      }}
      transition={{ type: 'spring', stiffness: 220, damping: 26 }}
      className="mx-1.5 my-0.5 px-2 py-1.5 rounded-md flex items-center gap-2 relative"
    >
      <motion.span
        layout
        animate={{ backgroundColor: `var(--color-${statusVar(worktree.status)})` }}
        transition={{ duration: 0.3 }}
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_CLASSES[worktree.status]} ${
          pulses ? 'pulse-dot' : ''
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium text-ink-200 truncate leading-tight">
          {worktree.name}
        </div>
        <div className="text-[9px] text-ink-500 font-mono truncate leading-tight">
          {worktree.repo}
        </div>
      </div>
    </motion.div>
  )
}

function statusVar(status: MockStatus): string {
  return (
    {
      idle: 'ink-600',
      working: 'status-working',
      'needs-attention': 'status-attention',
      done: 'status-done'
    } as const
  )[status]
}

function MainPanel({ state }: { state: MockHarnessState }) {
  const terminalGlow = state.highlightedElement === 'terminal'
  return (
    <motion.div
      animate={{
        boxShadow: terminalGlow
          ? 'inset 0 0 0 1px rgba(245, 158, 11, 0.4)'
          : 'inset 0 0 0 0px rgba(245, 158, 11, 0)'
      }}
      transition={{ type: 'spring', stiffness: 200, damping: 30 }}
      className="flex-1 min-w-0 flex flex-col bg-ink-950 relative"
    >
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-ink-800 text-[10px] text-ink-500">
        <div className="flex items-center gap-1.5 px-2 py-1 bg-ink-900 rounded border border-ink-800 text-ink-200">
          <span className="w-1.5 h-1.5 rounded-full bg-status-working pulse-dot" />
          <span className="font-mono">
            {state.worktrees.find((w) => w.id === state.activeWorktreeId)?.name ?? 'claude'}
          </span>
        </div>
        <span className="text-ink-600">·</span>
        <span className="font-mono">claude</span>
      </div>
      <div className="flex-1 min-h-0 relative">
        <AnimatePresence mode="wait" initial={false}>
          {state.panelMode === 'terminal' ? (
            <motion.div
              key="terminal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="absolute inset-0"
            >
              <TerminalView
                showApprovalCard={state.worktrees.some(
                  (w) => w.status === 'needs-attention' && w.id === state.activeWorktreeId
                )}
              />
            </motion.div>
          ) : (
            <motion.div
              key="new-worktree"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="absolute inset-0"
            >
              <NewWorktreeForm />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

function TerminalView({ showApprovalCard }: { showApprovalCard: boolean }) {
  return (
    <div className="h-full font-mono text-[11px] leading-relaxed text-ink-300 p-4 overflow-hidden">
      <div className="text-amber-400">╭──────────────────────────────────────────────╮</div>
      <div className="text-amber-400">│</div>
      <div className="text-amber-400 flex items-center gap-2">
        <span>│</span>
        <span className="text-ink-200">✻ Welcome back</span>
      </div>
      <div className="text-amber-400">│</div>
      <div className="text-amber-400">╰──────────────────────────────────────────────╯</div>
      <div className="h-2" />
      <div className="text-ink-500">
        <span className="text-status-working">›</span> add pagination to the users query
      </div>
      <div className="h-1" />
      <div className="text-ink-400">
        <span className="text-status-working">●</span> Reading <span className="text-ink-200">src/api/users.ts</span>
      </div>
      <div className="text-ink-400">
        <span className="text-status-working">●</span> Reading <span className="text-ink-200">src/api/schema.ts</span>
      </div>
      <div className="text-ink-400">
        <span className="text-status-working">●</span> Writing <span className="text-ink-200">src/api/users.ts</span>
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
            className="border border-status-attention/40 bg-status-attention/5 rounded-md px-3 py-2.5 mt-2"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-status-attention pulse-dot" />
              <span className="text-ink-200 font-semibold text-[10px] uppercase tracking-wider">
                Approval needed
              </span>
            </div>
            <div className="text-ink-300 text-[10px] mb-2">
              Run <span className="text-amber-300">npx prisma migrate deploy</span>?
            </div>
            <div className="flex gap-1.5">
              <span className="px-2 py-0.5 rounded bg-status-working/20 border border-status-working/40 text-status-working text-[9px] font-semibold">
                1. Yes
              </span>
              <span className="px-2 py-0.5 rounded bg-ink-800 border border-ink-700 text-ink-400 text-[9px]">
                2. No
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="h-2" />
      <div className="flex items-center gap-1 text-ink-200">
        <span className="text-ink-500">›</span>
        <span className="w-[6px] h-3 bg-ink-200 caret-blink" />
      </div>
    </div>
  )
}

function NewWorktreeForm() {
  return (
    <div className="h-full p-5 overflow-hidden">
      <div className="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mb-1">
        New worktree
      </div>
      <div className="text-ink-200 text-base font-semibold mb-4">Spin up a new session</div>

      <div className="space-y-3">
        <Field label="Branch name">
          <div className="flex items-center gap-1.5 bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-[12px] font-mono">
            <span className="text-ink-500">feat/</span>
            <span className="text-ink-100">realtime-presence</span>
            <span className="w-[1px] h-3 bg-ink-100 caret-blink ml-0.5" />
          </div>
        </Field>

        <Field label="Base branch">
          <div className="flex items-center justify-between bg-ink-900 border border-ink-700 rounded-md px-2.5 py-1.5 text-[12px] font-mono">
            <span className="text-ink-200">main</span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-ink-500"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </Field>

        <Field label="Initial prompt">
          <div className="bg-ink-900 border border-ink-700 rounded-md px-2.5 py-2 text-[11px] leading-relaxed text-ink-200 min-h-[56px]">
            add a presence indicator to the sidebar showing which teammates are
            currently viewing the same doc
          </div>
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <div className="px-3 py-1.5 rounded-md text-[11px] font-semibold text-ink-400">
            Cancel
          </div>
          <div className="px-3 py-1.5 rounded-md bg-amber-500 text-ink-950 text-[11px] font-semibold">
            Create
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] uppercase tracking-wider text-ink-500 font-semibold">
        {label}
      </label>
      {children}
    </div>
  )
}
