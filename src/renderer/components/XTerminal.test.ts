import { describe, it, expect } from 'vitest'
import { canFitContainer, isMouseButtonReport } from './XTerminal'

// SGR mouse report shape: ESC [ < btn ; col ; row (M=press, m=release).
// Button-flag bits: 0x20 = motion, 0x40 = wheel. A plain button click has
// neither set; those are the reports we may withhold from the PTY so a
// mouse-aware app (Claude Code) doesn't also open a clicked link.
const sgr = (btn: number, suffix: 'M' | 'm' = 'M', col = 10, row = 5): string =>
  `\x1b[<${btn};${col};${row}${suffix}`

describe('isMouseButtonReport', () => {
  it('matches a left-button press report', () => {
    expect(isMouseButtonReport(sgr(0, 'M'))).toBe(true)
  })

  it('matches a left-button release report', () => {
    expect(isMouseButtonReport(sgr(0, 'm'))).toBe(true)
  })

  it('matches middle (1) and right (2) button reports', () => {
    expect(isMouseButtonReport(sgr(1))).toBe(true)
    expect(isMouseButtonReport(sgr(2))).toBe(true)
  })

  it('matches a click carrying modifier bits (shift 0x04 / meta 0x08 / ctrl 0x10)', () => {
    // Cmd+Shift+click etc. still carry the button bits without motion/wheel.
    expect(isMouseButtonReport(sgr(0 | 0x04))).toBe(true)
    expect(isMouseButtonReport(sgr(0 | 0x08))).toBe(true)
    expect(isMouseButtonReport(sgr(0 | 0x10))).toBe(true)
  })

  it('rejects motion reports (bit 0x20 set) so hover still reaches the app', () => {
    expect(isMouseButtonReport(sgr(0 | 0x20))).toBe(false)
    expect(isMouseButtonReport(sgr(0x23))).toBe(false) // drag-with-button
  })

  it('rejects wheel reports (bit 0x40 set) so scrolling still reaches the app', () => {
    expect(isMouseButtonReport(sgr(0x40))).toBe(false) // wheel up
    expect(isMouseButtonReport(sgr(0x41))).toBe(false) // wheel down
  })

  it('rejects non-mouse PTY data', () => {
    expect(isMouseButtonReport('hello')).toBe(false)
    expect(isMouseButtonReport('')).toBe(false)
    expect(isMouseButtonReport('\x1b[A')).toBe(false) // cursor up
    expect(isMouseButtonReport('\r')).toBe(false)
  })

  it('rejects an SGR report embedded in surrounding bytes (anchored match only)', () => {
    expect(isMouseButtonReport(`x${sgr(0)}`)).toBe(false)
    expect(isMouseButtonReport(`${sgr(0)}y`)).toBe(false)
  })

  it('rejects the legacy X10 mouse encoding (only SGR is handled)', () => {
    expect(isMouseButtonReport('\x1b[M !!')).toBe(false)
  })
})

// Gate for spawning a PTY and (critically) for replaying saved scrollback.
// A hidden tab's container measures 0×0, and a tab mid-switch can briefly
// report a near-zero box; replaying cursor-addressed scrollback into the
// tiny grid xterm falls back to permanently mangles an alt-screen TUI
// (alt buffers never reflow). Only fit/replay once the box is real.
describe('canFitContainer', () => {
  it('accepts a real, full-size container', () => {
    expect(canFitContainer({ width: 2154, height: 1370 })).toBe(true)
  })

  it('rejects a hidden (display:none) container measuring 0×0', () => {
    expect(canFitContainer({ width: 0, height: 0 })).toBe(false)
  })

  it('rejects a near-zero transient box mid-switch', () => {
    expect(canFitContainer({ width: 4, height: 2 })).toBe(false)
  })

  it('rejects when only one dimension has collapsed', () => {
    expect(canFitContainer({ width: 2154, height: 0 })).toBe(false)
    expect(canFitContainer({ width: 0, height: 1370 })).toBe(false)
  })

  it('accepts exactly at the minimum threshold and rejects just below', () => {
    expect(canFitContainer({ width: 20, height: 20 })).toBe(true)
    expect(canFitContainer({ width: 19, height: 20 })).toBe(false)
    expect(canFitContainer({ width: 20, height: 19 })).toBe(false)
  })

  it('rejects a missing rect (getBoundingClientRect on a detached ref)', () => {
    expect(canFitContainer(null)).toBe(false)
    expect(canFitContainer(undefined)).toBe(false)
  })
})
