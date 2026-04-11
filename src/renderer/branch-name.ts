/**
 * Live-sanitize text into something that's valid as a git branch name.
 * Spaces become dashes, forbidden chars are stripped, runs of dashes collapse.
 * We deliberately don't trim leading/trailing dashes on every keystroke so the
 * user can type "foo-" on the way to "foo-bar".
 */
export function sanitizeBranchInput(raw: string): string {
  return raw
    .replace(/\s+/g, '-')
    .replace(/[~^:?*\[\]\\\x00-\x1f\x7f]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/@\{/g, '')
    .replace(/-{2,}/g, '-')
}

/** Returns true when the sanitized name is a plausible branch name. */
export function isValidBranchName(name: string): boolean {
  if (!name) return false
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('/')) return false
  if (name.endsWith('.') || name.endsWith('.lock') || name.endsWith('/')) return false
  if (name === '@') return false
  return true
}
