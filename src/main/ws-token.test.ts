import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./secrets', () => ({
  getSecret: (key: string) => store.get(key) ?? null,
  setSecret: (key: string, value: string) => {
    store.set(key, value)
  }
}))

import { getOrCreateWsToken, rotateWsToken } from './ws-token'

beforeEach(() => {
  store.clear()
})

describe('ws-token', () => {
  it('generates and persists a token on first call', () => {
    const t = getOrCreateWsToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(store.get('wsAuthToken')).toBe(t)
  })

  it('returns the same token on subsequent calls (survives reboots)', () => {
    const a = getOrCreateWsToken()
    const b = getOrCreateWsToken()
    expect(a).toBe(b)
  })

  it('rotateWsToken replaces the stored token', () => {
    const a = getOrCreateWsToken()
    const b = rotateWsToken()
    expect(b).not.toBe(a)
    expect(getOrCreateWsToken()).toBe(b)
  })
})
