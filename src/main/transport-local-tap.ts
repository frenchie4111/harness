// A ServerTransport that has no wire at all — it just remembers every
// handler `index.ts` registers and lets main call one directly.
//
// This exists so main-side callers that aren't a connected client (the
// ness-app MCP endpoints, notably) can reuse the ~60 `config:set*`
// request handlers instead of re-implementing the saveConfig + dispatch
// pair for each setting. Registration is fan-out through
// CompoundServerTransport, so a handler added for the renderer is
// automatically invokable here with no extra bookkeeping.
//
// It is deliberately NOT a client: nothing here is reachable from
// outside the process, `broadcastStateEvent` is a no-op, and there are
// no connections to disconnect.

import type { StateEvent } from '../shared/state'
import type {
  RequestHandler,
  ServerTransport,
  SignalHandler
} from '../shared/transport/transport'

const LOCAL_CLIENT_ID = 'local-tap'

export class LocalTapTransport implements ServerTransport {
  private readonly requests = new Map<string, RequestHandler>()
  private readonly signals = new Map<string, SignalHandler>()

  start(): void {}
  stop(): void {}
  broadcastStateEvent(_event: StateEvent, _seq: number): void {}
  onClientDisconnect(_callback: (clientId: string) => void): void {}

  onRequest(name: string, handler: RequestHandler): void {
    this.requests.set(name, handler)
  }

  onSignal(name: string, handler: SignalHandler): void {
    this.signals.set(name, handler)
  }

  sendSignal(_name: string, ..._args: unknown[]): void {}

  hasRequest(name: string): boolean {
    return this.requests.has(name)
  }

  /** Invoke a registered request handler as if a client had called it.
   *  Throws for an unknown channel — that's a programming error (a
   *  registry entry naming a channel nobody registered), not something
   *  a caller should paper over. */
  async invoke(name: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.requests.get(name)
    if (!handler) throw new Error(`no request handler registered for ${name}`)
    return await handler({ clientId: LOCAL_CLIENT_ID }, ...args)
  }
}
