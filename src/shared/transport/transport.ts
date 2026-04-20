// Transport abstraction — the seam between main and renderer.
//
// Today there's exactly one implementation pair: ElectronServerTransport
// (main side, wraps ipcMain + webContents.send) and ElectronClientTransport
// (renderer side, wraps ipcRenderer). In the future, additional pairs
// (WebSocket, SSH stdio, …) can slot in without touching any call site
// above this layer — the store, slices, and window.api surface are all
// transport-agnostic.
//
// Three kinds of traffic flow across a transport:
//
// 1. State events — the authoritative mutation stream. Main's Store
//    dispatches a StateEvent, the server transport broadcasts it to every
//    connected client, and each client's mirror applies the SAME shared
//    reducer. This is the backbone of the 2.0 architecture.
//
// 2. Requests — one-shot RPC calls (mirror of ipcMain.handle /
//    ipcRenderer.invoke). Named by a channel string; args and return
//    value are arbitrary JSON-serializable data. All requests are async;
//    there is intentionally no sync variant so future non-Electron
//    transports don't have to invent blocking round-trips.
//
// 3. Signals — fire-and-forget pushes in either direction (mirror of
//    webContents.send / ipcRenderer.send). Used for high-frequency
//    streams (PTY bytes) and low-level fire-and-forget notifications
//    (menu-triggered events, pty:write). No return value, no delivery
//    guarantee beyond what the underlying transport provides.
//
// Server-side request/signal handlers receive a ConnectionContext as
// their first argument. The `clientId` is a server-assigned UUID that
// stays stable for the life of a connection (one per BrowserWindow, one
// per WebSocket). It lets main-side handlers gate on "who's calling" —
// e.g. only the terminal's current controller's pty:write / pty:resize
// are honoured; other clients watch as spectators. Client-side signal
// handlers don't receive a ctx because the server identity is implicit.

import type { StateEvent, StateSnapshot } from '../state'

/** Server-assigned identity of a connected client, threaded into every
 *  request/signal handler so main can gate on who's calling. Stable for
 *  the lifetime of a connection (a BrowserWindow or a WebSocket). */
export interface ConnectionContext {
  clientId: string
}

// Handler args are typed as `any[]` because the wire boundary is
// inherently untyped — the transport doesn't know what each channel's
// arg shape is. Individual handlers declare their own concrete types at
// the call site (e.g. `(ctx, repoRoot: string) => …`). This mirrors how
// ipcMain.handle / ipcRenderer.invoke are typed in @types/electron.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RequestHandler = (ctx: ConnectionContext, ...args: any[]) => unknown | Promise<unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SignalHandler = (ctx: ConnectionContext, ...args: any[]) => void
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClientSignalHandler = (...args: any[]) => void
export type StateEventListener = (event: StateEvent, seq: number) => void

export interface ServerTransport {
  /** Broadcast a state event to every connected client. */
  broadcastStateEvent(event: StateEvent, seq: number): void

  /** Register an async request handler for a named channel. */
  onRequest(name: string, handler: RequestHandler): void

  /** Register a fire-and-forget signal handler from clients. */
  onSignal(name: string, handler: SignalHandler): void

  /** Push a fire-and-forget signal to all connected clients. */
  sendSignal(name: string, ...args: unknown[]): void

  /** Subscribe to connection-close events so app code can sweep state
   *  owned by the disconnecting client (e.g. clear controllers/spectators). */
  onClientDisconnect(callback: (clientId: string) => void): void

  /** Lifecycle — called once during boot. */
  start(): void

  /** Lifecycle — called during shutdown. */
  stop(): void
}

export interface ClientTransport {
  /** Fetch the current state snapshot from the server. */
  getStateSnapshot(): Promise<StateSnapshot>

  /** Subscribe to the incoming state-event stream. Returns an unsubscribe. */
  onStateEvent(listener: StateEventListener): () => void

  /** Async RPC — mirror of ipcRenderer.invoke. */
  request(name: string, ...args: unknown[]): Promise<unknown>

  /** Fire-and-forget — mirror of ipcRenderer.send. */
  send(name: string, ...args: unknown[]): void

  /** Subscribe to a signal channel pushed from the server. Returns an unsubscribe. */
  onSignal(name: string, handler: ClientSignalHandler): () => void

  /** The server-assigned identity for this client. Stable for the
   *  connection's lifetime; reassigned (new UUID) after a reconnect. */
  getClientId(): Promise<string>
}
