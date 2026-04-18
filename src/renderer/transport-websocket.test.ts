// Client-side smoke test. Spins up a stub WebSocket server with `ws`
// directly, connects the WebSocketClientTransport to it, and verifies
// the happy path: snapshot, state event, request, send, signal.
//
// Stays in renderer/ so the import of `transport-websocket` doesn't
// reach across tsconfig projects.

import { describe, it, expect, vi } from 'vitest'
import { WebSocketServer, WebSocket as WSClient, type WebSocket as WSType } from 'ws'
import type { StateSnapshot } from '../shared/state'
import { initialState } from '../shared/state'
import { WebSocketClientTransport } from './transport-websocket'

interface StubFrameHandler {
  onReq?: (id: string, name: string, args: unknown[], ws: WSType) => void
  onSend?: (name: string, args: unknown[]) => void
  onConnection?: (ws: WSType) => void
}

function startStubServer(
  token: string,
  handlers: StubFrameHandler
): Promise<{ port: number; server: WebSocketServer }> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (info, cb) => {
        const url = new URL(info.req.url ?? '/', 'http://localhost')
        if (url.searchParams.get('token') !== token) {
          cb(false, 401, 'unauthorized')
          return
        }
        cb(true)
      }
    })
    server.on('listening', () => {
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve({ port: address.port, server })
      } else {
        reject(new Error('failed to bind stub ws server'))
      }
    })
    server.on('error', reject)
    server.on('connection', (ws) => {
      handlers.onConnection?.(ws as unknown as WSType)
      ws.on('message', (raw) => {
        try {
          const frame = JSON.parse(raw.toString()) as {
            t: string
            id?: string
            name?: string
            args?: unknown[]
          }
          if (frame.t === 'snapreq' && frame.id) {
            const snap: StateSnapshot = { state: initialState, seq: 0 }
            ws.send(JSON.stringify({ t: 'snapres', id: frame.id, ok: true, snapshot: snap }))
            return
          }
          if (frame.t === 'req' && frame.id && frame.name) {
            handlers.onReq?.(frame.id, frame.name, frame.args ?? [], ws as unknown as WSType)
            return
          }
          if (frame.t === 'send' && frame.name) {
            handlers.onSend?.(frame.name, frame.args ?? [])
            return
          }
        } catch {
          // ignore malformed
        }
      })
    })
  })
}

describe('WebSocketClientTransport', () => {
  it('connects, snapshot-fetches, and dispatches server state events', async () => {
    const token = 'test-token'
    const onSendSpy = vi.fn()
    let serverSocket: WSType | null = null
    const { port, server } = await startStubServer(token, {
      onSend: onSendSpy,
      onReq: (id, name, args, ws) => {
        if (name === 'double') {
          const n = (args[0] as number) * 2
          ws.send(JSON.stringify({ t: 'res', id, ok: true, value: n }))
        } else {
          ws.send(JSON.stringify({ t: 'res', id, ok: false, error: 'unknown' }))
        }
      },
      onConnection: (ws) => {
        serverSocket = ws
      }
    })

    const snapshots: StateSnapshot[] = []
    const client = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}`,
      token,
      onSnapshot: (s) => snapshots.push(s),
      WebSocketCtor: WSClient as unknown as typeof WebSocket
    })

    try {
      await client.connect()
      // give onSnapshot a beat to fire
      await new Promise((r) => setTimeout(r, 25))
      expect(snapshots.length).toBeGreaterThan(0)
      expect(snapshots[0].seq).toBe(0)

      const eventsReceived: Array<[string, number]> = []
      const unsub = client.onStateEvent((ev, seq) => {
        eventsReceived.push([ev.type, seq])
      })

      expect(serverSocket).not.toBeNull()
      serverSocket!.send(
        JSON.stringify({
          t: 'state',
          event: { type: 'settings/themeChanged', payload: 'dracula' },
          seq: 7
        })
      )
      await new Promise((r) => setTimeout(r, 25))
      expect(eventsReceived).toEqual([['settings/themeChanged', 7]])
      unsub()

      const result = await client.request('double', 21)
      expect(result).toBe(42)

      client.send('pty:write', 't-1', 'echo hi\n')
      await new Promise((r) => setTimeout(r, 25))
      expect(onSendSpy).toHaveBeenCalledWith('pty:write', ['t-1', 'echo hi\n'])

      const sigSpy = vi.fn()
      client.onSignal('terminal:data', sigSpy)
      serverSocket!.send(
        JSON.stringify({ t: 'sig', name: 'terminal:data', args: ['t-1', 'bytes'] })
      )
      await new Promise((r) => setTimeout(r, 25))
      expect(sigSpy).toHaveBeenCalledWith('t-1', 'bytes')

      const errResult = client.request('unknown-name')
      await expect(errResult).rejects.toThrow(/unknown/)
    } finally {
      client.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
