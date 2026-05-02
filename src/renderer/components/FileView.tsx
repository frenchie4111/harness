import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AtSign, Code2, Eye, Save } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { FileBinaryReadResult, FileReadResult } from '../types'
import { Tooltip } from './Tooltip'
import { MonacoEditor } from './MonacoEditor'
import { useSettings } from '../store'
import 'highlight.js/styles/github-dark.css'

interface FileViewProps {
  worktreePath: string
  filePath?: string
  onSendToAgent?: (text: string) => void
}

type ViewerMode = 'text' | 'markdown' | 'image' | 'pdf'

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const PDF_EXTS = new Set(['pdf'])

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

function detectViewerMode(filePath: string): ViewerMode {
  const ext = (filePath.split('.').pop() || '').toLowerCase()
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (PDF_EXTS.has(ext)) return 'pdf'
  return 'text'
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return buf
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function FileView({ worktreePath, filePath, onSendToAgent }: FileViewProps): JSX.Element {
  const settings = useSettings()
  const [result, setResult] = useState<FileReadResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [value, setValue] = useState('')
  const [savedValue, setSavedValue] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [markdownAsCode, setMarkdownAsCode] = useState(false)
  const [binary, setBinary] = useState<{ url: string; size: number; mime: string } | null>(null)
  const [binaryError, setBinaryError] = useState<string | null>(null)

  const valueRef = useRef(value)
  const savedRef = useRef(savedValue)
  valueRef.current = value
  savedRef.current = savedValue

  const dirty = value !== savedValue

  const mode: ViewerMode = useMemo(
    () => (filePath ? detectViewerMode(filePath) : 'text'),
    [filePath]
  )
  const needsBinary = mode === 'image' || mode === 'pdf'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setResult(null)
    setValue('')
    setSavedValue('')
    setSaveError(null)
    setBinary(null)
    setBinaryError(null)
    setMarkdownAsCode(false)
    if (!filePath) {
      setLoading(false)
      return
    }
    if (needsBinary) {
      window.api.readWorktreeFileBinary(worktreePath, filePath).then((r: FileBinaryReadResult) => {
        if (cancelled) return
        if (!r.ok) {
          setBinaryError(r.error)
          setLoading(false)
          return
        }
        const blob = new Blob([base64ToArrayBuffer(r.base64)], { type: r.mime })
        const url = URL.createObjectURL(blob)
        setBinary({ url, size: r.size, mime: r.mime })
        setLoading(false)
      })
    } else {
      window.api.readWorktreeFile(worktreePath, filePath).then((r) => {
        if (cancelled) return
        setResult(r)
        const content = r.content ?? ''
        setValue(content)
        setSavedValue(content)
        setLoading(false)
      })
    }
    return () => {
      cancelled = true
    }
  }, [worktreePath, filePath, needsBinary])

  // Revoke the blob URL when the loaded binary changes or the component
  // unmounts — otherwise large image/PDF blobs leak across file switches.
  useEffect(() => {
    if (!binary) return
    return () => {
      URL.revokeObjectURL(binary.url)
    }
  }, [binary])

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

  if (needsBinary) {
    if (binaryError || !binary) {
      return (
        <div className="flex items-center justify-center h-full text-faint text-sm">
          {binaryError || 'Failed to read file'}
        </div>
      )
    }
    return (
      <div className="h-full flex flex-col bg-app">
        <FileHeader
          filePath={filePath}
          dirty={false}
          saveError={null}
          size={binary.size}
          truncated={false}
          worktreePath={worktreePath}
          onSendToAgent={onSendToAgent}
          showSave={false}
          onSave={save}
          toggleControl={null}
        />
        <div className="flex-1 min-h-0">
          {mode === 'image' ? (
            <ImageView url={binary.url} />
          ) : (
            <PdfView url={binary.url} />
          )}
        </div>
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

  const isMarkdown = mode === 'markdown' && !result.binary && !result.truncated
  const showMarkdownRendered = isMarkdown && !markdownAsCode

  const toggleControl =
    isMarkdown && !result.binary && !result.truncated ? (
      <Tooltip label={markdownAsCode ? 'Show rendered' : 'Show source'}>
        <button
          onClick={() => setMarkdownAsCode((v) => !v)}
          className="shrink-0 text-faint hover:text-fg cursor-pointer"
        >
          {markdownAsCode ? <Eye size={12} /> : <Code2 size={12} />}
        </button>
      </Tooltip>
    ) : null

  return (
    <div className="h-full flex flex-col bg-app">
      <FileHeader
        filePath={filePath}
        dirty={dirty}
        saveError={saveError}
        size={result.size}
        truncated={result.truncated}
        worktreePath={worktreePath}
        onSendToAgent={onSendToAgent}
        showSave={true}
        saveDisabled={!dirty || result.binary || showMarkdownRendered}
        onSave={save}
        toggleControl={toggleControl}
      />
      <div className="flex-1 min-h-0">
        {result.binary ? (
          <div className="p-4 text-faint text-sm">Binary file — not shown.</div>
        ) : result.truncated ? (
          <div className="h-full flex items-center justify-center text-faint text-sm px-4 text-center">
            File is larger than 2 MB — editing disabled. Open in your external editor.
          </div>
        ) : showMarkdownRendered ? (
          <div className="h-full overflow-auto">
            <div className="markdown text-fg text-sm max-w-3xl mx-auto px-6 py-6">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
                {value}
              </ReactMarkdown>
            </div>
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
              onSendToAgent
                ? (ln) => onSendToAgent(`@${filePath}:${ln} `)
                : undefined
            }
          />
        )}
      </div>
    </div>
  )
}

interface FileHeaderProps {
  filePath: string
  dirty: boolean
  saveError: string | null
  size: number
  truncated: boolean
  worktreePath: string
  onSendToAgent?: (text: string) => void
  showSave: boolean
  saveDisabled?: boolean
  onSave: () => void
  toggleControl: JSX.Element | null
}

function FileHeader({
  filePath,
  dirty,
  saveError,
  size,
  truncated,
  worktreePath,
  onSendToAgent,
  showSave,
  saveDisabled,
  onSave,
  toggleControl
}: FileHeaderProps): JSX.Element {
  return (
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
      <span className="text-faint shrink-0">{formatBytes(size)}</span>
      {truncated && <span className="shrink-0 text-warning">truncated</span>}
      {toggleControl}
      {showSave && (
        <Tooltip label={dirty ? 'Save (⌘S)' : 'Saved'}>
          <button
            onClick={onSave}
            disabled={saveDisabled}
            className="shrink-0 text-faint hover:text-fg disabled:opacity-40 disabled:hover:text-faint cursor-pointer disabled:cursor-default"
          >
            <Save size={12} />
          </button>
        </Tooltip>
      )}
      {onSendToAgent && (
        <Tooltip label="Reference file in Claude">
          <button
            onClick={() => onSendToAgent(`@${filePath} `)}
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
  )
}

function ImageView({ url }: { url: string }): JSX.Element {
  return (
    <div className="h-full w-full flex items-center justify-center overflow-auto bg-app p-4">
      <img
        src={url}
        alt=""
        className="max-h-full max-w-full object-contain"
        style={{ imageRendering: 'auto' }}
      />
    </div>
  )
}

function PdfView({ url }: { url: string }): JSX.Element {
  return (
    <iframe
      src={url}
      title="PDF"
      className="h-full w-full border-0 bg-app"
    />
  )
}
