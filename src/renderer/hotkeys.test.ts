import { describe, it, expect } from 'vitest'
import {
  DEFAULT_HOTKEYS,
  ACTION_CATEGORIES,
  formatBindingGlyphs,
  isTypeableBinding,
  parseBinding,
  type Action
} from './hotkeys'

describe('hotkey categories', () => {
  it('every default hotkey is surfaced in exactly one category', () => {
    const categorized: Action[] = []
    for (const category of ACTION_CATEGORIES) {
      categorized.push(...category.actions)
      for (const family of category.families ?? []) {
        categorized.push(...family.actions)
      }
    }

    const seen = new Set<Action>()
    const duplicates = categorized.filter((a) => {
      if (seen.has(a)) return true
      seen.add(a)
      return false
    })
    expect(duplicates).toEqual([])

    const allActions = Object.keys(DEFAULT_HOTKEYS) as Action[]
    const missing = allActions.filter((a) => !seen.has(a))
    expect(missing).toEqual([])
  })
})

describe('formatBindingGlyphs', () => {
  it('renders modifiers in macOS HIG order (Shift before Cmd) regardless of input order', () => {
    // ⌃ ⌥ ⇧ ⌘
    expect(formatBindingGlyphs('Cmd+Shift+E', '')).toBe('⇧⌘E')
    expect(formatBindingGlyphs('Shift+Cmd+E', '')).toBe('⇧⌘E')
    expect(formatBindingGlyphs('Cmd+Alt+Shift+Ctrl+K', '')).toBe('⌃⌥⇧⌘K')
  })

  it('formats single modifiers and special keys', () => {
    expect(formatBindingGlyphs('Cmd+,', '')).toBe('⌘,')
    expect(formatBindingGlyphs('Cmd+ArrowDown', '')).toBe('⌘↓')
  })
})

describe('isTypeableBinding', () => {
  it('treats a bare character key as typing', () => {
    expect(isTypeableBinding(parseBinding('a'))).toBe(true)
    expect(isTypeableBinding({ key: ' ', modifiers: {} })).toBe(true)
  })

  it('treats Shift+letter and Alt+letter as typing', () => {
    expect(isTypeableBinding(parseBinding('Shift+A'))).toBe(true)
    expect(isTypeableBinding(parseBinding('Alt+A'))).toBe(true)
  })

  it('does not treat Cmd or Ctrl chords as typing', () => {
    expect(isTypeableBinding(parseBinding('Cmd+A'))).toBe(false)
    expect(isTypeableBinding(parseBinding('Ctrl+A'))).toBe(false)
    expect(isTypeableBinding(parseBinding('Cmd+Shift+Y'))).toBe(false)
  })

  it('does not treat named keys as typing', () => {
    expect(isTypeableBinding(parseBinding('F12'))).toBe(false)
    expect(isTypeableBinding(parseBinding('Escape'))).toBe(false)
    expect(isTypeableBinding(parseBinding('ArrowDown'))).toBe(false)
  })

  it('leaves every default binding live inside editable targets', () => {
    for (const binding of Object.values(DEFAULT_HOTKEYS)) {
      expect(isTypeableBinding(binding)).toBe(false)
    }
  })
})
