import { describe, it, expect, vi } from 'vitest'
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
