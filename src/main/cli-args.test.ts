import { describe, it, expect } from 'vitest'
import { parseCliFlags } from './cli-args'

describe('parseCliFlags', () => {
  it('parses --port with space-separated value', () => {
    const r = parseCliFlags(['--port', '8080'])
    expect(r).toEqual({
      kind: 'ok',
      flags: { port: 8080, showHelp: false, showVersion: false }
    })
  })

  it('parses --port with equals-separated value', () => {
    const r = parseCliFlags(['--port=8080'])
    expect(r).toEqual({
      kind: 'ok',
      flags: { port: 8080, showHelp: false, showVersion: false }
    })
  })

  it('parses --port 0 (ephemeral)', () => {
    const r = parseCliFlags(['--port', '0'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.flags.port).toBe(0)
  })

  it('parses --host and --port together', () => {
    const r = parseCliFlags(['--host', '0.0.0.0', '--port', '8080'])
    expect(r).toEqual({
      kind: 'ok',
      flags: {
        host: '0.0.0.0',
        port: 8080,
        showHelp: false,
        showVersion: false
      }
    })
  })

  it('parses --host=<value>', () => {
    const r = parseCliFlags(['--host=tailscale-ip'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.flags.host).toBe('tailscale-ip')
  })

  it('parses --help', () => {
    const r = parseCliFlags(['--help'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.flags.showHelp).toBe(true)
  })

  it('parses -h as alias for --help', () => {
    const r = parseCliFlags(['-h'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.flags.showHelp).toBe(true)
  })

  it('parses --version', () => {
    const r = parseCliFlags(['--version'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.flags.showVersion).toBe(true)
  })

  it('parses -v as alias for --version', () => {
    const r = parseCliFlags(['-v'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.flags.showVersion).toBe(true)
  })

  it('returns an error for unknown flags', () => {
    const r = parseCliFlags(['--unknown'])
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message).toContain('unknown option')
  })

  it('returns an error for unknown --foo=bar flags', () => {
    const r = parseCliFlags(['--foo=bar'])
    expect(r.kind).toBe('error')
  })

  it('returns an error for non-numeric --port', () => {
    const r = parseCliFlags(['--port', 'abc'])
    expect(r.kind).toBe('error')
  })

  it('returns an error for out-of-range --port', () => {
    const r = parseCliFlags(['--port', '99999'])
    expect(r.kind).toBe('error')
  })

  it('returns an error when --port has no value', () => {
    const r = parseCliFlags(['--port'])
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message).toContain('missing value')
  })

  it('returns an error when --host has no value', () => {
    const r = parseCliFlags(['--host'])
    expect(r.kind).toBe('error')
  })

  it('returns defaults for empty argv', () => {
    const r = parseCliFlags([])
    expect(r).toEqual({
      kind: 'ok',
      flags: { showHelp: false, showVersion: false }
    })
  })
})
