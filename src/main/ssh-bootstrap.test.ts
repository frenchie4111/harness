import { describe, it, expect } from 'vitest'
import { parseSshTarget, newBootstrapId } from './ssh-bootstrap'

describe('parseSshTarget', () => {
  it('parses bare hostname', () => {
    expect(parseSshTarget('build-box')).toEqual({
      raw: 'build-box',
      host: 'build-box'
    })
  })

  it('parses user@host', () => {
    expect(parseSshTarget('mike@build-box')).toEqual({
      raw: 'mike@build-box',
      host: 'build-box',
      user: 'mike'
    })
  })

  it('parses user@host:port', () => {
    expect(parseSshTarget('mike@build-box:2222')).toEqual({
      raw: 'mike@build-box:2222',
      host: 'build-box',
      user: 'mike',
      port: 2222
    })
  })

  it('parses host:port without user', () => {
    expect(parseSshTarget('build-box:2200')).toEqual({
      raw: 'build-box:2200',
      host: 'build-box',
      port: 2200
    })
  })

  it('trims surrounding whitespace', () => {
    const t = parseSshTarget('  mike@build-box  ')
    expect(t.raw).toBe('mike@build-box')
    expect(t.host).toBe('build-box')
    expect(t.user).toBe('mike')
  })

  it('throws on empty input', () => {
    expect(() => parseSshTarget('')).toThrow()
    expect(() => parseSshTarget('   ')).toThrow()
  })
})

describe('newBootstrapId', () => {
  it('returns a uuid v4 string', () => {
    const id = newBootstrapId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('returns distinct ids', () => {
    const ids = new Set([newBootstrapId(), newBootstrapId(), newBootstrapId()])
    expect(ids.size).toBe(3)
  })
})
