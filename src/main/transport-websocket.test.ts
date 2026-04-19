// Server-side smoke test for the WebSocket transport.
//
// Drives the server with a raw `ws` client so this test stays inside
// main's tsconfig project and doesn't have to reach into renderer/.
// The client class has its own test in src/renderer/.

import { describe, it, expect, vi } from 'vitest'
import { WebSocket as WSClient } from 'ws'
import { Store } from './store'
import { WebSocketServerTransport } from './transport-websocket'

type AnyFrame = { t: string } & Record<string, unknown>

function waitOpen(ws: WSClient): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

function nextFrame(ws: WSClient, match: (f: AnyFrame) => boolean): Promise<AnyFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('frame timeout')), 1500)
    const onMessage = (raw: unknown): void => {
      try {
        const data = raw instanceof Buffer ? raw.toString() : String(raw)
        const frame = JSON.parse(data) as AnyFrame
        if (match(frame)) {
          clearTimeout(timeout)
          ws.off('message', onMessage)
          resolve(frame)
        }
      } catch {
        // keep listening
      }
    }
    ws.on('message', onMessage)
  })
}

function randomPort(): number {
  return 40000 + Math.floor(Math.random() * 20000)
}

describe('WebSocketServerTransport', () => {
  it('rejects clients without a valid token', async () => {
    const store = new Store()
    const port = randomPort()
    const server = new WebSocketServerTransport(store, { port, token: 'secret' })
    server.start()
    await new Promise((r) => setTimeout(r, 25))

    const ws = new WSClient(`ws://127.0.0.1:${port}?token=wrong`)
    await expect(waitOpen(ws)).rejects.toBeTruthy()
    server.stop()
  })

  it('handles snapshot requests, state events, RPC, and client signals', async () => {
    const store = new Store()
    const port = randomPort()
    const server = new WebSocketServerTransport(store, { port, token: 'secret' })
    server.start()
    await new Promise((r) => setTimeout(r, 25))

    const signalSpy = vi.fn()
    server.onSignal('pty:write', signalSpy)
    server.onRequest('echo', async (...args: unknown[]) => ({ args }))

    const ws = new WSClient(`ws://127.0.0.1:${port}?token=secret`)
    await waitOpen(ws)

    try {
      // Snapshot request
      ws.send(JSON.stringify({ t: 'snapreq', id: '1' }))
      const snap = (await nextFrame(ws, (f) => f.t === 'snapres' && f.id === '1')) as unknown as {
        t: 'snapres'
        ok: boolean
        snapshot: { seq: number; state: { settings: { theme: string } } }
      }
      expect(snap.ok).toBe(true)
      expect(snap.snapshot.seq).toBe(0)
      expect(snap.snapshot.state.settings.theme).toBe('dark')

      // State event push
      const eventPromise = nextFrame(ws, (f) => f.t === 'state')
      store.dispatch({ type: 'settings/themeChanged', payload: 'solarized' })
      const ev = (await eventPromise) as unknown as {
        event: { type: string; payload: string }
        seq: number
      }
      expect(ev.event.type).toBe('settings/themeChanged')
      expect(ev.event.payload).toBe('solarized')
      expect(ev.seq).toBe(1)

      // RPC round-trip
      ws.send(JSON.stringify({ t: 'req', id: '2', name: 'echo', args: ['hi', 42] }))
      const resp = (await nextFrame(ws, (f) => f.t === 'res' && f.id === '2')) as unknown as {
        ok: boolean
        value: { args: unknown[] }
      }
      expect(resp.ok).toBe(true)
      expect(resp.value.args).toEqual(['hi', 42])

      // Client-origin signal
      ws.send(
        JSON.stringify({ t: 'send', name: 'pty:write', args: ['term-1', 'ls\n'] })
      )
      await new Promise((r) => setTimeout(r, 25))
      expect(signalSpy).toHaveBeenCalledWith('term-1', 'ls\n')

      // Server-origin signal reaches the client
      const sigPromise = nextFrame(ws, (f) => f.t === 'sig')
      server.sendSignal('terminal:data', 'term-1', 'hello')
      const sig = (await sigPromise) as unknown as { name: string; args: unknown[] }
      expect(sig.name).toBe('terminal:data')
      expect(sig.args).toEqual(['term-1', 'hello'])
    } finally {
      ws.close()
      server.stop()
    }
  })

  it('returns an error frame for unknown request names', async () => {
    const store = new Store()
    const port = randomPort()
    const server = new WebSocketServerTransport(store, { port, token: 'secret' })
    server.start()
    await new Promise((r) => setTimeout(r, 25))

    const ws = new WSClient(`ws://127.0.0.1:${port}?token=secret`)
    await waitOpen(ws)
    try {
      ws.send(JSON.stringify({ t: 'req', id: '9', name: 'nope', args: [] }))
      const resp = (await nextFrame(ws, (f) => f.t === 'res' && f.id === '9')) as unknown as {
        ok: boolean
        error: string
      }
      expect(resp.ok).toBe(false)
      expect(resp.error).toMatch(/no handler/)
    } finally {
      ws.close()
      server.stop()
    }
  })
})
