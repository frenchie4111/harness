import { useCallback, useEffect, useRef, useState } from 'react'
import { AtSign, Code2, Save } from 'lucide-react'
import type { FileReadResult } from '../types'
import { Tooltip } from './Tooltip'
import { MonacoEditor } from './MonacoEditor'
import { useSettings } from '../store'

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
  const settings = useSettings()
  const [result, setResult] = useState<FileReadResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [value, setValue] = useState('')
  const [savedValue, setSavedValue] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)

  const valueRef = useRef(value)
  const savedRef = useRef(savedValue)
  valueRef.current = value
  savedRef.current = savedValue

  const dirty = value !== savedValue

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setResult(null)
    setValue('')
    setSavedValue('')
    setSaveError(null)
    if (!filePath) {
      setLoading(false)
      return
    }
    window.api.readWorktreeFile(worktreePath, filePath).then((r) => {
      if (cancelled) return
      setResult(r)
      const content = r.content ?? ''
      setValue(content)
      setSavedValue(content)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [worktreePath, filePath])

  const save = useCallback(async () => {
    if (!filePath) return
    const current = valueRef.current
    if (current === savedRef.current) return
    setSaveError(null)
    const r = await window.api.writeWorktreeFile(worktreePath, filePath, current)
    if (r.ok) {
      setSavedValue(current)
    } else {
      setSaveError(r.error || 'Save failed')
    }
  }, [worktreePath, filePath])

  // Warn if the tab is about to be closed/unmounted with unsaved changes.
  // beforeunload covers window-level close; the component-unmount case is
  // handled with a confirm() on the last-render cleanup.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): void => {
      if (valueRef.current !== savedRef.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

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

  return (
    <div className="h-full flex flex-col bg-app">
      <div className="shrink-0 flex items-center gap-3 border-b border-border bg-panel px-4 py-2 text-xs">
        <span
          className="font-mono text-fg truncate flex-1 min-w-0"
          style={{ direction: 'rtl', textAlign: 'left' }}
          title={filePath}
        >
          <bdi>{filePath}</bdi>
          {dirty && <span className="text-warning ml-1">●</span>}
        </span>
        {saveError && (
          <span className="shrink-0 text-danger truncate max-w-[40%]" title={saveError}>
            {saveError}
          </span>
        )}
        <span className="text-faint shrink-0">{formatBytes(result.size)}</span>
        {result.truncated && <span className="shrink-0 text-warning">truncated</span>}
        <Tooltip label={dirty ? 'Save (⌘S)' : 'Saved'}>
          <button
            onClick={save}
            disabled={!dirty || result.binary}
            className="shrink-0 text-faint hover:text-fg disabled:opacity-40 disabled:hover:text-faint cursor-pointer disabled:cursor-default"
          >
            <Save size={12} />
          </button>
        </Tooltip>
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
      <div className="flex-1 min-h-0">
        {result.binary ? (
          <div className="p-4 text-faint text-sm">Binary file — not shown.</div>
        ) : result.truncated ? (
          <div className="h-full flex items-center justify-center text-faint text-sm px-4 text-center">
            File is larger than 2 MB — editing disabled. Open in your external editor.
          </div>
        ) : (
          <MonacoEditor
            value={value}
            filePath={filePath}
            readOnly={false}
            fontFamily={settings.terminalFontFamily || undefined}
            fontSize={settings.terminalFontSize}
            onChange={setValue}
            onSave={save}
            onReferenceLine={
              onSendToClaude
                ? (ln) => onSendToClaude(`@${filePath}:${ln} `)
                : undefined
            }
          />
        )}
      </div>
    </div>
  )
}
