import { describe, it, expect } from 'vitest'
import { parseSshConfigText } from './ssh-config'

describe('parseSshConfigText', () => {
  it('returns empty for empty input', () => {
    expect(parseSshConfigText('')).toEqual([])
  })

  it('parses a single Host block', () => {
    const text = `
Host build-box
  HostName build-box.local
  User mike
  Port 22
  IdentityFile ~/.ssh/id_ed25519
`
    expect(parseSshConfigText(text)).toEqual([
      {
        alias: 'build-box',
        host: 'build-box.local',
        user: 'mike',
        port: 22,
        identityFile: '~/.ssh/id_ed25519'
      }
    ])
  })

  it('falls back to alias when HostName is absent', () => {
    const text = `
Host bare
  User mike
`
    expect(parseSshConfigText(text)).toEqual([
      { alias: 'bare', host: 'bare', user: 'mike' }
    ])
  })

  it('skips wildcard hosts', () => {
    const text = `
Host *
  User mike
  IdentityFile ~/.ssh/id_ed25519

Host *.internal
  Port 2222

Host build-box
  HostName build-box.local
`
    const hosts = parseSshConfigText(text)
    expect(hosts.map((h) => h.alias)).toEqual(['build-box'])
  })

  it('expands multi-alias Host lines into separate entries', () => {
    const text = `
Host build-box dev-box
  HostName 10.0.0.5
  User mike
`
    const hosts = parseSshConfigText(text)
    expect(hosts).toHaveLength(2)
    expect(hosts[0]).toMatchObject({ alias: 'build-box', host: '10.0.0.5', user: 'mike' })
    expect(hosts[1]).toMatchObject({ alias: 'dev-box', host: '10.0.0.5', user: 'mike' })
  })

  it('inherits Host * defaults via compute()', () => {
    const text = `
Host *
  User defaultuser
  Port 2200

Host build-box
  HostName build-box.local
`
    const [box] = parseSshConfigText(text)
    expect(box.user).toBe('defaultuser')
    expect(box.port).toBe(2200)
  })

  it('per-host User wins when listed before Host * (OpenSSH first-match-wins)', () => {
    const text = `
Host build-box
  HostName build-box.local
  User mike

Host *
  User defaultuser
`
    const [box] = parseSshConfigText(text)
    expect(box.user).toBe('mike')
  })

  it('omits port when non-numeric', () => {
    const text = `
Host weird
  HostName weird.local
  Port nonsense
`
    const [host] = parseSshConfigText(text)
    expect(host.port).toBeUndefined()
  })

  it('returns empty on malformed config (does not throw)', () => {
    // ssh-config is permissive — feed it garbage and it just returns no
    // sections. The important contract is that we never throw.
    expect(() => parseSshConfigText('this is not really ssh config')).not.toThrow()
  })
})
