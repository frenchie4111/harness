import { describe, expect, it } from 'vitest'
import { findRemoteUrl, splitRemoteUrl } from './find-remote-url'

describe('findRemoteUrl', () => {
  it('returns the value after --harness-remote-url=', () => {
    expect(findRemoteUrl(['--harness-remote-url=ws://x:1?token=t'])).toBe(
      'ws://x:1?token=t'
    )
  })

  it('returns null when the flag is absent', () => {
    expect(findRemoteUrl([])).toBeNull()
    expect(findRemoteUrl(['--something-else=foo', '/bin/electron'])).toBeNull()
  })

  it('returns null when the flag has no value', () => {
    expect(findRemoteUrl(['--harness-remote-url='])).toBeNull()
  })

  it('finds the flag among many argv entries', () => {
    const argv = [
      '/Applications/Harness.app/Contents/MacOS/Harness',
      '--enable-features=foo',
      '--harness-remote-url=wss://host:443?token=abc',
      '--more=stuff'
    ]
    expect(findRemoteUrl(argv)).toBe('wss://host:443?token=abc')
  })

  it('takes the first match if the flag appears more than once', () => {
    expect(
      findRemoteUrl(['--harness-remote-url=first', '--harness-remote-url=second'])
    ).toBe('first')
  })
})

describe('splitRemoteUrl', () => {
  it('separates the token from the URL query string', () => {
    const result = splitRemoteUrl('ws://100.1.2.3:37291/?token=abc123')
    expect(result).toEqual({ url: 'ws://100.1.2.3:37291/', token: 'abc123' })
  })

  it('preserves other query params untouched', () => {
    const result = splitRemoteUrl('ws://h:1/path?token=t&foo=bar')
    expect(result?.token).toBe('t')
    expect(result?.url).toContain('foo=bar')
    expect(result?.url).not.toContain('token=')
  })

  it('returns an empty token when the query param is absent', () => {
    expect(splitRemoteUrl('ws://h:1/')).toEqual({ url: 'ws://h:1/', token: '' })
  })

  it('returns null for a malformed URL', () => {
    expect(splitRemoteUrl('not a url')).toBeNull()
  })

  it('handles wss:// the same as ws://', () => {
    const result = splitRemoteUrl('wss://h:8443/?token=tok')
    expect(result).toEqual({ url: 'wss://h:8443/', token: 'tok' })
  })
})
