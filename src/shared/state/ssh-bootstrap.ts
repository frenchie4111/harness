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
  | 'connecting'    // SSH handshake
  | 'probing'       // checking if harness-server is installed on the remote
  | 'installing'    // running install-headless.sh over SSH
  | 'upgrading'     // re-running the installer over an existing install
  | 'restarting'    // killing the old server process before relaunching
  | 'starting'      // launching the server detached
  | 'tunneling'     // setting up SSH local port forwarding
  | 'connected'     // happy terminal state
  | 'disconnected'  // link dropped; supervisor is waiting out its backoff
  | 'reconnecting'  // supervisor is mid-attempt after a drop
  | 'error'         // sad terminal state

/** Phases where the tunnel is being (re)established rather than up or
 *  dead. The chip strip renders these as "reconnecting…" rather than as
 *  a hard disconnect. */
const IN_FLIGHT_PHASES: ReadonlySet<BootstrapPhase> = new Set<BootstrapPhase>([
  'connecting',
  'probing',
  'installing',
  'upgrading',
  'restarting',
  'starting',
  'tunneling',
  'reconnecting'
])

export function isInFlightPhase(phase: BootstrapPhase): boolean {
  return IN_FLIGHT_PHASES.has(phase)
}

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
  /** Loopback port the tunnel bound to, once it's up. Reconnects try to
   *  reacquire the previous port, but can land on a new one if it's
   *  taken — the renderer compares this against the port in its live WS
   *  URL to decide whether it needs to rebuild the transport. */
  localPort?: number
  /** Populated when `phase === 'error'`. */
  error?: BootstrapError
}

/** What version of `harness-server` a remote is running, and whether it
 *  matches the Ness that's driving it. Headless tarballs are released
 *  on the same tag as the desktop build, so exact equality is the
 *  correctness bar — a mismatch in either direction means the wire
 *  protocol can drift.
 *
 *  Populated on every SSH probe (bootstrap, reconnect, boot pre-warm)
 *  and keyed by connectionId, so it outlives the per-attempt
 *  `byId` progress entries the modal clears. */
export interface RemoteServerVersion {
  connectionId: string
  /** What `harness-server --version` printed on the remote. */
  installed: string
  /** The local Ness version we compared against. */
  expected: string
  upgradeAvailable: boolean
  checkedAt: number
}

export interface SshBootstrapState {
  /** Active + recently-finished bootstrap attempts, keyed by bootstrapId.
   *  Cleared explicitly via `sshBootstrap/clear`. */
  byId: Record<string, BootstrapProgress>
  /** Last known remote `harness-server` version per SSH backend. Drives
   *  the chip strip's upgrade affordance. */
  serverVersions: Record<string, RemoteServerVersion>
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
      type: 'sshBootstrap/tunnelReady'
      payload: { bootstrapId: string; localPort: number; now: number }
    }
  | {
      type: 'sshBootstrap/errored'
      payload: { bootstrapId: string; error: BootstrapError; now: number }
    }
  | { type: 'sshBootstrap/clear'; payload: { bootstrapId: string } }
  | { type: 'sshBootstrap/serverVersionProbed'; payload: RemoteServerVersion }
  | { type: 'sshBootstrap/serverVersionForgotten'; payload: { connectionId: string } }

export const initialSshBootstrap: SshBootstrapState = {
  byId: {},
  serverVersions: {}
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
      // Reconnect attempts reuse one bootstrapId across retries, so a
      // restart clears the transcript but keeps the connection linkage —
      // otherwise the chip loses track of which backend is reconnecting
      // between `started` and the `connectionLinked` that follows it.
      const prior = state.byId[bootstrapId]
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
            updatedAt: now,
            ...(prior?.connectionId ? { connectionId: prior.connectionId } : {}),
            ...(prior?.localPort ? { localPort: prior.localPort } : {})
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
    case 'sshBootstrap/tunnelReady':
      return patch(state, event.payload.bootstrapId, (p) => ({
        ...p,
        localPort: event.payload.localPort,
        updatedAt: event.payload.now
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
    case 'sshBootstrap/serverVersionProbed': {
      const next = event.payload
      const prev = state.serverVersions[next.connectionId]
      // Re-probes on every reconnect would otherwise churn the map (and
      // every chip subscribed to it) on a value that rarely moves.
      if (
        prev &&
        prev.installed === next.installed &&
        prev.expected === next.expected &&
        prev.upgradeAvailable === next.upgradeAvailable
      ) {
        return state
      }
      return {
        ...state,
        serverVersions: { ...state.serverVersions, [next.connectionId]: next }
      }
    }
    case 'sshBootstrap/serverVersionForgotten': {
      if (!(event.payload.connectionId in state.serverVersions)) return state
      const next = { ...state.serverVersions }
      delete next[event.payload.connectionId]
      return { ...state, serverVersions: next }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
