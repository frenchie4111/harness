import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw, Copy, Check, RefreshCw, MessageSquare } from 'lucide-react'
import { openReportIssueFor } from './ReportIssueScreen'

interface FallbackRenderProps {
  error: Error
  info: ErrorInfo | null
  reset: () => void
}

interface Props {
  children: ReactNode
  fallback?: (props: FallbackRenderProps) => ReactNode
  onReset?: () => void
  label?: string
  showReload?: boolean
}

interface State {
  error: Error | null
  info: ErrorInfo | null
  copied: boolean
  expanded: boolean
}

function formatErrorDetails(label: string | undefined, error: Error, info: ErrorInfo | null): string {
  const parts = [
    `Label: ${label ?? '(unlabeled)'}`,
    `Name: ${error.name}`,
    `Message: ${error.message}`,
    '',
    'Stack:',
    error.stack ?? '(no stack)'
  ]
  if (info?.componentStack) {
    parts.push('', 'Component stack:', info.componentStack.trim())
  }
  return parts.join('\n')
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, copied: false, expanded: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info })
    const label = this.props.label ?? 'renderer'
    const logError = window.api?.logError
    if (typeof logError === 'function') {
      try {
        logError(label, error, info)
      } catch {
        console.error(`[ErrorBoundary:${label}]`, error, info)
      }
    } else {
      console.error(`[ErrorBoundary:${label}]`, error, info)
    }
  }

  handleReset = (): void => {
    this.setState({ error: null, info: null, copied: false, expanded: false })
    this.props.onReset?.()
  }

  handleCopy = async (): Promise<void> => {
    const { error, info } = this.state
    if (!error) return
    const text = formatErrorDetails(this.props.label, error, info)
    try {
      await navigator.clipboard.writeText(text)
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 1500)
    } catch {
      // clipboard may fail if not focused — silently ignore
    }
  }

  handleReload = (): void => {
    location.reload()
  }

  handleReport = (): void => {
    const { error, info } = this.state
    if (!error) return
    openReportIssueFor(error, { componentStack: info?.componentStack ?? '' })
  }

  toggleExpanded = (): void => {
    this.setState((s) => ({ expanded: !s.expanded }))
  }

  render(): ReactNode {
    const { error, info, copied, expanded } = this.state
    if (!error) return this.props.children

    if (this.props.fallback) {
      return this.props.fallback({ error, info, reset: this.handleReset })
    }

    return (
      <div className="h-full w-full overflow-auto p-4 bg-app">
        <div className="max-w-3xl mx-auto rounded-lg border border-danger/40 bg-danger/10 text-fg">
          <div className="px-4 py-3 border-b border-danger/30 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-fg-bright">
                {error.name}: {error.message || '(no message)'}
              </div>
              {this.props.label && (
                <div className="text-xs text-dim mt-0.5 font-mono">{this.props.label}</div>
              )}
            </div>
          </div>
          <div className="px-4 py-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={this.handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-panel border border-border text-fg-bright hover:border-border-strong transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Try again
            </button>
            {this.props.showReload && (
              <button
                type="button"
                onClick={this.handleReload}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-panel border border-border text-fg-bright hover:border-border-strong transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reload app
              </button>
            )}
            <button
              type="button"
              onClick={this.handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-panel border border-border text-fg-bright hover:border-border-strong transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy error details'}
            </button>
            <button
              type="button"
              onClick={this.handleReport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-panel border border-border text-fg-bright hover:border-border-strong transition-colors cursor-pointer"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              Report error
            </button>
            <button
              type="button"
              onClick={this.toggleExpanded}
              className="ml-auto text-xs text-dim hover:text-fg transition-colors cursor-pointer"
            >
              {expanded ? 'Hide stack trace' : 'Show stack trace'}
            </button>
          </div>
          {expanded && (
            <div className="px-4 pb-4 space-y-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-dim mb-1">Stack</div>
                <pre className="text-[11px] font-mono bg-app/60 border border-border rounded p-2 overflow-auto max-h-64 whitespace-pre">
                  {error.stack ?? '(no stack)'}
                </pre>
              </div>
              {info?.componentStack && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-dim mb-1">Component stack</div>
                  <pre className="text-[11px] font-mono bg-app/60 border border-border rounded p-2 overflow-auto max-h-64 whitespace-pre">
                    {info.componentStack.trim()}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }
}
