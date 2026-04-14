import { useEffect, useRef } from 'react'

/** Shared animated loader used by the pending-creation and
 * pending-deletion screens. */
export function PendingLoader({ label }: { label: string }): JSX.Element {
  return (
    <div className="claude-loader" aria-label={label}>
      <div className="claude-loader-halo" />
      <div className="claude-loader-pulser">
        <div className="claude-loader-rotator">
          <svg viewBox="0 0 56 56" width="56" height="56">
            <defs>
              <linearGradient id="pendingScreenGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#f59e0b" />
                <stop offset="55%" stopColor="#ef4444" />
                <stop offset="100%" stopColor="#a855f7" />
              </linearGradient>
            </defs>
            <g fill="url(#pendingScreenGrad)" transform="translate(28 28)">
              {[0, 45, 90, 135].map((deg) => (
                <path
                  key={deg}
                  d="M 0 -24 Q 3 0 0 24 Q -3 0 0 -24 Z"
                  transform={`rotate(${deg})`}
                />
              ))}
            </g>
          </svg>
        </div>
      </div>
    </div>
  )
}

/** Shared auto-scrolling log viewer. */
export function ScriptLogViewer({ log }: { log: string }): JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])
  return (
    <pre
      ref={ref}
      className="text-[11px] leading-snug text-muted bg-app border border-border rounded p-3 whitespace-pre-wrap break-words max-h-72 overflow-auto font-mono"
    >
      {log || <span className="text-faint">Waiting for output…</span>}
    </pre>
  )
}
