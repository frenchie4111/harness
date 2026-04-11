import { useEffect, useState } from 'react'
import { AtSign, Code2 } from 'lucide-react'
import type { FileReadResult } from '../types'
import { Tooltip } from './Tooltip'

interface FileViewProps {
  worktreePath: string
  filePath?: string
  onSendToClaude?: (text: string) => void
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function FileView({ worktreePath, filePath, onSendToClaude }: FileViewProps): JSX.Element {
  const [result, setResult] = useState<FileReadResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setResult(null)
    if (!filePath) {
      setLoading(false)
      return
    }
    window.api.readWorktreeFile(worktreePath, filePath).then((r) => {
      if (cancelled) return
      setResult(r)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [worktreePath, filePath])

  if (!filePath) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        No file selected
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        Loading file...
      </div>
    )
  }

  if (!result || result.error) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        {result?.error || 'Failed to read file'}
      </div>
    )
  }

  const lines = result.binary || result.content == null ? [] : result.content.split('\n')

  return (
    <div className="h-full flex flex-col bg-app">
      <div className="shrink-0 flex items-center gap-3 border-b border-border bg-panel px-4 py-2 text-xs">
        <span className="font-mono text-fg truncate flex-1 min-w-0">{filePath}</span>
        <span className="text-faint shrink-0">{formatBytes(result.size)}</span>
        {result.truncated && (
          <span className="shrink-0 text-warning">truncated</span>
        )}
        {onSendToClaude && (
          <Tooltip label="Reference file in Claude">
            <button
              onClick={() => onSendToClaude(`@${filePath} `)}
              className="shrink-0 text-faint hover:text-fg cursor-pointer"
            >
              <AtSign size={12} />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Open in external editor">
          <button
            onClick={() => window.api.openInEditor(worktreePath, filePath)}
            className="shrink-0 text-faint hover:text-fg cursor-pointer"
          >
            <Code2 size={12} />
          </button>
        </Tooltip>
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {result.binary ? (
          <div className="p-4 text-faint text-sm">Binary file — not shown.</div>
        ) : (
          <div className="font-mono text-xs leading-5 min-w-fit">
            {lines.map((line, i) => {
              const lineNo = i + 1
              return (
                <div key={i} className="flex group/line hover:bg-panel-raised/30">
                  <span className="shrink-0 w-12 text-right pr-2 select-none text-faint border-r border-border/50">
                    {lineNo}
                  </span>
                  <span className="shrink-0 w-5 flex items-center justify-center">
                    {onSendToClaude && (
                      <Tooltip label="Reference this line in Claude" side="right">
                        <button
                          onClick={() => onSendToClaude(`@${filePath}:${lineNo} `)}
                          className="opacity-0 group-hover/line:opacity-100 text-faint hover:text-fg transition-opacity cursor-pointer"
                        >
                          <AtSign size={10} />
                        </button>
                      </Tooltip>
                    )}
                  </span>
                  <span className="whitespace-pre pr-4 text-muted">{line}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
