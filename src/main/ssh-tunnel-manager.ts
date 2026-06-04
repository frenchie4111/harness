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

export class SshTunnelManager {
  private byBackendId = new Map<string, TunnelEntry>()

  has(backendId: string): boolean {
    return this.byBackendId.has(backendId)
  }

  get(backendId: string): TunnelEntry | undefined {
    return this.byBackendId.get(backendId)
  }

  /** Register a freshly-bootstrapped tunnel. If `backendId` already has
   *  one, the old entry is closed first — re-bootstrapping the same
   *  backend should never leave a dangling tunnel from the previous
   *  attempt. */
  register(entry: TunnelEntry): void {
    const existing = this.byBackendId.get(entry.backendId)
    if (existing) {
      this.disposeEntry(existing)
    }
    this.byBackendId.set(entry.backendId, entry)
  }

  /** Tear down the local tunnel + SSH connection for `backendId`.
   *  Returns true if there was a tunnel to close, false otherwise.
   *
   *  Important: this does NOT kill the remote `harness-server` — the
   *  process keeps running on the remote so a future reconnect can
   *  reuse it. See the v2 carve-out in plans/remote-main.md §4. */
  unregister(backendId: string): boolean {
    const entry = this.byBackendId.get(backendId)
    if (!entry) return false
    this.byBackendId.delete(backendId)
    this.disposeEntry(entry)
    return true
  }

  /** Close every tunnel + SSH connection. Called from the app's
   *  before-quit hook so we don't leak file descriptors. */
  closeAll(): void {
    for (const entry of this.byBackendId.values()) {
      this.disposeEntry(entry)
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
    const entry = this.byBackendId.get(backendId)
    if (!entry) return null
    return `ws://127.0.0.1:${entry.localPort}/?token=${entry.token}`
  }

  private disposeEntry(entry: TunnelEntry): void {
    try {
      entry.tunnelServer.close()
    } catch {
      // Server already closed — ignore.
    }
    try {
      entry.ssh.dispose()
    } catch {
      // Connection already torn down — ignore.
    }
  }
}
