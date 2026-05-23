import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { JsonModeChat } from './JsonModeChat'
import { useJsonClaudeSession } from '../store'
import { useBackend } from '../backend'

interface SurpriseMeThemeModalProps {
  isOpen: boolean
  onClose: () => void
  themesDir: string
  exampleJson: string
}

function buildInitialPrompt(exampleJson: string): string {
  return [
    'Generate an interesting and pleasant theme. Light themes use light backgrounds and dark text. Dark themes use dark backgrounds and light text. Pick light or dark, choose colors that fit and give your theme a funny name. Here\'s an example theme file:',
    '',
    '```json',
    exampleJson.trimEnd(),
    '```',
    '',
    'Write the theme to `<name>.json` in the current working directory (this is the Harness themes folder). The `name` field is the human-readable label; the filename should be lowercased with non-alphanumeric characters replaced by dashes. Include all the same color keys as the example so the theme renders fully. Have fun with it.'
  ].join('\n')
}

export function SurpriseMeThemeModal({
  isOpen,
  onClose,
  themesDir,
  exampleJson
}: SurpriseMeThemeModalProps): JSX.Element | null {
  const backend = useBackend()
  const [sessionId] = useState(() => crypto.randomUUID())
  const session = useJsonClaudeSession(sessionId)
  const sentInitialRef = useRef(false)
  const sawBusyRef = useRef(false)
  const reloadedRef = useRef(false)

  useEffect(() => {
    if (!isOpen) return
    if (sentInitialRef.current) return
    if (!session) return
    sentInitialRef.current = true
    backend.sendJsonClaudeMessage(sessionId, buildInitialPrompt(exampleJson), [])
  }, [isOpen, session, sessionId, exampleJson, backend])

  useEffect(() => {
    if (!session) return
    if (session.busy) {
      sawBusyRef.current = true
      return
    }
    if (sawBusyRef.current && !reloadedRef.current) {
      reloadedRef.current = true
      void backend.reloadCustomThemes()
    }
  }, [session, backend])

  const handleClose = useCallback((): void => {
    void backend.killJsonClaude(sessionId)
    onClose()
  }, [backend, sessionId, onClose])

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, handleClose])

  if (!isOpen) return null

  return (
    <div
      className="fixed bottom-6 right-6 z-[60] w-96 h-[500px] bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles size={14} className="text-accent shrink-0" />
          <h2 className="text-sm font-semibold text-fg-bright truncate">Surprise me</h2>
        </div>
        <button
          onClick={handleClose}
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md border border-border text-fg-bright bg-panel-raised hover:bg-surface-hover transition-colors cursor-pointer"
          aria-label="Close"
          title="Close (ESC)"
        >
          <X size={16} strokeWidth={2.5} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <JsonModeChat sessionId={sessionId} worktreePath={themesDir} mode="awake" />
      </div>
    </div>
  )
}
