import { describe, it, expect } from 'vitest'
import { formatWorktreeAge } from './worktree-detail'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = 1_700_000_000_000

describe('formatWorktreeAge', () => {
  it('returns em-dash when createdAt is missing', () => {
    expect(formatWorktreeAge(0, NOW)).toBe('—')
  })

  it('returns em-dash for clocks-in-the-future (negative age)', () => {
    expect(formatWorktreeAge(NOW + HOUR, NOW)).toBe('—')
  })

  it('returns <1h for anything under an hour', () => {
    expect(formatWorktreeAge(NOW - 30 * 60 * 1000, NOW)).toBe('<1h')
    expect(formatWorktreeAge(NOW - 59 * 60 * 1000 - 999, NOW)).toBe('<1h')
  })

  it('returns floored hours between 1h and 24h', () => {
    expect(formatWorktreeAge(NOW - HOUR, NOW)).toBe('1h')
    expect(formatWorktreeAge(NOW - 3 * HOUR, NOW)).toBe('3h')
    expect(formatWorktreeAge(NOW - 23 * HOUR, NOW)).toBe('23h')
  })

  it('returns floored days between 1d and one year', () => {
    expect(formatWorktreeAge(NOW - DAY, NOW)).toBe('1d')
    expect(formatWorktreeAge(NOW - 5 * DAY, NOW)).toBe('5d')
    expect(formatWorktreeAge(NOW - 364 * DAY, NOW)).toBe('364d')
  })

  it('switches to decimal-year format at >=365 days', () => {
    expect(formatWorktreeAge(NOW - 365 * DAY, NOW)).toBe('1.0y')
    expect(formatWorktreeAge(NOW - 540 * DAY, NOW)).toBe('1.5y')
    expect(formatWorktreeAge(NOW - 730 * DAY, NOW)).toBe('2.0y')
    expect(formatWorktreeAge(NOW - 1000 * DAY, NOW)).toBe('2.7y')
  })
})
