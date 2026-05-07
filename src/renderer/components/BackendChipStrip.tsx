import { useCallback } from 'react'
import { Laptop, Server, Plus, X } from 'lucide-react'
import { useBackend } from '../backend'
import {
  useConnections,
  useActiveBackend,
  useBackendStatus,
  getBackendsRegistry
} from '../store'
import { Tooltip } from './Tooltip'
import type { BackendConnection } from '../types'

interface BackendChipStripProps {
  /** Opens the add-backend modal. Wired up alongside the modal in a
   *  later commit; the + button is rendered now so the strip's spec
   *  matches the design doc. */
  onAddBackend: () => void
}

/** Horizontal strip of avatar+label chips for each configured backend.
 *  Rendered above the bottom icon row in the Sidebar; hidden when
 *  there's only one backend (the auto-seeded Local), per design §A.
 *
 *  Click a chip to switch the active backend — registry.setActive()
 *  flips which store the slice hooks read from, the preload's router
 *  redirects backend RPCs, and we persist activeBackendId via
 *  backend.connectionsSetActive() so the choice survives a restart.
 */
export function BackendChipStrip({ onAddBackend }: BackendChipStripProps): JSX.Element | null {
  const connections = useConnections()
  const active = useActiveBackend()
  const backend = useBackend()

  const handleSelect = useCallback((id: string) => {
    if (id === active.id) return
    getBackendsRegistry().setActive(id)
    void backend.connectionsSetActive(id)
    void backend.connectionsSetLastConnected(id)
  }, [active.id, backend])

  const handleRemove = useCallback(
    (conn: BackendConnection) => {
      const ok = window.confirm(
        `Remove backend "${conn.label}"?\n\nThe connection settings and saved auth token will be deleted from this Harness install. The remote server itself is not affected — you can re-add it later.`
      )
      if (!ok) return
      // Close the WS transport + drop from the registry first; the chip
      // disappears immediately and the user lands back on Local. Then
      // persist via main so the entry is gone on next launch.
      getBackendsRegistry().remove(conn.id)
      void backend.connectionsRemove(conn.id)
    },
    [backend]
  )

  // Auto-hide when only Local exists (per design §A) — single-backend
  // installs see no chrome change. `File → Add Backend…` in the
  // Electron menu is the entry point for the first remote; once the
  // user adds one, the strip reveals with both chips + the `+` button.
  if (connections.length <= 1) return null

  return (
    <div className="border-t border-border px-2 py-1.5 shrink-0 flex items-center gap-1.5 overflow-x-auto">
      {connections.map((conn) => (
        <BackendChip
          key={conn.id}
          connection={conn}
          isActive={conn.id === active.id}
          onSelect={handleSelect}
          onRemove={handleRemove}
        />
      ))}
      <Tooltip label="Add backend" side="top">
        <button
          onClick={onAddBackend}
          className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-dim hover:text-fg hover:bg-surface transition-colors cursor-pointer border border-dashed border-border-strong"
          aria-label="Add backend"
        >
          <Plus size={14} />
        </button>
      </Tooltip>
    </div>
  )
}

interface BackendChipProps {
  connection: BackendConnection
  isActive: boolean
  onSelect: (id: string) => void
  onRemove: (connection: BackendConnection) => void
}

function BackendChip({ connection, isActive, onSelect, onRemove }: BackendChipProps): JSX.Element {
  const Icon = connection.kind === 'local' ? Laptop : Server
  const status = useBackendStatus(connection.id)
  const disconnected = status.state === 'disconnected'
  const isRemote = connection.kind === 'remote'
  const tooltip = disconnected
    ? `${connection.label} — disconnected${status.reason ? ': ' + status.reason : ''}`
    : connection.label
  // Outer wrapper is a div, not a button, so the inner remove `<button>`
  // doesn't nest button elements (invalid HTML). The chip body is a
  // button; the remove X is a separate button positioned over the
  // top-right corner and only revealed on hover for remote chips
  // (Local is pinned per design §H, no remove affordance).
  return (
    <div className="group relative shrink-0">
      <Tooltip label={tooltip} side="top">
        <button
          onClick={() => onSelect(connection.id)}
          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-colors cursor-pointer min-w-0 ${
            disconnected
              ? 'bg-panel/40 border-border text-faint hover:text-dim'
              : isActive
                ? 'bg-surface text-fg-bright border-fg'
                : 'bg-panel border-border text-dim hover:text-fg hover:border-border-strong'
          }`}
          style={{ maxWidth: 120, opacity: disconnected ? 0.55 : 1 }}
        >
          <span
            className={`shrink-0 w-7 h-7 rounded flex items-center justify-center relative ${
              isActive ? 'bg-app/40' : 'bg-app/30'
            }`}
            style={connection.color ? { backgroundColor: connection.color } : undefined}
          >
            {connection.initials ? (
              <span className="text-[11px] font-semibold uppercase">
                {connection.initials.slice(0, 2)}
              </span>
            ) : (
              <Icon size={14} />
            )}
            {disconnected && (
              <span
                className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-danger ring-2 ring-panel"
                aria-hidden="true"
              />
            )}
          </span>
          <span className="text-xs font-medium truncate min-w-0">{connection.label}</span>
        </button>
      </Tooltip>
      {isRemote && (
        <Tooltip label="Remove backend" side="top">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(connection)
            }}
            aria-label={`Remove ${connection.label}`}
            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-panel-raised border border-border-strong text-faint hover:text-danger hover:border-danger flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          >
            <X size={9} strokeWidth={2.5} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
