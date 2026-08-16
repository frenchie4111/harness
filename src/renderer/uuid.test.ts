import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from './uuid'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const real = globalThis.crypto

afterEach(() => {
  Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true })
})

function stubCrypto(value: unknown): void {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true })
}

describe('randomUUID', () => {
  it('returns a v4 uuid when crypto.randomUUID exists', () => {
    expect(randomUUID()).toMatch(V4)
  })

  it('falls back to getRandomValues in a non-secure context', () => {
    stubCrypto({ getRandomValues: real.getRandomValues.bind(real) })
    const ids = new Set(Array.from({ length: 50 }, () => randomUUID()))
    for (const id of ids) expect(id).toMatch(V4)
    expect(ids.size).toBe(50)
  })

  it('falls back to Math.random when crypto is unavailable', () => {
    stubCrypto(undefined)
    expect(randomUUID()).toMatch(V4)
  })
})
