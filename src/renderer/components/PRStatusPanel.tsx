import { useState, useEffect } from 'react'
import { ExternalLink } from 'lucide-react'
import type { PRStatus, CheckStatus } from '../types'
import { Tooltip } from './Tooltip'

/** Pick a one-line failure reason out of a check's GitHub `output.summary`,
 * which is often multi-line markdown. Grab the first non-empty, non-heading
 * line and cap it — good enough to tell "what broke" without the full log. */
function firstLine(summary: string | undefined): string {
  if (!summary) return ''
  for (const raw of summary.split('\n')) {
    const line = raw.trim().replace(/^#+\s*/, '').replace(/^[-*]\s+/, '')
    if (line) return line.length > 140 ? line.slice(0, 140) + '…' : line
  }
  return ''
}

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

  // Auto-expand the check list whenever checks are failing so the user sees
  // which check broke without an extra click.
  useEffect(() => {
    if (pr?.checksOverall === 'failure') setExpanded(true)
  }, [pr?.checksOverall, pr?.number])

  return (
    <div className="border-b border-border">
      <div className="px-3 py-2 flex items-center gap-2">
        <span className="text-xs font-medium text-dim flex-1">PULL REQUEST</span>
        {pr && (
          <Tooltip label="Open PR in browser" action="openPR" side="left">
            <button
              onClick={() => window.api.openExternal(pr.url)}
              className="text-xs text-dim hover:text-fg flex items-center gap-1 transition-colors cursor-pointer"
            >
              Open
              <ExternalLink size={11} />
            </button>
          </Tooltip>
        )}
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

          {/* Merge conflict indicator — styled like the checks line */}
          {pr.hasConflict === true && (
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs text-danger">Merge conflict</span>
            </div>
          )}

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
            <div className="space-y-0.5 max-h-60 overflow-y-auto">
              {pr.checks.map((check) => {
                const icon = CHECK_ICONS[check.state]
                const isFailure = check.state === 'failure' || check.state === 'error'
                const reason = isFailure
                  ? check.description || firstLine(check.summary)
                  : ''
                const clickable = !!check.detailsUrl
                const rowClasses = `flex items-start gap-1.5 text-xs py-0.5 rounded ${
                  clickable ? 'cursor-pointer hover:bg-panel-raised px-1 -mx-1 group' : ''
                }`
                return (
                  <div
                    key={check.name}
                    className={rowClasses}
                    onClick={() => {
                      if (check.detailsUrl) window.api.openExternal(check.detailsUrl)
                    }}
                    title={
                      check.detailsUrl
                        ? `Open: ${check.detailsUrl}`
                        : check.description || check.name
                    }
                  >
                    <span className={`shrink-0 mt-0.5 ${icon.color}`}>{icon.symbol}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span
                          className={`truncate ${isFailure ? 'text-fg' : 'text-muted'}`}
                        >
                          {check.name}
                        </span>
                        {clickable && (
                          <ExternalLink
                            size={10}
                            className="shrink-0 text-faint opacity-0 group-hover:opacity-100 transition-opacity"
                          />
                        )}
                      </div>
                      {reason && (
                        <div className="text-faint text-[11px] leading-snug truncate">
                          {reason}
                        </div>
                      )}
                    </div>
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
