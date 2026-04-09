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
  open: 'text-green-400',
  draft: 'text-neutral-400',
  merged: 'text-purple-400',
  closed: 'text-red-400'
}

const CHECK_ICONS: Record<CheckStatus['state'], { symbol: string; color: string }> = {
  success: { symbol: '\u2713', color: 'text-green-400' },
  failure: { symbol: '\u2717', color: 'text-red-400' },
  error: { symbol: '!', color: 'text-red-400' },
  pending: { symbol: '\u25CB', color: 'text-amber-400' },
  neutral: { symbol: '-', color: 'text-neutral-500' },
  skipped: { symbol: '-', color: 'text-neutral-500' }
}

const OVERALL_COLORS: Record<string, string> = {
  success: 'text-green-400',
  failure: 'text-red-400',
  pending: 'text-amber-400',
  none: 'text-neutral-500'
}

export function PRStatusPanel({ pr }: PRStatusPanelProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border-b border-neutral-800">
      <div className="px-3 py-2 flex items-center gap-2">
        <span className="text-xs font-medium text-neutral-500 flex-1">PULL REQUEST</span>
      </div>

      {pr === null && (
        <div className="px-3 pb-2 text-xs text-neutral-600">No PR for this branch</div>
      )}

      {pr === undefined && (
        <div className="px-3 pb-2 text-xs text-neutral-600">Loading...</div>
      )}

      {pr && (
        <div className="px-3 pb-2">
          {/* PR title and state */}
          <div className="flex items-start gap-1.5 mb-1.5">
            <span className={`text-xs font-medium shrink-0 ${STATE_COLORS[pr.state]}`}>
              {STATE_LABELS[pr.state]}
            </span>
            <a
              className="text-xs text-neutral-300 hover:text-neutral-100 truncate cursor-pointer"
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
              <span className="text-xs text-neutral-600">
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
                    <span className="text-neutral-400 truncate" title={check.description || check.name}>
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
