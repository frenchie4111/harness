import { useRef, useState, useEffect } from 'react'
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from 'framer-motion'
import {
  MockHarness,
  type MockHarnessState,
  type MockStatus
} from './MockHarness'

type SectionIndex = 0 | 1 | 2
type Phase = { section: SectionIndex; localProgress: number }

const BASE_WORKTREES: { id: string; name: string; repo: string }[] = [
  { id: '1', name: 'feat/onboarding', repo: 'harness' },
  { id: '2', name: 'fix/login-flash', repo: 'harness' },
  { id: '3', name: 'refactor/auth', repo: 'harness' },
  { id: '4', name: 'chore/deps-bump', repo: 'harness' },
  { id: '5', name: 'docs/api-reference', repo: 'harness' }
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
  )
}

function CopyStack({ activeSection }: { activeSection: SectionIndex }) {
  return (
    <div className="relative h-[68vh] flex items-center">
      <div className="relative w-full">
        {SECTIONS.map((s, i) => (
          <motion.div
            key={i}
            animate={{
              opacity: i === activeSection ? 1 : 0.18,
              y: i === activeSection ? 0 : (i < activeSection ? -12 : 12),
              filter: i === activeSection ? 'blur(0px)' : 'blur(2px)'
            }}
            transition={{ type: 'spring', stiffness: 140, damping: 24 }}
            className={`${i === activeSection ? 'relative' : 'absolute inset-0 pointer-events-none'}`}
            style={{ zIndex: i === activeSection ? 2 : 1 }}
          >
            <div className="text-xs uppercase tracking-[0.2em] text-amber-400/80 font-semibold mb-5">
              {s.eyebrow}
            </div>
            <h2 className="text-4xl lg:text-5xl font-bold tracking-tight mb-6 leading-[1.08]">
              {s.title}
            </h2>
            <p className="text-lg text-ink-400 leading-relaxed max-w-xl">{s.body}</p>
          </motion.div>
        ))}
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
    ['working', 'working', 'working', 'working'],
    ['working', 'idle', 'working', 'working'],
    ['idle', 'working', 'working', 'idle'],
    ['working', 'working', 'idle', 'working'],
    ['idle', 'working', 'working', 'working']
  ]
  const phase = Math.min(3, Math.floor(progress * 4))
  return rotations[i]?.[phase] ?? 'working'
}

function sectionTwoState(progress: number): MockHarnessState {
  const worktrees = BASE_WORKTREES.map((w, i) => {
    let status: MockStatus = sectionOneStatusFor(i, 0.8)
    if (i === 1) status = progress > 0.2 ? 'needs-attention' : 'working'
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
    status: i === 1 ? ('needs-attention' as MockStatus) : sectionOneStatusFor(i, 0.8)
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
    status: i === 1 ? ('needs-attention' as MockStatus) : ('working' as MockStatus)
  }))
  return {
    activeWorktreeId: '1',
    worktrees,
    highlightedElement: 'new-worktree-button',
    panelMode: 'new-worktree-flow'
  }
}
