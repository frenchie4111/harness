// Regression test for the crash that took the main process down when an
// SSH tunnel's link died.
//
// node-ssh's `forwardOut` is not an async function — it calls
// getConnection() synchronously before building its Promise, and that
// throws `Error('Not connected to server')` on a dead link. The old
// handler only had a `.catch()`, which never runs when no promise was
// created, so the throw escaped the net.Server connection listener and
// became an uncaughtException. The fake below reproduces exactly that
// shape.

import { describe, it, expect, vi } from 'vitest'
import { createServer, connect, type Server } from 'net'
import type { NodeSSH } from 'node-ssh'
import { createForwardHandler } from './ssh-bootstrap'

/** Mirrors node-ssh's real failure mode: throws synchronously, never
 *  returns a promise. */
const deadSsh = {
  forwardOut: () => {
    throw new Error('Not connected to server')
  }
} as unknown as Pick<NodeSSH, 'forwardOut'>

function fakeSocket(): { destroy: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } {
  return { destroy: vi.fn(), on: vi.fn() }
}

describe('createForwardHandler', () => {
  it('does not throw when forwardOut throws synchronously', () => {
    const handler = createForwardHandler(deadSsh, 1234)
    const local = fakeSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => handler(local as any)).not.toThrow()
    expect(local.destroy).toHaveBeenCalledTimes(1)
  })

  it('reports the synchronous failure through onForwardError', () => {
    const onForwardError = vi.fn()
    const handler = createForwardHandler(deadSsh, 1234, onForwardError)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler(fakeSocket() as any)
    expect(onForwardError).toHaveBeenCalledTimes(1)
    expect((onForwardError.mock.calls[0][0] as Error).message).toBe('Not connected to server')
  })

  it('destroys the socket when forwardOut rejects asynchronously', async () => {
    const rejecting = {
      forwardOut: () => Promise.reject(new Error('channel open failure'))
    } as unknown as Pick<NodeSSH, 'forwardOut'>
    const onForwardError = vi.fn()
    const handler = createForwardHandler(rejecting, 1234, onForwardError)
    const local = fakeSocket()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler(local as any)
    await new Promise((r) => setImmediate(r))
    expect(onForwardError).toHaveBeenCalledTimes(1)
    expect(local.destroy).toHaveBeenCalledTimes(1)
  })

  // End-to-end proof that a real accepted connection on a dead tunnel no
  // longer reaches process-level uncaughtException. Without the fix the
  // throw propagates out of the net.Server 'connection' emit and Node
  // routes it here.
  it('a real socket hitting a dead tunnel produces no uncaughtException', async () => {
    const uncaught = vi.fn()
    // Vitest installs its own uncaughtException handlers; prepending ours
    // means we observe the event without disturbing them.
    process.prependListener('uncaughtException', uncaught)
    let server: Server | null = null
    try {
      server = createServer(createForwardHandler(deadSsh, 1234))
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0

      await new Promise<void>((resolve) => {
        const client = connect(port, '127.0.0.1', () => client.write('GET / HTTP/1.1\r\n\r\n'))
        client.on('error', () => resolve())
        client.on('close', () => resolve())
      })
      await new Promise((r) => setTimeout(r, 50))

      expect(uncaught).not.toHaveBeenCalled()
    } finally {
      process.removeListener('uncaughtException', uncaught)
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    }
  })
})
