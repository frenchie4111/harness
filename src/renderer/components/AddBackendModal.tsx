import { useState, useMemo, useCallback } from 'react'
import { X, Loader2, Server } from 'lucide-react'
import {
  parseConnectionUrl,
  suggestLabelFromUrl
} from '../../shared/transport/parse-connection-url'
import { WebSocketClientTransport } from '../../shared/transport/transport-websocket'
import { getBackendsRegistry } from '../store'
import type { BackendConnection } from '../types'

interface AddBackendModalProps {
  isOpen: boolean
  onClose: () => void
}

/** Modal for adding a remote `harness-server` to the chip strip. The
 *  user pastes the link Settings displays on the host machine
 *  (`http://host:port/?token=...`); we parse, validate the connection
 *  by opening a WebSocket and fetching a snapshot, persist via main,
 *  and add the live transport to the renderer's registry as the new
 *  active backend. Per design §B/§I.
 *
 *  The `Test & save` flow keeps the WS transport that was used for
 *  validation — it's the same instance we then register, so the user
 *  doesn't pay a second connect roundtrip on first activation. */
export function AddBackendModal({ isOpen, onClose }: AddBackendModalProps): JSX.Element | null {
  const [urlInput, setUrlInput] = useState('')
  const [labelInput, setLabelInput] = useState('')
  const [labelEdited, setLabelEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parseResult = useMemo(() => {
    if (!urlInput.trim()) return null
    return parseConnectionUrl(urlInput)
  }, [urlInput])

  const suggestedLabel = useMemo(() => {
    if (!parseResult || !parseResult.ok) return ''
    return suggestLabelFromUrl(parseResult.parsed)
  }, [parseResult])

  // Autofill the label from the URL until the user types something
  // explicit. Once they edit, we stop overwriting their input.
  const effectiveLabel = labelEdited ? labelInput : suggestedLabel

  const handleClose = useCallback(() => {
    if (busy) return
    setUrlInput('')
    setLabelInput('')
    setLabelEdited(false)
    setError(null)
    onClose()
  }, [busy, onClose])

  const handleSubmit = useCallback(async () => {
    setError(null)
    if (!parseResult || !parseResult.ok) {
      setError(parseResult ? parseResult.error : 'Paste the connection link from the host.')
      return
    }
    const label = effectiveLabel.trim() || suggestedLabel || 'Backend'
    setBusy(true)
    let ws: WebSocketClientTransport | null = null
    try {
      ws = new WebSocketClientTransport({
        url: parseResult.parsed.wsUrl,
        token: parseResult.parsed.token
      })
      await ws.connect()
      // A successful getStateSnapshot proves auth + protocol parity —
      // anything beyond a couple seconds is almost certainly a bad
      // token or wrong port, so we cap the round-trip with our own
      // timer rather than waiting on the WS layer's reconnect logic.
      const snapshot = await Promise.race<unknown>([
        ws.getStateSnapshot(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timed out waiting for snapshot — wrong port?')), 5000)
        )
      ])
      void snapshot

      // Persist via main. The returned BackendConnection has the new
      // uuid + addedAt and is what we store in the registry.
      const saved: BackendConnection = await window.api.connectionsAdd(
        {
          label,
          url: parseResult.parsed.storedUrl,
          kind: 'remote'
        },
        parseResult.parsed.token
      )

      // Hand the already-connected transport to the registry — no need
      // to re-handshake. Then make the new backend active so the chip
      // strip lights up and subsequent window.api.X calls route here.
      const registry = getBackendsRegistry()
      registry.add(saved, ws)
      registry.setActive(saved.id)
      void window.api.connectionsSetActive(saved.id)
      void window.api.connectionsSetLastConnected(saved.id)
      ws = null  // ownership transferred — don't disconnect on cleanup
      handleClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`Connection failed: ${message}`)
      // Tear the test transport down so we don't leak a dangling socket
      // when the user retries with corrected input.
      try {
        ws?.close()
      } catch {
        // ignore
      }
    } finally {
      setBusy(false)
    }
  }, [parseResult, effectiveLabel, suggestedLabel, handleClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/80 backdrop-blur-sm">
      <div className="bg-panel border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Server size={14} className="text-accent" />
            <h2 className="text-sm font-semibold text-fg-bright">Add backend</h2>
          </div>
          <button
            onClick={handleClose}
            disabled={busy}
            className="text-dim hover:text-fg disabled:opacity-50 transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-xs text-dim leading-relaxed">
            Paste the connection link the host machine shows under{' '}
            <span className="text-fg">Settings → Server</span>, or the URL{' '}
            <code className="bg-app/40 px-1 rounded text-[11px]">harness-server</code>{' '}
            prints on startup.
          </p>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-dim uppercase tracking-wider">
              Connection URL
            </label>
            <textarea
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="http://build-box.local:37291/?token=..."
              rows={2}
              spellCheck={false}
              autoFocus
              disabled={busy}
              className="w-full bg-app/40 border border-border rounded px-2.5 py-1.5 text-xs font-mono text-fg-bright placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-50 resize-none"
            />
            {parseResult && !parseResult.ok && urlInput.trim() && (
              <div className="text-[11px] text-warning">{parseResult.error}</div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-dim uppercase tracking-wider">
              Label (optional)
            </label>
            <input
              value={effectiveLabel}
              onChange={(e) => {
                setLabelInput(e.target.value)
                setLabelEdited(true)
              }}
              placeholder={suggestedLabel || 'Backend'}
              disabled={busy}
              className="w-full bg-app/40 border border-border rounded px-2.5 py-1.5 text-xs text-fg-bright placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-50"
            />
          </div>

          {error && (
            <div className="text-[11px] text-danger bg-danger/10 border border-danger/30 rounded px-2.5 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            onClick={handleClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-dim hover:text-fg disabled:opacity-50 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={busy || !urlInput.trim() || (parseResult ? !parseResult.ok : false)}
            className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors flex items-center gap-2"
          >
            {busy && <Loader2 size={11} className="animate-spin" />}
            {busy ? 'Testing…' : 'Test & save'}
          </button>
        </div>
      </div>
    </div>
  )
}
