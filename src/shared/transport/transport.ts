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

import type { StateEvent, StateSnapshot } from '../state'

export type RequestHandler = (...args: unknown[]) => unknown | Promise<unknown>
export type SignalHandler = (...args: unknown[]) => void
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
  onSignal(name: string, handler: SignalHandler): () => void
}
