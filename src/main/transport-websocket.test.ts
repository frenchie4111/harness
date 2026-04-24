// Server-side smoke test for the WebSocket transport.
//
// Drives the server with a raw `ws` client so this test stays inside
// main's tsconfig project and doesn't have to reach into renderer/.
// The client class has its own test in src/renderer/.

import { describe, it, expect, vi } from 'vitest'
import { WebSocket as WSClient } from 'ws'
import { Store } from './store'
import { WebSocketServerTransport } from './transport-websocket'
import { rootReducer, initialState, type AppState, type StateEvent } from '../shared/state'

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
    server.onRequest('echo', async (_ctx, ...args: unknown[]) => ({ args }))

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
      expect(signalSpy).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: expect.any(String) }),
        'term-1',
        'ls\n'
      )

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

  // Regression guard for the tmux-style take-control flow. Two clients
  // share a terminal; the second clicks "take control". Both clients'
  // state mirrors must see the new controllerClientId so their UIs can
  // derive the right "Spectating"/"Take control" affordance — a bug on
  // either side left the UI stuck on the pre-click controller (#20
  // follow-up). We wire real client sockets + rootReducer mirrors here
  // so the whole dispatch → broadcast → reducer path is covered, not
  // just the slice reducer in isolation.
  it('broadcasts terminals/controlTaken to every connected client mirror', async () => {
    const store = new Store()
    const port = randomPort()
    const server = new WebSocketServerTransport(store, { port, token: 'secret' })
    server.start()
    // Wire the same handlers main/index.ts registers for the control flow.
    server.onSignal('terminal:join', (ctx, id: unknown) => {
      store.dispatch({
        type: 'terminals/clientJoined',
        payload: { terminalId: id as string, clientId: ctx.clientId }
      })
    })
    server.onSignal(
      'terminal:takeControl',
      (ctx, id: unknown, cols: unknown, rows: unknown) => {
        store.dispatch({
          type: 'terminals/controlTaken',
          payload: {
            terminalId: id as string,
            clientId: ctx.clientId,
            cols: cols as number,
            rows: rows as number
          }
        })
      }
    )
    await new Promise((r) => setTimeout(r, 25))

    const wsA = new WSClient(`ws://127.0.0.1:${port}?token=secret`)
    const wsB = new WSClient(`ws://127.0.0.1:${port}?token=secret`)
    await Promise.all([waitOpen(wsA), waitOpen(wsB)])

    // Each socket maintains its own mirror via the shared rootReducer —
    // matches how the renderer applies state:event messages.
    let mirrorA: AppState = initialState
    let mirrorB: AppState = initialState
    wsA.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as AnyFrame
      if (frame.t === 'state') {
        mirrorA = rootReducer(mirrorA, frame.event as StateEvent)
      }
    })
    wsB.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as AnyFrame
      if (frame.t === 'state') {
        mirrorB = rootReducer(mirrorB, frame.event as StateEvent)
      }
    })

    try {
      wsA.send(JSON.stringify({ t: 'req', id: 'a', name: 'transport:getClientId', args: [] }))
      const resA = (await nextFrame(wsA, (f) => f.t === 'res' && (f as AnyFrame).id === 'a')) as AnyFrame
      const idA = (resA as unknown as { value: string }).value
      wsB.send(JSON.stringify({ t: 'req', id: 'b', name: 'transport:getClientId', args: [] }))
      const resB = (await nextFrame(wsB, (f) => f.t === 'res' && (f as AnyFrame).id === 'b')) as AnyFrame
      const idB = (resB as unknown as { value: string }).value
      expect(idA).not.toBe(idB)

      // A joins first → controller. B joins → spectator.
      wsA.send(JSON.stringify({ t: 'send', name: 'terminal:join', args: ['term-1'] }))
      await nextFrame(wsA, (f) => f.t === 'state' && (f as AnyFrame & { event: { type: string } }).event.type === 'terminals/clientJoined')
      wsB.send(JSON.stringify({ t: 'send', name: 'terminal:join', args: ['term-1'] }))
      await nextFrame(wsB, (f) => f.t === 'state' && (f as AnyFrame & { event: { type: string } }).event.type === 'terminals/clientJoined')
      await new Promise((r) => setTimeout(r, 25))

      expect(mirrorA.terminals.sessions['term-1'].controllerClientId).toBe(idA)
      expect(mirrorA.terminals.sessions['term-1'].spectatorClientIds).toEqual([idB])
      expect(mirrorB.terminals.sessions['term-1'].controllerClientId).toBe(idA)

      // B takes control.
      const aSawCtrl = nextFrame(wsA, (f) => f.t === 'state' && (f as AnyFrame & { event: { type: string } }).event.type === 'terminals/controlTaken')
      const bSawCtrl = nextFrame(wsB, (f) => f.t === 'state' && (f as AnyFrame & { event: { type: string } }).event.type === 'terminals/controlTaken')
      wsB.send(
        JSON.stringify({ t: 'send', name: 'terminal:takeControl', args: ['term-1', 80, 24] })
      )
      await Promise.all([aSawCtrl, bSawCtrl])
      await new Promise((r) => setTimeout(r, 25))

      // Authoritative store has the new controller.
      expect(store.getSnapshot().state.terminals.sessions['term-1'].controllerClientId).toBe(idB)
      // AND both client mirrors reflect it — this is what the UI reads.
      expect(mirrorA.terminals.sessions['term-1'].controllerClientId).toBe(idB)
      expect(mirrorA.terminals.sessions['term-1'].spectatorClientIds).toEqual([idA])
      expect(mirrorB.terminals.sessions['term-1'].controllerClientId).toBe(idB)
      expect(mirrorB.terminals.sessions['term-1'].spectatorClientIds).toEqual([idA])
      expect(mirrorA.terminals.sessions['term-1'].size).toEqual({ cols: 80, rows: 24 })
      expect(mirrorB.terminals.sessions['term-1'].size).toEqual({ cols: 80, rows: 24 })
    } finally {
      wsA.close()
      wsB.close()
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
