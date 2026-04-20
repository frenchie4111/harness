import { describe, it, expect } from 'vitest'
import { resolveScreenshotTarget } from './browser-screenshot'

describe('resolveScreenshotTarget', () => {
  it('returns CSS bounds as the output dimensions when no cap is given', () => {
    const r = resolveScreenshotTarget({ width: 1440, height: 900 })
    expect(r.cssSize).toEqual({ width: 1440, height: 900 })
    expect(r.outputSize).toEqual({ width: 1440, height: 900 })
    expect(r.scale).toBe(1)
  })

  it('leaves small viewports alone when maxDimension is already ≥ long edge', () => {
    const r = resolveScreenshotTarget({ width: 1024, height: 768 }, 1280)
    expect(r.outputSize).toEqual({ width: 1024, height: 768 })
    expect(r.scale).toBe(1)
  })

  it('downscales proportionally when long edge exceeds maxDimension', () => {
    const r = resolveScreenshotTarget({ width: 1920, height: 1080 }, 1280)
    expect(r.outputSize.width).toBe(1280)
    expect(r.outputSize.height).toBe(720)
    expect(r.scale).toBeCloseTo(1280 / 1920)
  })

  it('uses the taller side when height is the long edge', () => {
    const r = resolveScreenshotTarget({ width: 900, height: 1600 }, 1280)
    expect(r.outputSize.height).toBe(1280)
    expect(r.outputSize.width).toBe(Math.round(900 * (1280 / 1600)))
    expect(r.scale).toBeCloseTo(1280 / 1600)
  })
})
