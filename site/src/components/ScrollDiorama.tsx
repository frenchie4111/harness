import { useRef, useState, useEffect } from 'react'
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from 'framer-motion'
import {
  MockHarness,
  type MockHarnessState,
  type MockStatus,
  type MockWorktree
} from './MockHarness'

type SectionIndex = 0 | 1 | 2
type Phase = { section: SectionIndex; localProgress: number }

const BASE_WORKTREES: Omit<MockWorktree, 'status'>[] = [
  {
    id: '1',
    branch: 'feat/onboarding',
    path: 'harness/feat-onboarding',
    pr: { checks: 'success', additions: 142, deletions: 58 }
  },
  {
    id: '2',
    branch: 'fix/login-flash',
    path: 'harness/fix-login-flash',
    pr: { checks: 'pending', additions: 27, deletions: 12 }
  },
  {
    id: '3',
    branch: 'refactor/auth',
    path: 'harness/refactor-auth',
    pr: { checks: 'success', additions: 311, deletions: 204 }
  },
  {
    id: '4',
    branch: 'chore/deps-bump',
    path: 'harness/chore-deps-bump',
    pr: { checks: 'failure', additions: 8, deletions: 6 }
  },
  {
    id: '5',
    branch: 'docs/api-reference',
    path: 'harness/docs-api-reference',
    pr: { checks: 'success', additions: 89, deletions: 4 }
  }
]

const SECTIONS = [
  {
    eyebrow: 'Parallel sessions',
    title: 'All your Claude sessions in one place.',
    body: 'Every worktree is its own git branch, its own folder, its own Claude. Kick off five tasks, switch between them in a keystroke, and never worry about two agents fighting over the same file.'
  },
  {
    eyebrow: 'Reliable status',
    title: 'See which Claude needs attention at a glance.',
    body: 'Status dots come from Claude Code hooks — not flaky terminal scraping. The second a session is waiting on approval, the row lights up red and jumps the queue.'
  },
  {
    eyebrow: 'New worktree in a click',
    title: 'Start new work instantly.',
    body: 'Spawn a fresh worktree from the sidebar. Pick a branch, pick a base, paste a prompt — Harness creates the git worktree, runs your setup script, and launches Claude, ready to go.'
  }
] as const

export function ScrollDiorama() {
  const sectionRef = useRef<HTMLElement>(null)
  const prefersReduced = useReducedMotion()

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end end']
  })

  const [phase, setPhase] = useState<Phase>({ section: 0, localProgress: 0 })

  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    const clamped = Math.max(0, Math.min(1, p))
    const section = Math.min(2, Math.floor(clamped * 3)) as SectionIndex
    const localProgress = clamped * 3 - section
    setPhase({ section, localProgress })
  })

  useEffect(() => {
    if (prefersReduced) setPhase({ section: 2, localProgress: 1 })
  }, [prefersReduced])

  const mockState = dioramaStateFor(phase, prefersReduced ?? false)

  return (
    <>
      <section
        id="diorama"
        ref={sectionRef}
        className="relative diorama-bg hidden md:block"
        style={{ height: '300vh' }}
      >
        <div className="sticky top-0 h-screen flex items-center overflow-hidden">
          <div className="w-full grid grid-cols-[minmax(0,42%)_minmax(0,58%)] gap-8 max-w-[1400px] mx-auto">
            <div className="px-8 lg:px-16">
              <CopyStack activeSection={phase.section} />
            </div>

            <div className="relative h-[68vh] translate-x-[8%]">
              <div className="absolute inset-0">
                <MockHarness state={mockState} />
              </div>
            </div>
          </div>

          <ProgressRail section={phase.section} />
        </div>
      </section>

      <StackedDiorama />
    </>
  )
}

/** Mobile fallback: one block per section, each with a static snapshot of
 * the mock above the copy. No scroll hijack, no pinning — just a readable
 * stack that mirrors the desktop narrative. */
function StackedDiorama() {
  return (
    <section className="md:hidden diorama-bg py-12">
      {SECTIONS.map((s, i) => {
        const sectionIdx = i as SectionIndex
        const mockState =
          sectionIdx === 0
            ? sectionOneState(0.8)
            : sectionIdx === 1
              ? sectionTwoState(0.8)
              : sectionThreeState(0.8)
        return (
          <div key={i} className="mx-auto max-w-xl px-5 py-10">
            <div className="text-[11px] uppercase tracking-[0.2em] text-amber-400/80 font-semibold mb-3">
              {s.eyebrow}
            </div>
            <h2 className="text-3xl font-bold tracking-tight mb-3 leading-[1.15]">{s.title}</h2>
            <p className="text-base text-ink-400 leading-relaxed mb-6">{s.body}</p>
            <div className="h-[360px] rounded-xl overflow-hidden">
              <MockHarness state={mockState} />
            </div>
          </div>
        )
      })}
    </section>
  )
}

function CopyStack({ activeSection }: { activeSection: SectionIndex }) {
  return (
    <div className="relative h-[68vh] flex items-center">
      <div className="relative w-full">
        {SECTIONS.map((s, i) => {
          const active = i === activeSection
          return (
            <motion.div
              key={i}
              initial={false}
              animate={{
                opacity: active ? 1 : 0,
                y: active ? 0 : i < activeSection ? -24 : 24
              }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0"
              style={{
                pointerEvents: active ? 'auto' : 'none',
                zIndex: active ? 2 : 1
              }}
            >
              <div className="text-xs uppercase tracking-[0.2em] text-amber-400/80 font-semibold mb-5">
                {s.eyebrow}
              </div>
              <h2 className="text-4xl lg:text-5xl font-bold tracking-tight mb-6 leading-[1.08]">
                {s.title}
              </h2>
              <p className="text-lg text-ink-400 leading-relaxed max-w-xl">{s.body}</p>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

function ProgressRail({ section }: { section: SectionIndex }) {
  return (
    <div className="absolute left-6 top-1/2 -translate-y-1/2 flex flex-col gap-3 hidden lg:flex">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className={`w-1.5 h-8 rounded-full transition-colors ${
            i === section ? 'bg-amber-500' : 'bg-ink-800'
          }`}
        />
      ))}
    </div>
  )
}

function dioramaStateFor(phase: Phase, reduced: boolean): MockHarnessState {
  if (reduced) return finalState()

  const { section, localProgress } = phase

  if (section === 0) return sectionOneState(localProgress)
  if (section === 1) return sectionTwoState(localProgress)
  return sectionThreeState(localProgress)
}

function sectionOneState(progress: number): MockHarnessState {
  const revealCount = Math.min(BASE_WORKTREES.length, Math.floor(progress * 6) + 2)
  const worktrees = BASE_WORKTREES.slice(0, revealCount).map((w, i) => ({
    ...w,
    status: sectionOneStatusFor(i, progress)
  }))
  return {
    activeWorktreeId: '1',
    worktrees,
    highlightedElement: progress > 0.15 ? 'sidebar' : null,
    panelMode: 'terminal'
  }
}

function sectionOneStatusFor(i: number, progress: number): MockStatus {
  const rotations: MockStatus[][] = [
    ['processing', 'processing', 'processing', 'processing'],
    ['processing', 'waiting', 'processing', 'processing'],
    ['idle', 'processing', 'processing', 'idle'],
    ['processing', 'processing', 'idle', 'processing'],
    ['waiting', 'processing', 'processing', 'processing']
  ]
  const phase = Math.min(3, Math.floor(progress * 4))
  return rotations[i]?.[phase] ?? 'processing'
}

function sectionTwoState(progress: number): MockHarnessState {
  const worktrees = BASE_WORKTREES.map((w, i) => {
    let status: MockStatus = sectionOneStatusFor(i, 0.8)
    if (i === 1) status = progress > 0.2 ? 'needs-approval' : 'processing'
    return { ...w, status }
  })
  const highlightRow = progress > 0.35
  return {
    activeWorktreeId: highlightRow ? '2' : '1',
    worktrees,
    highlightedElement: highlightRow ? 'worktree-row' : 'sidebar',
    highlightedWorktreeId: '2',
    panelMode: 'terminal'
  }
}

function sectionThreeState(progress: number): MockHarnessState {
  const worktrees = BASE_WORKTREES.map((w, i) => ({
    ...w,
    status: i === 1 ? ('needs-approval' as MockStatus) : sectionOneStatusFor(i, 0.8)
  }))
  const showForm = progress > 0.5
  return {
    activeWorktreeId: showForm ? 'new' : '1',
    worktrees,
    highlightedElement: 'new-worktree-button',
    panelMode: showForm ? 'new-worktree-flow' : 'terminal'
  }
}

function finalState(): MockHarnessState {
  const worktrees = BASE_WORKTREES.map((w, i) => ({
    ...w,
    status: i === 1 ? ('needs-approval' as MockStatus) : ('processing' as MockStatus)
  }))
  return {
    activeWorktreeId: '1',
    worktrees,
    highlightedElement: 'new-worktree-button',
    panelMode: 'new-worktree-flow'
  }
}
