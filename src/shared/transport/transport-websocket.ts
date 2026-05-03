// Browser-side WebSocket implementation of ClientTransport.
//
// Lives in `shared/transport/` so it's importable from both the
// renderer (web client + Electron renderer) and the preload (when
// HARNESS_REMOTE_URL is set, the Electron preload swaps this in for
// ElectronClientTransport so the same window.api surface drives a
// remote backend). The whole point of WS is bypassing the
// preload/contextBridge plumbing — everything above the transport is
// already transport-agnostic (see the comment block atop
// `src/preload/transport-electron.ts`).
//
// Responsibilities:
//   - Own the socket lifecycle + reconnect-with-backoff.
//   - Translate `request(name, …)` into `{t:'req', id, name, args}` frames
//     and resolve the returned promise when `{t:'res', id, …}` arrives.
//   - Fan `{t:'state', event, seq}` out to registered listeners and
//     `{t:'sig', name, args}` out to per-channel signal listeners.
//   - On every (re)connect, re-snapshot and notify the store mirror so
//     any missed events from the gap are implicitly reconciled.
//
// Wire protocol is the same as the server's. See transport-websocket.ts
// on the main side for the frame shapes.

import type { StateEvent, StateSnapshot } from '../state'
import type {
  ClientSignalHandler,
  ClientTransport,
  StateEventListener
} from './transport'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

type ServerFrame =
  | { t: 'state'; event: StateEvent; seq: number }
  | { t: 'snapres'; id: string; ok: boolean; snapshot?: StateSnapshot; error?: string }
  | { t: 'res'; id: string; ok: boolean; value?: unknown; error?: string }
  | { t: 'sig'; name: string; args: unknown[] }

export interface WebSocketClientTransportOptions {
  url: string
  token: string
  /** Callback fired after each successful (re)connect, once the client
   *  has finished refetching the snapshot. The callee is expected to
   *  reset its local mirror to `snapshot`. */
  onSnapshot?: (snapshot: StateSnapshot) => void
  /** Backoff starting delay in ms; doubles up to `maxBackoffMs`. */
  initialBackoffMs?: number
  maxBackoffMs?: number
  /** Inject a custom WebSocket constructor (tests / non-browser runtimes). */
  WebSocketCtor?: typeof WebSocket
}

export class WebSocketClientTransport implements ClientTransport {
  private ws: WebSocket | null = null
  private nextRequestId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<StateEventListener>()
  private readonly signalListeners = new Map<string, Set<ClientSignalHandler>>()
  private connectPromise: Promise<void> | null = null
  private closed = false
  private backoffMs: number
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly WebSocketCtor: typeof WebSocket

  constructor(private readonly opts: WebSocketClientTransportOptions) {
    this.initialBackoffMs = opts.initialBackoffMs ?? 250
    this.maxBackoffMs = opts.maxBackoffMs ?? 5000
    this.backoffMs = this.initialBackoffMs
    this.WebSocketCtor = opts.WebSocketCtor ?? WebSocket
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.openSocket()
    return this.connectPromise
  }

  close(): void {
    this.closed = true
    this.ws?.close()
    this.ws = null
    for (const p of this.pending.values()) {
      p.reject(new Error('transport closed'))
    }
    this.pending.clear()
  }

  async getStateSnapshot(): Promise<StateSnapshot> {
    await this.ensureConnected()
    return this.sendSnapshotRequest()
  }

  onStateEvent(listener: StateEventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  async request(name: string, ...args: unknown[]): Promise<unknown> {
    await this.ensureConnected()
    const id = String(this.nextRequestId++)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.sendFrame({ t: 'req', id, name, args })
    })
  }

  send(name: string, ...args: unknown[]): void {
    // Fire-and-forget — if we're mid-reconnect, drop. PTY byte streams
    // aren't worth queueing; users will retype, and UI signals like
    // menu triggers are already idempotent or re-driven by focus.
    if (!this.ws || this.ws.readyState !== this.WebSocketCtor.OPEN) return
    this.sendFrame({ t: 'send', name, args })
  }

  onSignal(name: string, handler: ClientSignalHandler): () => void {
    let set = this.signalListeners.get(name)
    if (!set) {
      set = new Set()
      this.signalListeners.set(name, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  }

  async getClientId(): Promise<string> {
    const id = await this.request('transport:getClientId')
    return id as string
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.opts.url)
      url.searchParams.set('token', this.opts.token)
      const ws = new this.WebSocketCtor(url.toString())
      this.ws = ws

      let opened = false

      ws.addEventListener('open', () => {
        opened = true
        this.backoffMs = this.initialBackoffMs
        // Fire-and-forget: the snapshot request lets the store mirror
        // reconcile after a reconnect gap. First connect also uses this
        // path, so `getStateSnapshot()` called by the bootstrapper
        // completes against this same fetch.
        this.sendSnapshotRequest()
          .then((snap) => {
            this.opts.onSnapshot?.(snap)
          })
          .catch(() => {
            // handled when the socket errors out
          })
        resolve()
      })

      ws.addEventListener('message', (evt) => {
        let frame: ServerFrame
        try {
          frame = JSON.parse(String(evt.data)) as ServerFrame
        } catch {
          return
        }
        this.handleFrame(frame)
      })

      ws.addEventListener('error', () => {
        // 'error' fires before 'close'; just log-and-forward.
      })

      ws.addEventListener('close', () => {
        this.ws = null
        this.connectPromise = null
        for (const p of this.pending.values()) {
          p.reject(new Error('socket closed before response'))
        }
        this.pending.clear()
        if (!opened) reject(new Error('websocket failed to open'))
        if (!this.closed) this.scheduleReconnect()
      })
    })
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs)
    setTimeout(() => {
      if (this.closed) return
      this.connect().catch(() => {
        // next close handler schedules the retry
      })
    }, delay)
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === this.WebSocketCtor.OPEN) return
    await this.connect()
  }

  private sendSnapshotRequest(): Promise<StateSnapshot> {
    const id = String(this.nextRequestId++)
    return new Promise<StateSnapshot>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as StateSnapshot),
        reject
      })
      this.sendFrame({ t: 'snapreq', id })
    })
  }

  private sendFrame(frame: object): void {
    this.ws?.send(JSON.stringify(frame))
  }

  private handleFrame(frame: ServerFrame): void {
    if (frame.t === 'state') {
      for (const l of this.eventListeners) l(frame.event, frame.seq)
      return
    }
    if (frame.t === 'sig') {
      const set = this.signalListeners.get(frame.name)
      if (!set) return
      for (const h of set) {
        try {
          h(...(frame.args ?? []))
        } catch {
          // swallow — a flaky signal listener mustn't kill the socket
        }
      }
      return
    }
    if (frame.t === 'snapres') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      if (frame.ok && frame.snapshot) pending.resolve(frame.snapshot)
      else pending.reject(new Error(frame.error ?? 'snapshot failed'))
      return
    }
    if (frame.t === 'res') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      if (frame.ok) pending.resolve(frame.value)
      else pending.reject(new Error(frame.error ?? 'request failed'))
      return
    }
  }
}
