import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { X, Loader2, Server, Globe, Terminal } from 'lucide-react'
import {
  parseConnectionUrl,
  suggestLabelFromUrl
} from '../../shared/transport/parse-connection-url'
import { WebSocketClientTransport } from '../../shared/transport/transport-websocket'
import { getBackendsRegistry, hydrateRemoteBackend } from '../store'
import { useBackend } from '../backend'
import { useSshBootstrap } from '../store'
import type { StateSnapshot } from '../../shared/state'
import type { BackendConnection, ConfiguredHost } from '../types'

interface AddBackendModalProps {
  isOpen: boolean
  onClose: () => void
}

type Tab = 'url' | 'ssh'

/** Modal for adding a remote backend to the chip strip.
 *
 *  Two tabs:
 *  - **URL + token** (the original): paste the link Settings displays
 *    (`http://host:port/?token=...`), validates by opening a WS test
 *    connection, registers the live transport on success.
 *  - **SSH host** (new): pick a Host from `~/.ssh/config` (or type a
 *    freeform `user@host[:port]`), Harness SSHes in, installs
 *    `harness-server` if missing, starts it detached, opens a local
 *    port forward, and persists the BackendConnection. Progress is
 *    streamed live via the sshBootstrap slice.
 *
 *  Both end at the same place: a new entry in the chip strip, ready
 *  to drive worktrees + terminals. */
export function AddBackendModal({ isOpen, onClose }: AddBackendModalProps): JSX.Element | null {
  const [tab, setTab] = useState<Tab>('url')

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/80 backdrop-blur-sm">
      <div className="bg-panel border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Server className="icon-sm text-accent" />
            <h2 className="text-sm font-semibold text-fg-bright">Add backend</h2>
          </div>
          <button
            onClick={onClose}
            className="text-dim hover:text-fg transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="icon-sm" />
          </button>
        </div>

        <div className="flex border-b border-border">
          <TabButton
            active={tab === 'url'}
            onClick={() => setTab('url')}
            icon={<Globe className="icon-xs" />}
            label="URL + token"
          />
          <TabButton
            active={tab === 'ssh'}
            onClick={() => setTab('ssh')}
            icon={<Terminal className="icon-xs" />}
            label="SSH host"
          />
        </div>

        {tab === 'url' ? <UrlTab onClose={onClose} /> : <SshTab onClose={onClose} />}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
        active
          ? 'text-fg-bright border-b-2 border-accent -mb-px'
          : 'text-dim hover:text-fg border-b-2 border-transparent -mb-px'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────
// URL + token tab — the original modal body, lightly reshuffled into
// its own component so the new tab strip can switch between this and
// the SSH tab without ceremony.
// ─────────────────────────────────────────────────────────────────────

function UrlTab({ onClose }: { onClose: () => void }): JSX.Element {
  const backend = useBackend()
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
      const registry = getBackendsRegistry()
      let savedId: string | null = null
      ws = new WebSocketClientTransport({
        url: parseResult.parsed.wsUrl,
        token: parseResult.parsed.token,
        onConnectionChange: (connected, reason) => {
          if (!savedId) return
          registry.setStatus(savedId, {
            state: connected ? 'connected' : 'disconnected',
            reason
          })
        }
      })
      await ws.connect()
      const snapshot = (await Promise.race<unknown>([
        ws.getStateSnapshot(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timed out waiting for snapshot — wrong port?')), 5000)
        )
      ])) as StateSnapshot
      const clientId = await ws.getClientId()
      const saved: BackendConnection = await backend.connectionsAdd(
        {
          label,
          url: parseResult.parsed.storedUrl,
          kind: 'remote'
        },
        parseResult.parsed.token
      )
      const store = registry.add(saved, ws)
      store.setSnapshot(snapshot.state)
      store.setClientId(clientId)
      savedId = saved.id
      registry.setActive(saved.id)
      void backend.connectionsSetActive(saved.id)
      void backend.connectionsSetLastConnected(saved.id)
      ws = null
      handleClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`Connection failed: ${message}`)
      try { ws?.close() } catch { /* ignore */ }
    } finally {
      setBusy(false)
    }
  }, [parseResult, effectiveLabel, suggestedLabel, handleClose, backend])

  return (
    <>
      <div className="px-5 py-4 space-y-4">
        <p className="text-xs text-dim leading-relaxed">
          Paste the connection link the host machine shows under{' '}
          <span className="text-fg">Settings → Server</span>, or the URL{' '}
          <code className="bg-app/40 px-1 rounded text-xs">harness-server</code>{' '}
          prints on startup.
        </p>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-dim uppercase tracking-wider">
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
            <div className="text-xs text-warning">{parseResult.error}</div>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-dim uppercase tracking-wider">
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
          <div className="text-xs text-danger bg-danger/10 border border-danger/30 rounded px-2.5 py-2">
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
          {busy && <Loader2 className="icon-xs animate-spin" />}
          {busy ? 'Testing…' : 'Test & save'}
        </button>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────
// SSH host tab — pick an alias from ~/.ssh/config (or type a freeform
// target), kick off ssh:bootstrap, render live progress from the slice.
// ─────────────────────────────────────────────────────────────────────

const CUSTOM_HOST = '__custom__'

function SshTab({ onClose }: { onClose: () => void }): JSX.Element {
  const backend = useBackend()
  const [hosts, setHosts] = useState<ConfiguredHost[]>([])
  const [hostsLoaded, setHostsLoaded] = useState(false)
  const [selectedAlias, setSelectedAlias] = useState<string>('')
  const [customTarget, setCustomTarget] = useState('')
  const [labelInput, setLabelInput] = useState('')
  const [labelEdited, setLabelEdited] = useState(false)
  const [bootstrapId, setBootstrapId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const logScrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void backend.sshListConfiguredHosts().then((list) => {
      setHosts(list)
      setHostsLoaded(true)
      if (list.length > 0) {
        setSelectedAlias(list[0].alias)
      } else {
        setSelectedAlias(CUSTOM_HOST)
      }
    })
  }, [backend])

  const progress = useSshBootstrap(bootstrapId)
  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight
    }
  }, [progress?.lines.length])

  const targetString = selectedAlias === CUSTOM_HOST
    ? customTarget.trim()
    : selectedAlias

  const suggestedLabel = useMemo(() => {
    if (!targetString) return ''
    const m = /^(?:[^@]+@)?([^:]+)/.exec(targetString)
    return m?.[1] || targetString
  }, [targetString])
  const effectiveLabel = labelEdited ? labelInput : suggestedLabel

  const phaseLabel = progress?.phase
  const canSubmit = !!targetString && !busy

  const handleSubmit = useCallback(async () => {
    setSubmitError(null)
    if (!targetString) {
      setSubmitError('Pick or type an SSH host first.')
      return
    }
    const id = crypto.randomUUID()
    setBootstrapId(id)
    setBusy(true)
    try {
      const result = await backend.sshBootstrap({
        bootstrapId: id,
        target: targetString,
        label: effectiveLabel.trim() || suggestedLabel || targetString
      })
      // Bootstrap succeeded — tunnel is live + connection is persisted.
      // Hand the new BackendConnection to the registry's hydrate path:
      // it calls sshReconnect (idempotent fast-path returns the
      // already-live URL+token) and opens a WS transport pointing at
      // the loopback. Then mark the new backend active so the user
      // lands on it immediately on modal close.
      const all = await backend.connectionsList()
      const fresh = all.find((c) => c.id === result.connectionId)
      if (!fresh) {
        throw new Error(`connections list missing freshly-added id ${result.connectionId}`)
      }
      const registry = getBackendsRegistry()
      await hydrateRemoteBackend(fresh, { registry, backend })
      registry.setActive(result.connectionId)
      void backend.connectionsSetActive(result.connectionId)
      void backend.connectionsSetLastConnected(result.connectionId)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setSubmitError(msg)
    } finally {
      setBusy(false)
    }
  }, [backend, targetString, effectiveLabel, suggestedLabel, onClose])

  const handleClose = useCallback(() => {
    if (busy) return
    setBootstrapId(null)
    setSubmitError(null)
    onClose()
  }, [busy, onClose])

  return (
    <>
      <div className="px-5 py-4 space-y-4">
        <p className="text-xs text-dim leading-relaxed">
          Pick a host from your <code className="bg-app/40 px-1 rounded text-xs">~/.ssh/config</code>, or
          type one. Harness will SSH in, install{' '}
          <code className="bg-app/40 px-1 rounded text-xs">harness-server</code> if it's not
          there, and open a local tunnel.
        </p>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-dim uppercase tracking-wider">
            SSH host
          </label>
          <select
            value={selectedAlias}
            onChange={(e) => setSelectedAlias(e.target.value)}
            disabled={busy}
            className="w-full bg-app/40 border border-border rounded px-2.5 py-1.5 text-xs text-fg-bright focus:outline-none focus:border-accent disabled:opacity-50"
          >
            {hostsLoaded && hosts.length === 0 && (
              <option value={CUSTOM_HOST}>No hosts in ~/.ssh/config — use Custom…</option>
            )}
            {hosts.map((h) => (
              <option key={h.alias} value={h.alias}>
                {h.alias}
                {h.user || h.port
                  ? ` (${h.user ? `${h.user}@` : ''}${h.host}${h.port ? `:${h.port}` : ''})`
                  : ` (${h.host})`}
              </option>
            ))}
            <option value={CUSTOM_HOST}>Custom host…</option>
          </select>
        </div>

        {selectedAlias === CUSTOM_HOST && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-dim uppercase tracking-wider">
              Target
            </label>
            <input
              value={customTarget}
              onChange={(e) => setCustomTarget(e.target.value)}
              placeholder="user@host or user@host:port"
              spellCheck={false}
              autoFocus
              disabled={busy}
              className="w-full bg-app/40 border border-border rounded px-2.5 py-1.5 text-xs font-mono text-fg-bright placeholder:text-faint focus:outline-none focus:border-accent disabled:opacity-50"
            />
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-dim uppercase tracking-wider">
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

        {(progress || submitError) && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-dim uppercase tracking-wider">
                Progress
              </label>
              {phaseLabel && (
                <span
                  className={`text-xs font-medium ${
                    phaseLabel === 'error'
                      ? 'text-danger'
                      : phaseLabel === 'connected'
                        ? 'text-success'
                        : 'text-accent'
                  }`}
                >
                  {phaseLabel}
                </span>
              )}
            </div>
            <div
              ref={logScrollRef}
              className="bg-app/40 border border-border rounded px-2 py-1.5 text-xs font-mono text-fg max-h-40 overflow-auto whitespace-pre-wrap"
            >
              {progress?.lines.map((line, i) => (
                <div key={i} className="leading-tight">{line}</div>
              ))}
              {progress?.phase === 'error' && progress.error && (
                <div className="mt-1 text-danger">
                  {progress.error.message}
                  {progress.error.detail && (
                    <div className="text-dim mt-1">{progress.error.detail}</div>
                  )}
                </div>
              )}
              {submitError && (
                <div className="mt-1 text-danger">{submitError}</div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
        <button
          onClick={handleClose}
          disabled={busy}
          className="px-3 py-1.5 text-xs text-dim hover:text-fg disabled:opacity-50 cursor-pointer transition-colors"
        >
          {progress?.phase === 'connected' ? 'Done' : 'Cancel'}
        </button>
        <button
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors flex items-center gap-2"
        >
          {busy && <Loader2 className="icon-xs animate-spin" />}
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </>
  )
}
