import { describe, it, expect, vi } from 'vitest'
import {
  currentPreventSleepStep,
  nextPreventSleepStep,
  advancePreventSleep,
  PREVENT_SLEEP_TEMPORARY_MS,
  type PreventSleepStep
} from './prevent-sleep'

function mockBackend() {
  return {
    setPreventSleepMode: vi.fn(async () => true),
    setPreventSleepUntil: vi.fn(async () => true)
  }
}

describe('currentPreventSleepStep', () => {
  it('returns the mode when no timer is set', () => {
    expect(currentPreventSleepStep('off', null, 1000)).toBe('off')
    expect(currentPreventSleepStep('always', null, 1000)).toBe('always')
  })

  it('returns temporary while the timer is live', () => {
    expect(currentPreventSleepStep('off', 5000, 1000)).toBe('temporary')
  })

  it('falls back to the mode once the deadline has passed', () => {
    expect(currentPreventSleepStep('while-agents-running', 1000, 1000)).toBe('while-agents-running')
    expect(currentPreventSleepStep('off', 999, 1000)).toBe('off')
  })
})

describe('nextPreventSleepStep', () => {
  it('cycles off → while-agents-running → always → temporary → off', () => {
    const order: PreventSleepStep[] = [
      'off',
      'while-agents-running',
      'always',
      'temporary',
      'off'
    ]
    let step: PreventSleepStep = 'off'
    for (let i = 1; i < order.length; i++) {
      step = nextPreventSleepStep(step)
      expect(step).toBe(order[i])
    }
  })
})

describe('advancePreventSleep', () => {
  it('off → while-agents-running: sets the mode and clears any timer', () => {
    const b = mockBackend()
    const next = advancePreventSleep('off', null, 1000, b)
    expect(next).toBe('while-agents-running')
    expect(b.setPreventSleepMode).toHaveBeenCalledWith('while-agents-running')
    expect(b.setPreventSleepUntil).toHaveBeenCalledWith(null)
  })

  it('always → temporary: arms the 1h timer and resets mode to off', () => {
    const b = mockBackend()
    const now = 1_000_000
    const next = advancePreventSleep('always', null, now, b)
    expect(next).toBe('temporary')
    expect(b.setPreventSleepMode).toHaveBeenCalledWith('off')
    expect(b.setPreventSleepUntil).toHaveBeenCalledWith(now + PREVENT_SLEEP_TEMPORARY_MS)
  })

  it('temporary → off: clears the live timer', () => {
    const b = mockBackend()
    const now = 1000
    const until = now + 60_000 // live timer → current step is temporary
    const next = advancePreventSleep('off', until, now, b)
    expect(next).toBe('off')
    expect(b.setPreventSleepUntil).toHaveBeenCalledWith(null)
    expect(b.setPreventSleepMode).toHaveBeenCalledWith('off')
  })
})
