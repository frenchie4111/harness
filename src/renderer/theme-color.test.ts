import { describe, it, expect } from 'vitest'
import { normalizeThemeColor } from './theme-color'

describe('normalizeThemeColor', () => {
  const FB = '#0a0a0a'

  it('expands 3-digit shorthand (the Lightning CSS minification case)', () => {
    expect(normalizeThemeColor('#fff', FB)).toBe('#ffffff')
    expect(normalizeThemeColor('#000', FB)).toBe('#000000')
    expect(normalizeThemeColor('#abc', FB)).toBe('#aabbcc')
  })

  it('expands 4-digit shorthand with alpha', () => {
    expect(normalizeThemeColor('#fff8', FB)).toBe('#ffffff88')
    expect(normalizeThemeColor('#0000', FB)).toBe('#00000000')
  })

  it('passes valid 6- and 8-digit hex through unchanged', () => {
    expect(normalizeThemeColor('#24292e', FB)).toBe('#24292e')
    expect(normalizeThemeColor('#3a424d55', FB)).toBe('#3a424d55')
  })

  it('trims surrounding whitespace before matching', () => {
    expect(normalizeThemeColor('  #fff  ', FB)).toBe('#ffffff')
    expect(normalizeThemeColor('\t#24292e\n', FB)).toBe('#24292e')
  })

  it('falls back for empty / whitespace-only input', () => {
    expect(normalizeThemeColor('', FB)).toBe(FB)
    expect(normalizeThemeColor('   ', FB)).toBe(FB)
  })

  it('falls back for malformed-length hex', () => {
    expect(normalizeThemeColor('#ff', FB)).toBe(FB)
    expect(normalizeThemeColor('#fffff', FB)).toBe(FB)
    expect(normalizeThemeColor('#fffffff', FB)).toBe(FB)
  })

  it('falls back for non-hex color forms Monaco token colors reject', () => {
    expect(normalizeThemeColor('white', FB)).toBe(FB)
    expect(normalizeThemeColor('rgb(255, 255, 255)', FB)).toBe(FB)
    expect(normalizeThemeColor('oklch(1 0 0)', FB)).toBe(FB)
    expect(normalizeThemeColor('var(--x)', FB)).toBe(FB)
  })
})
