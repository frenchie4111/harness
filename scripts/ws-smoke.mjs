#!/usr/bin/env node
// Manual smoke test for the WS transport.
//
// Usage:
//   1. Start Harness with the WS transport on: HARNESS_WS_TRANSPORT=1 npm run dev
//   2. Copy the token the main process logs to stdout.
//   3. node scripts/ws-smoke.mjs <token> [port]
//
// Validates: connect → snapshot → one state event roundtrip → disconnect.
// Doesn't exercise anything else; for deeper validation, use the running
// renderer itself (which speaks the same protocol over ws once enabled).

import { WebSocket } from 'ws'

const token = process.argv[2]
const port = Number(process.argv[3] ?? 37291)
if (!token) {
  console.error('usage: node scripts/ws-smoke.mjs <token> [port]')
  process.exit(1)
}

const url = `ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`
const ws = new WebSocket(url)

let nextId = 1
const pending = new Map()

ws.on('open', () => {
  console.log('connected')
  const id = String(nextId++)
  pending.set(id, 'snapshot')
  ws.send(JSON.stringify({ t: 'snapreq', id }))
})

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString())
  if (frame.t === 'snapres') {
    const kind = pending.get(frame.id)
    pending.delete(frame.id)
    if (kind === 'snapshot') {
      console.log('snapshot seq=%d theme=%s repos=%d',
        frame.snapshot.seq,
        frame.snapshot.state.settings.theme,
        (frame.snapshot.state.worktrees.repoRoots ?? []).length
      )
      console.log('listening for state events for 5s…')
      setTimeout(() => {
        ws.close()
        process.exit(0)
      }, 5000)
    }
    return
  }
  if (frame.t === 'state') {
    console.log('state event:', frame.event.type, 'seq=', frame.seq)
    return
  }
  if (frame.t === 'sig') {
    console.log('signal:', frame.name)
    return
  }
})

ws.on('error', (err) => {
  console.error('ws error:', err.message)
  process.exit(1)
})

ws.on('close', (code) => {
  console.log('closed code=%d', code)
})
