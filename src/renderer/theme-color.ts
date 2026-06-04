// Guard for colors derived from theme CSS custom properties.
//
// Why this exists: Tailwind v4 (via Lightning CSS) minifies hex literals in
// the generated stylesheet — `#ffffff` becomes `#fff`, `#000000` becomes
// `#000`, etc. So reading a `--color-*` token back with getComputedStyle can
// hand us a 3- or 4-digit shorthand even though the source CSS wrote the long
// form. Most consumers cope, but Monaco's token color map does not: its
// ColorMap.getId validates with `/^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/` and
// THROWS `Illegal value for token color: <c>` on anything that isn't 6/8 hex.
// Since `editor.foreground` / `editor.background` get folded into a token rule
// by the standalone theme service, a minified `#fff` background crashes the
// whole editor the moment it tokenizes (e.g. switching to the Hub Delight
// theme). Normalizing every theme-derived color to canonical long-form hex
// before it reaches a consumer keeps the strict ones happy.

/** Expand shorthand hex (`#rgb`/`#rgba`) to long form (`#rrggbb`/`#rrggbbaa`),
 *  pass valid long-form hex through unchanged, and return `fallback` for
 *  anything we can't confidently canonicalize (named colors, `rgb()`/`oklch()`,
 *  malformed 5/7-digit hex, empty). The result is always safe to hand to
 *  Monaco's strict token color parser when `fallback` itself is valid hex. */
export function normalizeThemeColor(raw: string, fallback: string): string {
  const c = raw.trim()
  if (!c) return fallback
  const m = /^#([0-9a-fA-F]+)$/.exec(c)
  if (!m) return fallback
  const digits = m[1]
  if (digits.length === 3 || digits.length === 4) {
    let out = '#'
    for (const ch of digits) out += ch + ch
    return out
  }
  if (digits.length === 6 || digits.length === 8) return c
  return fallback
}
