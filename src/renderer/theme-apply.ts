import { DEFAULT_LIGHT_THEME, DEFAULT_DARK_THEME } from '../shared/state/settings'
import type { ResolvedTheme } from './hooks/useActiveTheme'

// Tracks which `--color-*` properties we set inline on the documentElement
// during the previous apply, so the next apply can clear leftovers
// cleanly. Without this, switching from a custom theme back to a built-in
// would leak the custom's colors past the [data-theme] selector (inline
// styles outrank attribute selectors).
const inlineKeysApplied = new Set<string>()

export const SEMANTIC_KEYS: ReadonlySet<string> = new Set([
  'app',
  'panel',
  'panel-raised',
  'surface',
  'surface-hover',
  'border',
  'border-strong',
  'fg',
  'fg-bright',
  'muted',
  'dim',
  'faint',
  'success',
  'warning',
  'danger',
  'info',
  'accent'
])

export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  // Clear any inline `--color-*` keys left from the previous apply so a
  // partial custom-theme override (or any built-in switch) doesn't leak.
  if (inlineKeysApplied.size > 0) {
    for (const key of inlineKeysApplied) {
      root.style.removeProperty(key)
    }
    inlineKeysApplied.clear()
  }

  if (theme.kind === 'built-in') {
    // Built-ins pull every value from the CSS file via the
    // [data-theme="<id>"] selector — setting the attribute is enough.
    root.dataset.theme = theme.id
    return
  }

  // Custom theme. Apply its mode's default selector first so any keys
  // the custom didn't override fall back to a sensible base of the same
  // mode, then layer the overrides inline. The `[data-theme]` selector
  // wins for unset keys; inline `--color-*` wins for overridden ones
  // because inline trumps attribute selectors by CSS specificity.
  root.dataset.theme = theme.mode === 'dark' ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME
  for (const [key, value] of Object.entries(theme.colors)) {
    if (!SEMANTIC_KEYS.has(key)) continue
    const prop = `--color-${key}`
    root.style.setProperty(prop, value)
    inlineKeysApplied.add(prop)
  }
}

/** Best-effort hex/string for the app background after applying `theme`.
 *  Used as `lastEffectiveAppBg` so main can choose a matching window
 *  background on the next boot. */
export function effectiveAppBg(theme: ResolvedTheme): string {
  if (theme.kind === 'custom') {
    return theme.colors.app ?? (theme.mode === 'dark' ? '#0a0a0a' : '#fdf6e3')
  }
  // First swatch on every built-in is its app background hex.
  return theme.swatches[0]
}
