// Tracks which editor tabs have unsaved changes so the close handler can
// warn before discarding them. The dirty flag lives inside FileView's own
// React tree; this side channel (keyed by tabId) lets handleCloseTab read
// it imperatively at close time. Mirrors review-progress.ts. FileView sets
// its entry on every change and clears it on unmount.
const dirtyTabs = new Set<string>()

export function setTabDirty(tabId: string, dirty: boolean): void {
  if (dirty) dirtyTabs.add(tabId)
  else dirtyTabs.delete(tabId)
}

export function clearTabDirty(tabId: string): void {
  dirtyTabs.delete(tabId)
}

export function isTabDirty(tabId: string): boolean {
  return dirtyTabs.has(tabId)
}
