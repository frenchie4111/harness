import { describe, it, expect } from 'vitest'
import {
  encodedCaptureError,
  resolveScreenshotTarget,
  viewportCaptureError
} from './browser-screenshot'

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

describe('viewportCaptureError', () => {
  it('accepts a real viewport', () => {
    expect(viewportCaptureError({ width: 1280, height: 800 })).toBeNull()
    expect(viewportCaptureError({ width: 1, height: 1 })).toBeNull()
  })

  it('rejects the 0×0 bounds of a view that was never laid out', () => {
    expect(viewportCaptureError({ width: 0, height: 0 })).toMatch(/0x0/)
    expect(viewportCaptureError({ width: 1280, height: 0 })).toMatch(/1280x0/)
  })

  it('rejects garbage dimensions rather than passing them to resize()', () => {
    expect(viewportCaptureError({ width: NaN, height: 800 })).not.toBeNull()
    expect(viewportCaptureError({ width: -10, height: 800 })).not.toBeNull()
  })
})

describe('encodedCaptureError', () => {
  it('accepts a real image', () => {
    expect(encodedCaptureError({ width: 1280, height: 800 }, 24_000)).toBeNull()
  })

  it('rejects a zero-size image', () => {
    expect(encodedCaptureError({ width: 0, height: 0 }, 24_000)).toMatch(/0x0/)
  })

  it('rejects an empty buffer, the old silent HTTP-200 path', () => {
    expect(encodedCaptureError({ width: 1280, height: 800 }, 0)).toMatch(/0 bytes/)
  })
})
