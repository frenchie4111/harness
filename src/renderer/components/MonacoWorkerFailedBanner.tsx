import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

export function MonacoWorkerFailedBanner(): JSX.Element | null {
  const [failed, setFailed] = useState<string[]>([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ label: string }>).detail
      if (!detail?.label) return
      setFailed((prev) => (prev.includes(detail.label) ? prev : [...prev, detail.label]))
    }
    window.addEventListener('monaco:worker-failed', handler)
    return () => window.removeEventListener('monaco:worker-failed', handler)
  }, [])

  if (failed.length === 0 || dismissed) return null

  return (
    <div className="bg-warning/15 border-b border-warning/40 text-warning px-3 py-1.5 text-xs flex items-center gap-3 drag-region shrink-0">
      <AlertTriangle size={12} className="shrink-0" />
      <span className="flex-1">
        Diff highlighting and syntax tools are temporarily unavailable (Monaco workers failed to
        load: {failed.join(', ')}). Reload this window to restore.
      </span>
      <button
        onClick={() => window.location.reload()}
        className="px-2 py-0.5 rounded bg-warning/30 hover:bg-warning/50 text-warning transition-colors cursor-pointer no-drag"
      >
        Reload window
      </button>
      <button
        onClick={() => setDismissed(true)}
        title="Hide this banner (problem will persist until reload)"
        className="text-warning/70 hover:text-warning cursor-pointer no-drag"
      >
        <X size={12} />
      </button>
    </div>
  )
}
