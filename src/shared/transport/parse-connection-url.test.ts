import { describe, it, expect } from 'vitest'
import { parseConnectionUrl, suggestLabelFromUrl } from './parse-connection-url'

describe('parseConnectionUrl', () => {
  it('accepts the http://host:port/?token=... format Settings displays', () => {
    const r = parseConnectionUrl('http://build-box.local:37291/?token=abc123')
    if (!r.ok) throw new Error(r.error)
    expect(r.parsed.wsUrl).toBe('ws://build-box.local:37291/')
    expect(r.parsed.token).toBe('abc123')
    expect(r.parsed.storedUrl).toBe('ws://build-box.local:37291/')
  })

  it('maps https → wss', () => {
    const r = parseConnectionUrl('https://harness.example.com/?token=xyz')
    if (!r.ok) throw new Error(r.error)
    expect(r.parsed.wsUrl.startsWith('wss://')).toBe(true)
  })

  it('accepts ws:// directly', () => {
    const r = parseConnectionUrl('ws://127.0.0.1:8080/?token=t')
    if (!r.ok) throw new Error(r.error)
    expect(r.parsed.wsUrl).toBe('ws://127.0.0.1:8080/')
  })

  it('accepts wss:// directly', () => {
    const r = parseConnectionUrl('wss://harness.example/?token=t')
    if (!r.ok) throw new Error(r.error)
    expect(r.parsed.wsUrl.startsWith('wss://')).toBe(true)
  })

  it('strips the token from the persisted url', () => {
    const r = parseConnectionUrl('http://h:1/?token=secret')
    if (!r.ok) throw new Error(r.error)
    expect(r.parsed.storedUrl).not.toContain('secret')
    expect(r.parsed.storedUrl).not.toContain('token')
  })

  it('preserves the wss prefix in the persisted url for https inputs', () => {
    const r = parseConnectionUrl('https://harness.example/?token=t')
    if (!r.ok) throw new Error(r.error)
    expect(r.parsed.storedUrl).toBe('wss://harness.example/')
  })

  it('rejects empty input', () => {
    const r = parseConnectionUrl('   ')
    expect(r.ok).toBe(false)
  })

  it('rejects malformed URLs', () => {
    const r = parseConnectionUrl('not a url')
    expect(r.ok).toBe(false)
  })

  it('rejects unsupported protocols', () => {
    const r = parseConnectionUrl('ftp://h:1/?token=t')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/protocol/i)
  })

  it('rejects URLs without a token', () => {
    const r = parseConnectionUrl('http://h:1/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/token/i)
  })

  it('preserves trailing path segments', () => {
    const r = parseConnectionUrl('http://h:1/some/path?token=t')
    if (!r.ok) throw new Error(r.error)
    expect(r.parsed.wsUrl).toBe('ws://h:1/some/path')
  })
})

describe('suggestLabelFromUrl', () => {
  it('uses the first dotted segment of the host', () => {
    const r = parseConnectionUrl('http://build-box.local:37291/?token=t')
    if (!r.ok) throw new Error(r.error)
    expect(suggestLabelFromUrl(r.parsed)).toBe('build-box')
  })

  it('returns "Backend" for localhost', () => {
    const r = parseConnectionUrl('http://localhost:37291/?token=t')
    if (!r.ok) throw new Error(r.error)
    expect(suggestLabelFromUrl(r.parsed)).toBe('Backend')
  })

  it('returns "Backend" for 127.0.0.1', () => {
    const r = parseConnectionUrl('http://127.0.0.1:37291/?token=t')
    if (!r.ok) throw new Error(r.error)
    expect(suggestLabelFromUrl(r.parsed)).toBe('Backend')
  })

  it('caps long hostnames', () => {
    const r = parseConnectionUrl(
      'http://this-is-a-really-really-long-hostname-segment.example.com/?token=t'
    )
    if (!r.ok) throw new Error(r.error)
    const label = suggestLabelFromUrl(r.parsed)
    expect(label.length).toBeLessThanOrEqual(24)
  })
})
