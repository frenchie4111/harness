import { X, Sparkles, Zap, PartyPopper } from 'lucide-react'
import type { QuestStep } from '../types'
import { HotkeyBadge } from './HotkeyBadge'

interface QuestCardProps {
  step: QuestStep
  onDismiss: () => void
  onFinish: () => void
}

export function QuestCard({ step, onDismiss, onFinish }: QuestCardProps): JSX.Element | null {
  if (step === 'hidden' || step === 'done') return null

  const content = (() => {
    if (step === 'spawn-second') {
      return {
        icon: <Zap size={16} className="text-accent" />,
        eyebrow: 'Step 1 of 2',
        title: 'One agent running. Don\u2019t wait \u2014 spawn another.',
        body: 'The whole point of Harness is that you don\u2019t have to sit and watch. While this one works, fork a second worktree and give it a different task.',
        hint: (
          <>
            Hit <HotkeyBadge action="newWorktree" /> or use the sidebar to create another.
          </>
        )
      }
    }
    if (step === 'switch-between') {
      return {
        icon: <Sparkles size={16} className="text-accent" />,
        eyebrow: 'Step 2 of 2',
        title: 'Two agents in flight. Now learn to juggle.',
        body: 'Jump between running agents with number hotkeys so you can keep an eye on both without losing your place.',
        hint: (
          <>
            <HotkeyBadge action="worktree1" /> for the first,{' '}
            <HotkeyBadge action="worktree2" /> for the second. Try both.
          </>
        )
      }
    }
    // finale
    return {
      icon: <PartyPopper size={16} className="text-accent" />,
      eyebrow: 'Harnessed up',
      title: 'You just ran two agents in parallel.',
      body: 'Do it with ten next time. Harness is happiest when it has a lot to juggle \u2014 the status dots keep you honest so nothing slips.',
      hint: null
    }
  })()

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] pointer-events-none">
      <div className="quest-card-enter pointer-events-auto relative bg-panel-raised border border-border-strong rounded-2xl shadow-2xl overflow-hidden">
        <div className="brand-gradient-bg h-1" />
        <div className="p-5">
          <div className="flex items-start justify-between mb-2">
            <div className="flex items-center gap-2">
              {content.icon}
              <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">
                {content.eyebrow}
              </span>
            </div>
            <button
              onClick={onDismiss}
              title="Dismiss quest"
              className="text-faint hover:text-fg p-0.5 rounded transition-colors cursor-pointer -mt-1 -mr-1"
            >
              <X size={14} />
            </button>
          </div>
          <div className="text-[15px] font-semibold text-fg-bright leading-snug mb-2">
            {content.title}
          </div>
          <div className="text-xs text-muted leading-relaxed">{content.body}</div>
          {content.hint && (
            <div className="mt-3 text-xs text-dim">{content.hint}</div>
          )}
          {step === 'finale' && (
            <button
              onClick={onFinish}
              className="mt-4 w-full brand-gradient-bg text-white font-semibold text-sm px-4 py-2 rounded-lg hover:brightness-110 transition-all cursor-pointer"
            >
              Let's go ⚡
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
