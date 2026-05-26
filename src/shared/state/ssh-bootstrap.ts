// SSH bootstrap progress slice (Tier-1 remote-SSH backend flow).
//
// Tracks the live status of an in-flight or recently-finished SSH
// bootstrap so the AddBackendModal's SSH tab can render a progress log.
// Keyed by `bootstrapId` (a freshly-minted uuid the renderer mints when
// kicking off `ssh:bootstrap`) — not by `connectionId`, because the
// connection doesn't exist yet during the install/start phases. The
// connection id is filled in once `connections:add` returns; the
// renderer can then key on whichever it has.
//
// Progress events are append-only — the reducer keeps a rolling
// `lines[]` of human-readable log lines so the modal can render the
// transcript verbatim. `phase` is a coarse machine-readable status that
// drives the visible step indicator.
//
// On terminal states (`connected` / `error`), the entry is kept around
// (not auto-cleared) so the user can read the final log even after the
// modal closes. The renderer calls `sshBootstrap/clear` when it wants
// to drop an entry (modal close / next bootstrap kick-off).

export type BootstrapPhase =
  | 'connecting'  // SSH handshake
  | 'probing'     // checking if harness-server is installed on the remote
  | 'installing'  // running install-headless.sh over SSH
  | 'starting'    // launching the server detached
  | 'tunneling'   // setting up SSH local port forwarding
  | 'connected'   // happy terminal state
  | 'error'       // sad terminal state

export interface BootstrapError {
  code:
    | 'host_unreachable'
    | 'auth_failed'
    | 'platform_unsupported'
    | 'install_failed'
    | 'server_start_failed'
    | 'tunnel_failed'
    | 'unknown'
  message: string
  detail?: string
}

export interface BootstrapProgress {
  /** Stable id for this bootstrap attempt (uuid). Distinct from the
   *  eventual connection id — the connection doesn't exist while the
   *  install/start phases run. */
  bootstrapId: string
  /** Human label the user typed / picked (e.g. "build-box"). Used as
   *  the modal title while the progress log is open. */
  label: string
  /** The SSH target string — alias from ~/.ssh/config or freeform
   *  user@host[:port]. */
  target: string
  phase: BootstrapPhase
  /** Rolling log of human-readable lines, most-recent appended. */
  lines: string[]
  /** Wall-clock ms of the last progress event, used for stalling
   *  detection in the UI ("hasn't moved in a while…"). */
  updatedAt: number
  /** Populated once `connections:add` returns successfully. Lets the
   *  renderer correlate this progress entry back to a BackendConnection. */
  connectionId?: string
  /** Populated when `phase === 'error'`. */
  error?: BootstrapError
}

export interface SshBootstrapState {
  /** Active + recently-finished bootstrap attempts, keyed by bootstrapId.
   *  Cleared explicitly via `sshBootstrap/clear`. */
  byId: Record<string, BootstrapProgress>
}

export type SshBootstrapEvent =
  | {
      type: 'sshBootstrap/started'
      payload: { bootstrapId: string; label: string; target: string; now: number }
    }
  | {
      type: 'sshBootstrap/phaseChanged'
      payload: { bootstrapId: string; phase: BootstrapPhase; now: number }
    }
  | {
      type: 'sshBootstrap/lineLogged'
      payload: { bootstrapId: string; line: string; now: number }
    }
  | {
      type: 'sshBootstrap/connectionLinked'
      payload: { bootstrapId: string; connectionId: string }
    }
  | {
      type: 'sshBootstrap/errored'
      payload: { bootstrapId: string; error: BootstrapError; now: number }
    }
  | { type: 'sshBootstrap/clear'; payload: { bootstrapId: string } }

export const initialSshBootstrap: SshBootstrapState = {
  byId: {}
}

function patch(
  state: SshBootstrapState,
  id: string,
  fn: (p: BootstrapProgress) => BootstrapProgress
): SshBootstrapState {
  const existing = state.byId[id]
  if (!existing) return state
  return { ...state, byId: { ...state.byId, [id]: fn(existing) } }
}

export function sshBootstrapReducer(
  state: SshBootstrapState,
  event: SshBootstrapEvent
): SshBootstrapState {
  switch (event.type) {
    case 'sshBootstrap/started': {
      const { bootstrapId, label, target, now } = event.payload
      return {
        ...state,
        byId: {
          ...state.byId,
          [bootstrapId]: {
            bootstrapId,
            label,
            target,
            phase: 'connecting',
            lines: [],
            updatedAt: now
          }
        }
      }
    }
    case 'sshBootstrap/phaseChanged':
      return patch(state, event.payload.bootstrapId, (p) => ({
        ...p,
        phase: event.payload.phase,
        updatedAt: event.payload.now
      }))
    case 'sshBootstrap/lineLogged':
      return patch(state, event.payload.bootstrapId, (p) => ({
        ...p,
        lines: [...p.lines, event.payload.line],
        updatedAt: event.payload.now
      }))
    case 'sshBootstrap/connectionLinked':
      return patch(state, event.payload.bootstrapId, (p) => ({
        ...p,
        connectionId: event.payload.connectionId
      }))
    case 'sshBootstrap/errored':
      return patch(state, event.payload.bootstrapId, (p) => ({
        ...p,
        phase: 'error',
        error: event.payload.error,
        updatedAt: event.payload.now
      }))
    case 'sshBootstrap/clear': {
      if (!(event.payload.bootstrapId in state.byId)) return state
      const next = { ...state.byId }
      delete next[event.payload.bootstrapId]
      return { ...state, byId: next }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
