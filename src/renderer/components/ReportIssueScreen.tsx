import { useEffect, useMemo, useRef, useState } from 'react'
import { Bug, Lightbulb, ExternalLink, X } from 'lucide-react'
import { HARNESS_NEW_ISSUE_URL } from '../../shared/constants'

export type IssueKind = 'bug' | 'feature'

export interface ReportIssueContext {
  error?: string
  stack?: string
  componentStack?: string
}

interface ReportIssueScreenProps {
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

export function openReportIssue(detail: OpenReportIssueDetail = {}): void {
  window.dispatchEvent(new CustomEvent(REPORT_ISSUE_EVENT, { detail }))
}

/**
 * Helper for error boundaries: call with the caught error + componentStack
 * to open the report screen with a crash template prefilled. The App
 * subscribes via `onOpenReportIssue` and flips the screen on.
 */
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

export function ReportIssueScreen({
  onClose,
  initialKind = 'bug',
  initialTitle = '',
  initialBody = '',
  prefilledContext
}: ReportIssueScreenProps): JSX.Element {
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
    void window.api.readRecentLog(200).then(setLog).catch(() => setLog(''))
    void window.api.getVersion().then(setVersion).catch(() => setVersion(''))
    const t = setTimeout(() => titleInputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLInputElement)
      ) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const logLineCount = useMemo(
    () => (log ? log.split('\n').length : 0),
    [log]
  )

  const canSubmit = title.trim().length > 0 && body.trim().length > 0

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
    <div className="flex-1 flex flex-col min-w-0 bg-app">
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-4 top-1/2 -translate-y-1/2 text-dim hover:text-fg p-1.5 rounded transition-colors cursor-pointer"
          title="Close (Esc)"
          type="button"
        >
          <X size={16} />
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          {prefilledContext ? 'Report this crash' : 'Report an issue or request a feature'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-8 space-y-6">
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-dim block mb-2">
              Kind
            </label>
            <div className="inline-flex p-1 bg-panel border border-border-strong rounded-lg">
              <button
                type="button"
                onClick={() => setKind('bug')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  kind === 'bug'
                    ? 'bg-app text-fg-bright shadow-sm'
                    : 'text-dim hover:text-fg'
                }`}
              >
                <Bug size={12} />
                Bug
              </button>
              <button
                type="button"
                onClick={() => setKind('feature')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  kind === 'feature'
                    ? 'bg-app text-fg-bright shadow-sm'
                    : 'text-dim hover:text-fg'
                }`}
              >
                <Lightbulb size={12} />
                Feature request
              </button>
            </div>
          </div>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-dim block mb-2">
              Title
            </div>
            <input
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                kind === 'bug'
                  ? 'Short summary of the problem'
                  : 'Short summary of the requested feature'
              }
              style={{ fontSize: '13px' }}
              className="w-full bg-panel border-2 border-border-strong rounded-lg px-3 py-2.5 text-fg-bright placeholder-faint outline-none focus:border-accent transition-colors"
            />
          </label>

          <label className="block">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-dim block mb-2">
              Description
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              placeholder={
                kind === 'bug'
                  ? 'What happened? What did you expect? Steps to reproduce?'
                  : 'What would you like Harness to do? What problem would it solve?'
              }
              style={{ fontSize: '13px' }}
              className="w-full bg-panel border-2 border-border-strong rounded-lg px-3 py-2.5 font-mono text-fg placeholder-faint outline-none focus:border-accent transition-colors resize-y min-h-[200px]"
            />
          </label>

          <div className="bg-panel border border-border rounded-lg p-4 space-y-3">
            <label className="flex items-start gap-2.5 cursor-pointer">
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
              <div>
                <div className="text-[11px] text-muted mb-1.5">
                  Review for sensitive info (paths, branch names) before submitting.
                </div>
                <pre className="bg-app border border-border rounded-md px-3 py-2 text-[11px] font-mono text-muted max-h-[200px] overflow-auto whitespace-pre">
                  {log || '(no log content yet — interact with the app to generate entries)'}
                </pre>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted hover:text-fg-bright transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-info text-white text-sm font-medium hover:bg-info/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ExternalLink size={13} />
              Open on GitHub
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
