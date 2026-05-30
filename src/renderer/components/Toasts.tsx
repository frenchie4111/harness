import { useToasts } from '../toast'
import { PREVENT_SLEEP_META, type PreventSleepStep } from '../prevent-sleep'
import { PreventSleepGlyph } from './prevent-sleep-icons'

/** Resolve a toast's opaque `icon` key to a glyph. Currently only the
 *  prevent-sleep step keys are recognized; anything else renders text-only. */
function ToastGlyph({ icon }: { icon: string }): JSX.Element | null {
  const meta = PREVENT_SLEEP_META[icon as PreventSleepStep]
  if (meta?.icon) return <PreventSleepGlyph icon={meta.icon} className="icon-sm shrink-0" />
  return null
}

/** Bottom-center stack of transient notifications. Driven by `showToast`. */
export function Toasts(): JSX.Element | null {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-50 flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-2 rounded-md border border-border-strong bg-panel-raised px-3 py-2 text-sm text-fg-bright shadow-lg"
        >
          {t.icon && <ToastGlyph icon={t.icon} />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  )
}
