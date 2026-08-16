// Tracks active SSH connections + their port-forward servers keyed by
// backend id. The bootstrap orchestrator hands a fresh SSH connection +
// local-tunnel server to `register(...)` once the flow finishes; the
// renderer's connection-remove handler later calls `unregister(id)` to
// tear the LOCAL end down. We deliberately do NOT kill the remote
// `harness-server` — it stays alive for other Harnesses (and for future
// reconnects from this one). v2 may add an opt-in "stop remote server"
// affordance per the brief.
//
// At app quit, `closeAll()` tears every tunnel + SSH connection down so
// the OS doesn't accumulate orphaned sockets across restarts.
//
// This stays a dumb registry on purpose. It detects that a link died and
// says so via `onDropped`; deciding what to do about it (backoff, retry,
// give up) belongs to SshReconnectSupervisor.

import type { NodeSSH } from 'node-ssh'
import type { Server as NetServer } from 'net'

export interface TunnelEntry {
  /** Backend id this tunnel belongs to. */
  backendId: string
  /** Local loopback port the renderer connects to. */
  localPort: number
  /** Remote port the harness-server is bound to. */
  remotePort: number
  /** Token the renderer needs to include in its WS URL. */
  token: string
  /** Active node-ssh client. Disposed on unregister/closeAll. */
  ssh: NodeSSH
  /** The local TCP server that proxies into ssh.forwardOut. Closing it
   *  tears the tunnel down without disturbing the remote server. */
  tunnelServer: NetServer
}

export interface SshTunnelManagerOptions {
  /** Fired when a registered tunnel's SSH link dies on its own (as
   *  opposed to being torn down by unregister/closeAll). Fires at most
   *  once per registration. */
  onDropped?: (backendId: string) => void
}

/** Minimal slice of ssh2's Client that we attach drop listeners to.
 *  node-ssh exposes it as `.connection` and nulls it out on close. */
interface DropEmitter {
  on(event: string, cb: () => void): unknown
  off?(event: string, cb: () => void): unknown
  removeListener?(event: string, cb: () => void): unknown
}

interface Registration {
  entry: TunnelEntry
  /** Detaches the drop listeners from the ssh2 client. */
  detach: () => void
  /** Set when WE tore this entry down, so the teardown's own `close`
   *  event isn't mistaken for an unexpected drop. */
  disposedByUs: boolean
}

export class SshTunnelManager {
  private byBackendId = new Map<string, Registration>()
  private onDropped?: (backendId: string) => void

  constructor(options: SshTunnelManagerOptions = {}) {
    this.onDropped = options.onDropped
  }

  has(backendId: string): boolean {
    return this.byBackendId.has(backendId)
  }

  get(backendId: string): TunnelEntry | undefined {
    return this.byBackendId.get(backendId)?.entry
  }

  /** Whether the SSH link behind this backend is still up. node-ssh
   *  nulls its `connection` on close, so `isConnected()` is an honest
   *  liveness read — the local `net.Server` keeps listening either way,
   *  which is exactly why a dead tunnel used to look alive. */
  isAlive(backendId: string): boolean {
    const reg = this.byBackendId.get(backendId)
    if (!reg) return false
    const ssh = reg.entry.ssh as Partial<NodeSSH>
    if (typeof ssh.isConnected !== 'function') return true
    try {
      return ssh.isConnected()
    } catch {
      return false
    }
  }

  /** Register a freshly-bootstrapped tunnel. If `backendId` already has
   *  one, the old entry is closed first — re-bootstrapping the same
   *  backend should never leave a dangling tunnel from the previous
   *  attempt. */
  register(entry: TunnelEntry): void {
    const existing = this.byBackendId.get(entry.backendId)
    if (existing) {
      this.disposeRegistration(existing)
    }
    const reg: Registration = { entry, detach: () => {}, disposedByUs: false }
    this.byBackendId.set(entry.backendId, reg)
    reg.detach = this.watchForDrop(reg)
  }

  /** Tear down the local tunnel + SSH connection for `backendId`.
   *  Returns true if there was a tunnel to close, false otherwise.
   *
   *  Important: this does NOT kill the remote `harness-server` — the
   *  process keeps running on the remote so a future reconnect can
   *  reuse it. See the v2 carve-out in plans/remote-main.md §4. */
  unregister(backendId: string): boolean {
    const reg = this.byBackendId.get(backendId)
    if (!reg) return false
    this.byBackendId.delete(backendId)
    this.disposeRegistration(reg)
    return true
  }

  /** Close every tunnel + SSH connection. Called from the app's
   *  before-quit hook so we don't leak file descriptors. */
  closeAll(): void {
    for (const reg of this.byBackendId.values()) {
      this.disposeRegistration(reg)
    }
    this.byBackendId.clear()
  }

  /** Return the local URL the renderer should connect to for this
   *  backend. The scheme is `ws://` because the loopback is consumed
   *  directly by `WebSocketClientTransport` (which calls `new
   *  WebSocket(url)` — that throws on `http://`). Non-SSH backends
   *  pasted via the URL tab go through `parseConnectionUrl` which
   *  normalizes http→ws too. */
  buildLocalUrl(backendId: string): string | null {
    const reg = this.byBackendId.get(backendId)
    if (!reg) return null
    return `ws://127.0.0.1:${reg.entry.localPort}/?token=${reg.entry.token}`
  }

  /** Attach drop listeners to the underlying ssh2 client.
   *
   *  The `error` listener isn't optional: node-ssh removes its own
   *  handshake-time `error` handler once the connection is ready, so a
   *  post-ready error on the ssh2 Client would be an 'error' event with
   *  zero listeners — which Node re-throws as an uncaught exception. We
   *  swallow it here and let the `close` that follows drive reconnect. */
  private watchForDrop(reg: Registration): () => void {
    const conn = (reg.entry.ssh as { connection?: DropEmitter | null }).connection
    if (!conn || typeof conn.on !== 'function') return () => {}
    let notified = false
    const fire = (): void => {
      if (notified || reg.disposedByUs) return
      // A stale registration that's already been replaced shouldn't
      // trigger a reconnect for whatever took its place.
      if (this.byBackendId.get(reg.entry.backendId) !== reg) return
      notified = true
      this.onDropped?.(reg.entry.backendId)
    }
    const onSwallow = (): void => {}
    conn.on('close', fire)
    conn.on('end', fire)
    conn.on('error', onSwallow)
    return () => {
      const off = conn.off ?? conn.removeListener
      if (typeof off !== 'function') return
      off.call(conn, 'close', fire)
      off.call(conn, 'end', fire)
      off.call(conn, 'error', onSwallow)
    }
  }

  private disposeRegistration(reg: Registration): void {
    reg.disposedByUs = true
    try {
      reg.detach()
    } catch {
      // Listener already gone — ignore.
    }
    try {
      reg.entry.tunnelServer.close()
    } catch {
      // Server already closed — ignore.
    }
    try {
      reg.entry.ssh.dispose()
    } catch {
      // Connection already torn down — ignore.
    }
  }
}
