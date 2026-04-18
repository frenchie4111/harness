import { useEffect, useMemo, useRef, useState } from 'react'
import { Bug, Lightbulb, ExternalLink } from 'lucide-react'
import { HARNESS_NEW_ISSUE_URL } from '../../shared/constants'

export type IssueKind = 'bug' | 'feature'

export interface ReportIssueContext {
  error?: string
  stack?: string
  componentStack?: string
}

interface ReportIssueModalProps {
  open: boolean
  onClose: () => void
  initialKind?: IssueKind
  initialTitle?: string
  initialBody?: string
  prefilledContext?: ReportIssueContext
}

// GitHub URLs accept a lot, but practical browser/server limits sit around
// 8 KB. Leave headroom for the query-string scaffolding and UTF-8 expansion.
const URL_LENGTH_TARGET = 7500

function buildCrashTemplate(ctx: ReportIssueContext): string {
  const lines = ['## What happened', '', '## Error', ctx.error ?? '(no message)']
  if (ctx.stack) {
    lines.push('', '## Stack', '```', ctx.stack, '```')
  }
  if (ctx.componentStack) {
    lines.push('', '## Component stack', '```', ctx.componentStack.trim(), '```')
  }
  return lines.join('\n')
}

function buildBody(params: {
  description: string
  includeLog: boolean
  log: string
  version: string
  logLineCount: number
}): string {
  const { description, includeLog, log, version, logLineCount } = params
  const sections = [description.trim()]
  if (includeLog && log) {
    sections.push(
      [
        `<details><summary>App log (last ${logLineCount} lines)</summary>`,
        '',
        '```',
        log,
        '```',
        '',
        '</details>'
      ].join('\n')
    )
  }
  sections.push(`---\nHarness v${version} on ${navigator.platform || 'macOS'}`)
  return sections.join('\n\n')
}

function buildUrl(title: string, body: string): string {
  const qs = new URLSearchParams({ title, body }).toString()
  return `${HARNESS_NEW_ISSUE_URL}?${qs}`
}

function truncateLog(log: string, approxBudget: number): string {
  if (log.length <= approxBudget) return log
  const sliced = log.slice(log.length - approxBudget)
  const firstNewline = sliced.indexOf('\n')
  const clean = firstNewline >= 0 ? sliced.slice(firstNewline + 1) : sliced
  return `... log truncated, run \`npm run log\` to see the full log\n${clean}`
}

const REPORT_ISSUE_EVENT = 'harness:open-report-issue'

export interface OpenReportIssueDetail {
  kind?: IssueKind
  title?: string
  body?: string
  context?: ReportIssueContext
}

/**
 * Helper for error boundaries: call this with the caught error + componentStack
 * to open the report modal with a crash template prefilled. The mounted App
 * subscribes via `onOpenReportIssue` and flips the modal open. Intended to be
 * called from the ErrorBoundary fallback UI (see error-boundaries worktree).
 */
export function openReportIssue(detail: OpenReportIssueDetail = {}): void {
  window.dispatchEvent(new CustomEvent(REPORT_ISSUE_EVENT, { detail }))
}

export function openReportIssueFor(
  error: Error,
  info: { componentStack: string }
): void {
  openReportIssue({
    kind: 'bug',
    title: error.message?.slice(0, 120) ?? 'Unhandled error',
    context: {
      error: error.message,
      stack: error.stack,
      componentStack: info.componentStack
    }
  })
}

export function onOpenReportIssue(
  handler: (detail: OpenReportIssueDetail) => void
): () => void {
  const listener = (e: Event): void => {
    handler(((e as CustomEvent).detail ?? {}) as OpenReportIssueDetail)
  }
  window.addEventListener(REPORT_ISSUE_EVENT, listener)
  return () => window.removeEventListener(REPORT_ISSUE_EVENT, listener)
}

export function ReportIssueModal({
  open,
  onClose,
  initialKind = 'bug',
  initialTitle = '',
  initialBody = '',
  prefilledContext
}: ReportIssueModalProps): JSX.Element | null {
  const [kind, setKind] = useState<IssueKind>(initialKind)
  const [title, setTitle] = useState(initialTitle)
  const [body, setBody] = useState(
    initialBody || (prefilledContext ? buildCrashTemplate(prefilledContext) : '')
  )
  const [includeLog, setIncludeLog] = useState(true)
  const [log, setLog] = useState('')
  const [version, setVersion] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setKind(initialKind)
    setTitle(initialTitle)
    setBody(initialBody || (prefilledContext ? buildCrashTemplate(prefilledContext) : ''))
    setIncludeLog(true)
    void window.api.readRecentLog(200).then(setLog).catch(() => setLog(''))
    void window.api.getVersion().then(setVersion).catch(() => setVersion(''))
    const t = setTimeout(() => titleInputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [open, initialKind, initialTitle, initialBody, prefilledContext])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const logLineCount = useMemo(
    () => (log ? log.split('\n').length : 0),
    [log]
  )

  const canSubmit = title.trim().length > 0 && body.trim().length > 0

  if (!open) return null

  const handleSubmit = (): void => {
    if (!canSubmit) return
    const prefix = kind === 'bug' ? '[Bug]' : '[Feature]'
    const finalTitle = `${prefix} ${title.trim()}`

    let finalBody = buildBody({
      description: body,
      includeLog,
      log,
      version,
      logLineCount
    })
    let url = buildUrl(finalTitle, finalBody)

    if (url.length > URL_LENGTH_TARGET && includeLog && log) {
      // Reserve ~1200 chars for everything except the log itself, and shrink
      // the log until the full URL fits under the 7500-char budget.
      const overage = url.length - URL_LENGTH_TARGET
      const newLogBudget = Math.max(500, log.length - overage - 200)
      const truncated = truncateLog(log, newLogBudget)
      finalBody = buildBody({
        description: body,
        includeLog,
        log: truncated,
        version,
        logLineCount
      })
      url = buildUrl(finalTitle, finalBody)
    }

    window.api.openExternal(url)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[8vh] bg-black/30"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-fg-bright">
            {prefilledContext ? 'Report this crash' : 'Report an issue or request a feature'}
          </h2>
          <kbd className="text-[10px] text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">
            ESC
          </kbd>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-faint block mb-1.5">
              Kind
            </label>
            <div className="inline-flex rounded-lg border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setKind('bug')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                  kind === 'bug'
                    ? 'bg-surface text-fg-bright'
                    : 'bg-panel-raised text-muted hover:text-fg-bright'
                }`}
              >
                <Bug size={14} />
                Bug
              </button>
              <button
                type="button"
                onClick={() => setKind('feature')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors cursor-pointer border-l border-border ${
                  kind === 'feature'
                    ? 'bg-surface text-fg-bright'
                    : 'bg-panel-raised text-muted hover:text-fg-bright'
                }`}
              >
                <Lightbulb size={14} />
                Feature request
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="report-issue-title"
              className="text-[10px] font-semibold uppercase tracking-wider text-faint block mb-1.5"
            >
              Title
            </label>
            <input
              ref={titleInputRef}
              id="report-issue-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                kind === 'bug'
                  ? 'Short summary of the problem'
                  : 'Short summary of the requested feature'
              }
              className="w-full bg-panel-raised border border-border rounded-lg px-3 py-2 text-sm text-fg placeholder-faint focus:outline-none focus:border-border-strong"
            />
          </div>

          <div>
            <label
              htmlFor="report-issue-body"
              className="text-[10px] font-semibold uppercase tracking-wider text-faint block mb-1.5"
            >
              Description
            </label>
            <textarea
              id="report-issue-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder={
                kind === 'bug'
                  ? 'What happened? What did you expect? Steps to reproduce?'
                  : 'What would you like Harness to do? What problem would it solve?'
              }
              className="w-full bg-panel-raised border border-border rounded-lg px-3 py-2 text-sm text-fg placeholder-faint font-mono resize-y min-h-[160px] focus:outline-none focus:border-border-strong"
            />
          </div>

          <div className="bg-panel-raised border border-border rounded-lg p-3 space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeLog}
                onChange={(e) => setIncludeLog(e.target.checked)}
                className="mt-0.5 cursor-pointer"
              />
              <div className="flex-1">
                <div className="text-sm text-fg-bright">Include app logs</div>
                <div className="text-xs text-dim mt-0.5">
                  Attaches the last ~{logLineCount || 200} lines of the debug log. Review below
                  before submitting.
                </div>
              </div>
            </label>

            {includeLog && (
              <div className="pt-1">
                <div className="text-[11px] text-muted mb-1.5">
                  Review for sensitive info (paths, branch names) before submitting.
                </div>
                <pre className="bg-bg border border-border rounded-md px-3 py-2 text-[11px] font-mono text-muted max-h-[200px] overflow-auto whitespace-pre">
                  {log || '(no log content yet — interact with the app to generate entries)'}
                </pre>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-muted hover:text-fg-bright transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-info text-white text-sm font-medium hover:bg-info/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ExternalLink size={13} />
            Open on GitHub
          </button>
        </div>
      </div>
    </div>
  )
}
