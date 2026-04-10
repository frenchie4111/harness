import { useState } from 'react'
import type { PRStatus, CheckStatus } from '../types'

interface PRStatusPanelProps {
  pr: PRStatus | null | undefined
}

const STATE_LABELS: Record<string, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed'
}

const STATE_COLORS: Record<string, string> = {
  open: 'text-success',
  draft: 'text-muted',
  merged: 'text-accent',
  closed: 'text-danger'
}

const CHECK_ICONS: Record<CheckStatus['state'], { symbol: string; color: string }> = {
  success: { symbol: '\u2713', color: 'text-success' },
  failure: { symbol: '\u2717', color: 'text-danger' },
  error: { symbol: '!', color: 'text-danger' },
  pending: { symbol: '\u25CB', color: 'text-warning' },
  neutral: { symbol: '-', color: 'text-dim' },
  skipped: { symbol: '-', color: 'text-dim' }
}

const OVERALL_COLORS: Record<string, string> = {
  success: 'text-success',
  failure: 'text-danger',
  pending: 'text-warning',
  none: 'text-dim'
}

export function PRStatusPanel({ pr }: PRStatusPanelProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border-b border-border">
      <div className="px-3 py-2 flex items-center gap-2">
        <span className="text-xs font-medium text-dim flex-1">PULL REQUEST</span>
      </div>

      {pr === null && (
        <div className="px-3 pb-2 text-xs text-faint">No PR for this branch</div>
      )}

      {pr === undefined && (
        <div className="px-3 pb-2 text-xs text-faint">Loading...</div>
      )}

      {pr && (
        <div className="px-3 pb-2">
          {/* PR title and state */}
          <div className="flex items-start gap-1.5 mb-1.5">
            <span className={`text-xs font-medium shrink-0 ${STATE_COLORS[pr.state]}`}>
              {STATE_LABELS[pr.state]}
            </span>
            <a
              className="text-xs text-fg hover:text-fg-bright truncate cursor-pointer"
              title={`#${pr.number}: ${pr.title}\n${pr.url}`}
              onClick={() => setExpanded(!expanded)}
            >
              #{pr.number} {pr.title}
            </a>
          </div>

          {/* Checks summary */}
          <div
            className={`flex items-center gap-1.5 cursor-pointer ${expanded ? 'mb-1.5' : ''}`}
            onClick={() => setExpanded(!expanded)}
          >
            <span className={`text-xs ${OVERALL_COLORS[pr.checksOverall]}`}>
              {pr.checksOverall === 'success' && 'Checks passing'}
              {pr.checksOverall === 'failure' && 'Checks failing'}
              {pr.checksOverall === 'pending' && 'Checks running'}
              {pr.checksOverall === 'none' && 'No checks'}
            </span>
            {pr.checks.length > 0 && (
              <span className="text-xs text-faint">
                ({pr.checks.filter((c) => c.state === 'success').length}/{pr.checks.length})
                {expanded ? '\u25B4' : '\u25BE'}
              </span>
            )}
          </div>

          {/* Expanded check list */}
          {expanded && pr.checks.length > 0 && (
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {pr.checks.map((check) => {
                const icon = CHECK_ICONS[check.state]
                return (
                  <div key={check.name} className="flex items-center gap-1.5 text-xs">
                    <span className={`shrink-0 ${icon.color}`}>{icon.symbol}</span>
                    <span className="text-muted truncate" title={check.description || check.name}>
                      {check.name}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
