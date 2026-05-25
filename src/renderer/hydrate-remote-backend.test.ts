// Regression test for the e07bf05 → fix sequence. The bug:
// hydrateRemoteBackend registered the remote BEFORE awaiting connect(),
// and on connect failure the catch block didn't remove the entry. The
// outer hydration loop then pinned active at the failed remote, the
// renderer read from an empty store, and App.tsx fell through to the
// onboarding screen even though the local backend had the user's repos.
//
// The fix removes the half-registered entry in the catch. BackendsRegistry.remove
// auto-falls-back to LOCAL_BACKEND_ID when the removed entry was active,
// so this single line handles both "remote is saved active" and "remote
// is just one of several" cases.

import { describe, it, expect } from 'vitest'
import { WebSocketServer, WebSocket as WSClient } from 'ws'
import {
  BackendsRegistry,
  LOCAL_BACKEND_ID,
  hydrateRemoteBackend
} from './store'
import type { BackendConnection } from './types'
import type { LocalTransportHandle } from '../shared/transport/transport'
import { WebSocketClientTransport } from '../shared/transport/transport-websocket'

function fakeLocalTransport(): LocalTransportHandle {
  return {
    getStateSnapshot: async () => ({ state: {} as never, seq: 0 }),
    onStateEvent: () => () => undefined,
    request: async () => undefined,
    send: () => undefined,
    onSignal: () => () => undefined,
    getClientId: async () => 'local-client',
    onReconnect: () => () => undefined
  }
}

function makeRegistry(): { registry: BackendsRegistry; localConn: BackendConnection } {
  const registry = new BackendsRegistry()
  const localConn: BackendConnection = {
    id: LOCAL_BACKEND_ID,
    label: 'Local',
    url: '',
    kind: 'local',
    addedAt: 0
  }
  registry.add(localConn, fakeLocalTransport())
  return { registry, localConn }
}

function rejectingServer(): Promise<{ port: number; close: () => Promise<void> }> {
  // Auth-fails everything so the upgrade is denied → client's WS fires
  // close with `opened=false` → connect() rejects with "websocket failed
  // to open". Same shape as a real server-side token mismatch.
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, cb) => cb(false, 401, 'unauthorized')
    })
    server.on('listening', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr) {
        resolve({
          port: addr.port,
          close: () => new Promise<void>((r) => server.close(() => r()))
        })
      } else {
        reject(new Error('failed to bind stub ws server'))
      }
    })
    server.on('error', reject)
  })
}

describe('BackendsRegistry.remove falls back to local', () => {
  it('removes the entry and restores activeId when the removed id was active', () => {
    const { registry } = makeRegistry()
    const remote: BackendConnection = {
      id: 'remote-1',
      label: 'R1',
      url: 'ws://example.invalid/',
      kind: 'remote',
      addedAt: Date.now()
    }
    registry.add(remote, fakeLocalTransport())
    registry.setActive('remote-1')
    expect(registry.getActiveId()).toBe('remote-1')

    registry.remove('remote-1')

    expect(registry.has('remote-1')).toBe(false)
    expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
  })

  it('leaves activeId alone when removing a non-active entry', () => {
    const { registry } = makeRegistry()
    const remote: BackendConnection = {
      id: 'remote-1',
      label: 'R1',
      url: 'ws://example.invalid/',
      kind: 'remote',
      addedAt: Date.now()
    }
    registry.add(remote, fakeLocalTransport())
    expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)

    registry.remove('remote-1')

    expect(registry.has('remote-1')).toBe(false)
    expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
  })
})

describe('hydrateRemoteBackend on failed connect', () => {
  it('removes the registry entry after a WS connect failure', async () => {
    const { port, close } = await rejectingServer()
    try {
      const { registry } = makeRegistry()
      const remote: BackendConnection = {
        id: 'remote-1',
        label: 'R1',
        url: `ws://127.0.0.1:${port}/`,
        kind: 'remote',
        addedAt: Date.now()
      }

      // Subclass to inject the Node ws ctor without touching production
      // signatures (browser code passes the real global WebSocket).
      class WSWithNode extends WebSocketClientTransport {
        constructor(opts: ConstructorParameters<typeof WebSocketClientTransport>[0]) {
          super({
            ...opts,
            initialBackoffMs: 5_000,
            maxBackoffMs: 5_000,
            WebSocketCtor: WSClient as unknown as typeof WebSocket
          })
        }
      }

      await hydrateRemoteBackend(remote, {
        registry,
        backend: { connectionsGetToken: async () => 'tok' },
        WSCtor: WSWithNode
      })

      expect(registry.has('remote-1')).toBe(false)
    } finally {
      await close()
    }
  })

  it('falls back to LOCAL_BACKEND_ID when the failed remote had been set active', async () => {
    // The full bug repro: the outer loop pins active at the saved id
    // (which the in-flight hydrate has already added) before hydrate's
    // await connect() rejects. After the catch fires, active must be
    // back to local so App.tsx reads the local store's repoRoots and
    // skips the onboarding gate.
    const { port, close } = await rejectingServer()
    try {
      const { registry } = makeRegistry()
      const remote: BackendConnection = {
        id: 'remote-1',
        label: 'R1',
        url: `ws://127.0.0.1:${port}/`,
        kind: 'remote',
        addedAt: Date.now()
      }

      class WSWithNode extends WebSocketClientTransport {
        constructor(opts: ConstructorParameters<typeof WebSocketClientTransport>[0]) {
          super({
            ...opts,
            initialBackoffMs: 5_000,
            maxBackoffMs: 5_000,
            WebSocketCtor: WSClient as unknown as typeof WebSocket
          })
        }
      }

      const hydratePromise = hydrateRemoteBackend(remote, {
        registry,
        backend: { connectionsGetToken: async () => 'tok' },
        WSCtor: WSWithNode
      })

      // Mimic the outer loop: after the token fetch resolves (the
      // microtask above), registry.has('remote-1') is true, so the
      // bootstrapper calls setActive. Yield twice so the token promise
      // settles and registry.add has run.
      await Promise.resolve()
      await Promise.resolve()
      if (registry.has('remote-1')) {
        registry.setActive('remote-1')
        expect(registry.getActiveId()).toBe('remote-1')
      }

      await hydratePromise

      expect(registry.has('remote-1')).toBe(false)
      expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
    } finally {
      await close()
    }
  })
})
