import { useEffect } from 'react'
import type { WorktreeRowAction } from './worktree-row-actions'

interface WorktreeActionSheetProps {
  title: string
  subtitle?: string
  actions: WorktreeRowAction[]
  onClose: () => void
}

const TONE_CLASS: Record<string, string> = {
  accent: 'text-accent',
  warning: 'text-warning',
  danger: 'text-danger'
}

/** Touch replacement for the desktop row's hover-revealed action buttons and
 *  right-click menu. A persistent "…" affordance opening a sheet beats a
 *  long-press: it's discoverable, and it doesn't fight the scroll gesture. */
export function WorktreeActionSheet({
  title,
  subtitle,
  actions,
  onClose
}: WorktreeActionSheetProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative bg-panel border-t border-border-strong rounded-t-xl pb-[env(safe-area-inset-bottom)] max-h-[70%] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3 pb-2 border-b border-border">
          <div className="text-sm font-semibold text-fg-bright truncate">{title}</div>
          {subtitle && <div className="text-xs text-dim truncate mt-0.5">{subtitle}</div>}
        </div>
        {actions.map((action) => {
          const Icon = action.icon
          return (
            <button
              key={action.key}
              onClick={(e) => {
                e.stopPropagation()
                action.onSelect(e)
                onClose()
              }}
              className={`w-full flex items-center gap-3 px-4 min-h-11 py-3 text-left text-sm border-b border-border last:border-b-0 active:bg-surface ${
                action.tone ? TONE_CLASS[action.tone] : 'text-fg-bright'
              }`}
            >
              <Icon className="icon-base shrink-0" />
              <span className="truncate">{action.label}</span>
            </button>
          )
        })}
        <button
          onClick={onClose}
          className="w-full px-4 min-h-11 py-3 text-sm text-dim active:bg-surface"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
