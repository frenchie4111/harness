import { useCallback } from 'react'
import { Laptop, Server, Plus } from 'lucide-react'
import {
  useConnections,
  useActiveBackend,
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
 *  redirects window.api calls, and we persist activeBackendId via
 *  window.api.connectionsSetActive() so the choice survives a restart.
 */
export function BackendChipStrip({ onAddBackend }: BackendChipStripProps): JSX.Element | null {
  const connections = useConnections()
  const active = useActiveBackend()

  const handleSelect = useCallback((id: string) => {
    if (id === active.id) return
    getBackendsRegistry().setActive(id)
    void window.api.connectionsSetActive(id)
    void window.api.connectionsSetLastConnected(id)
  }, [active.id])

  // Auto-hide at 1 backend. Single-backend installs see no chrome
  // change, exactly as the design intends.
  if (connections.length <= 1) return null

  return (
    <div className="border-t border-border px-2 py-1.5 shrink-0 flex items-center gap-1.5 overflow-x-auto">
      {connections.map((conn) => (
        <BackendChip
          key={conn.id}
          connection={conn}
          isActive={conn.id === active.id}
          onSelect={handleSelect}
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
}

function BackendChip({ connection, isActive, onSelect }: BackendChipProps): JSX.Element {
  const Icon = connection.kind === 'local' ? Laptop : Server
  return (
    <Tooltip label={connection.label} side="top">
      <button
        onClick={() => onSelect(connection.id)}
        className={`shrink-0 flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-colors cursor-pointer min-w-0 ${
          isActive
            ? 'bg-surface text-fg-bright border-fg'
            : 'bg-panel border-border text-dim hover:text-fg hover:border-border-strong'
        }`}
        style={{ maxWidth: 120 }}
      >
        <span
          className={`shrink-0 w-7 h-7 rounded flex items-center justify-center ${
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
        </span>
        <span className="text-xs font-medium truncate min-w-0">{connection.label}</span>
      </button>
    </Tooltip>
  )
}
