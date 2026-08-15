import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { SshTunnelManager, type TunnelEntry } from './ssh-tunnel-manager'

function fakeEntry(backendId: string): TunnelEntry & {
  ssh: { dispose: ReturnType<typeof vi.fn> }
  tunnelServer: { close: ReturnType<typeof vi.fn> }
} {
  const dispose = vi.fn()
  const close = vi.fn()
  return {
    backendId,
    localPort: 5000 + backendId.charCodeAt(0),
    remotePort: 37291,
    token: `tok-${backendId}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ssh: { dispose } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tunnelServer: { close } as any
  }
}

/** Entry backed by a real EventEmitter standing in for ssh2's Client,
 *  so drop detection can be driven by emitting the same events node-ssh
 *  sees. `connection` is nulled on close to mirror node-ssh, which is
 *  what makes `isConnected()` an honest liveness read. */
function liveEntry(backendId: string): TunnelEntry & {
  conn: EventEmitter
  ssh: { dispose: ReturnType<typeof vi.fn>; connection: EventEmitter | null }
} {
  const conn = new EventEmitter()
  const ssh = {
    connection: conn as EventEmitter | null,
    isConnected: (): boolean => ssh.connection != null,
    dispose: vi.fn(() => {
      ssh.connection = null
    })
  }
  conn.on('close', () => {
    ssh.connection = null
  })
  return {
    backendId,
    localPort: 6000,
    remotePort: 37291,
    token: `tok-${backendId}`,
    conn,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ssh: ssh as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tunnelServer: { close: vi.fn() } as any
  }
}

describe('SshTunnelManager', () => {
  it('register + has + get', () => {
    const mgr = new SshTunnelManager()
    expect(mgr.has('a')).toBe(false)
    const entry = fakeEntry('a')
    mgr.register(entry)
    expect(mgr.has('a')).toBe(true)
    expect(mgr.get('a')).toBe(entry)
  })

  it('re-registering the same backendId closes the old entry', () => {
    const mgr = new SshTunnelManager()
    const old = fakeEntry('a')
    const fresh = fakeEntry('a')
    mgr.register(old)
    mgr.register(fresh)
    expect(old.ssh.dispose).toHaveBeenCalledTimes(1)
    expect(old.tunnelServer.close).toHaveBeenCalledTimes(1)
    expect(mgr.get('a')).toBe(fresh)
  })

  it('unregister tears down the SSH + tunnel server', () => {
    const mgr = new SshTunnelManager()
    const entry = fakeEntry('a')
    mgr.register(entry)
    expect(mgr.unregister('a')).toBe(true)
    expect(entry.ssh.dispose).toHaveBeenCalledTimes(1)
    expect(entry.tunnelServer.close).toHaveBeenCalledTimes(1)
    expect(mgr.has('a')).toBe(false)
  })

  it('unregister returns false for unknown id', () => {
    const mgr = new SshTunnelManager()
    expect(mgr.unregister('missing')).toBe(false)
  })

  it('closeAll disposes every entry and empties the map', () => {
    const mgr = new SshTunnelManager()
    const a = fakeEntry('a')
    const b = fakeEntry('b')
    mgr.register(a)
    mgr.register(b)
    mgr.closeAll()
    expect(a.ssh.dispose).toHaveBeenCalledTimes(1)
    expect(b.ssh.dispose).toHaveBeenCalledTimes(1)
    expect(mgr.has('a')).toBe(false)
    expect(mgr.has('b')).toBe(false)
  })

  it('buildLocalUrl returns the loopback URL with the token', () => {
    const mgr = new SshTunnelManager()
    const entry = fakeEntry('a')
    mgr.register(entry)
    expect(mgr.buildLocalUrl('a')).toBe(`ws://127.0.0.1:${entry.localPort}/?token=${entry.token}`)
  })

  it('buildLocalUrl returns null when backendId is unknown', () => {
    const mgr = new SshTunnelManager()
    expect(mgr.buildLocalUrl('missing')).toBeNull()
  })

  describe('drop detection', () => {
    it('fires onDropped when the ssh link closes on its own', () => {
      const onDropped = vi.fn()
      const mgr = new SshTunnelManager({ onDropped })
      const entry = liveEntry('a')
      mgr.register(entry)
      entry.conn.emit('close')
      expect(onDropped).toHaveBeenCalledExactlyOnceWith('a')
    })

    it('fires at most once even when end and close both arrive', () => {
      const onDropped = vi.fn()
      const mgr = new SshTunnelManager({ onDropped })
      const entry = liveEntry('a')
      mgr.register(entry)
      entry.conn.emit('end')
      entry.conn.emit('close')
      expect(onDropped).toHaveBeenCalledTimes(1)
    })

    it('does NOT fire onDropped when we tear the tunnel down ourselves', () => {
      const onDropped = vi.fn()
      const mgr = new SshTunnelManager({ onDropped })
      const entry = liveEntry('a')
      mgr.register(entry)
      mgr.unregister('a')
      // A real ssh2 client emits close as part of dispose; the manager
      // must not mistake its own teardown for an unexpected drop and
      // schedule a reconnect for a backend the user just removed.
      entry.conn.emit('close')
      expect(onDropped).not.toHaveBeenCalled()
    })

    it('does NOT fire onDropped on closeAll (app quit)', () => {
      const onDropped = vi.fn()
      const mgr = new SshTunnelManager({ onDropped })
      const entry = liveEntry('a')
      mgr.register(entry)
      mgr.closeAll()
      entry.conn.emit('close')
      expect(onDropped).not.toHaveBeenCalled()
    })

    it('a replaced registration cannot drop the tunnel that superseded it', () => {
      const onDropped = vi.fn()
      const mgr = new SshTunnelManager({ onDropped })
      const old = liveEntry('a')
      mgr.register(old)
      const fresh = liveEntry('a')
      mgr.register(fresh)
      old.conn.emit('close')
      expect(onDropped).not.toHaveBeenCalled()
      fresh.conn.emit('close')
      expect(onDropped).toHaveBeenCalledExactlyOnceWith('a')
    })

    it('swallows post-ready error events instead of letting Node rethrow them', () => {
      // node-ssh removes its own handshake error listener once the
      // connection is ready, so without ours an ssh2 'error' event has
      // zero listeners — which EventEmitter turns into a throw.
      const mgr = new SshTunnelManager({ onDropped: vi.fn() })
      const entry = liveEntry('a')
      mgr.register(entry)
      expect(() => entry.conn.emit('error', new Error('read ECONNRESET'))).not.toThrow()
    })

    it('detaches its listeners on unregister', () => {
      const mgr = new SshTunnelManager({ onDropped: vi.fn() })
      const entry = liveEntry('a')
      mgr.register(entry)
      expect(entry.conn.listenerCount('close')).toBeGreaterThan(0)
      mgr.unregister('a')
      // The 'close' listener the fake itself installed stays; the
      // manager's must be gone.
      expect(entry.conn.listenerCount('end')).toBe(0)
      expect(entry.conn.listenerCount('error')).toBe(0)
    })

    it('tolerates entries with no underlying ssh2 connection', () => {
      const mgr = new SshTunnelManager({ onDropped: vi.fn() })
      expect(() => mgr.register(fakeEntry('a'))).not.toThrow()
      expect(() => mgr.unregister('a')).not.toThrow()
    })
  })

  describe('isAlive', () => {
    it('is true for a live link and false once it closes', () => {
      const mgr = new SshTunnelManager()
      const entry = liveEntry('a')
      mgr.register(entry)
      expect(mgr.isAlive('a')).toBe(true)
      entry.conn.emit('close')
      expect(mgr.isAlive('a')).toBe(false)
    })

    it('is false for an unknown backend', () => {
      expect(new SshTunnelManager().isAlive('missing')).toBe(false)
    })

    it('assumes alive when the client exposes no isConnected', () => {
      const mgr = new SshTunnelManager()
      mgr.register(fakeEntry('a'))
      expect(mgr.isAlive('a')).toBe(true)
    })
  })

  it('dispose errors are swallowed (does not throw on shutdown)', () => {
    const mgr = new SshTunnelManager()
    const entry = fakeEntry('a')
    entry.ssh.dispose.mockImplementation(() => {
      throw new Error('already disposed')
    })
    entry.tunnelServer.close.mockImplementation(() => {
      throw new Error('already closed')
    })
    mgr.register(entry)
    expect(() => mgr.unregister('a')).not.toThrow()
  })
})
