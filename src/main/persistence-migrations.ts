// Config schema migrations. Kept in its own file (no electron imports) so
// unit tests can exercise them without needing to mock `app.getPath` etc.
//
// Each entry takes a config object at version N and mutates it in place to
// version N+1. `runMigrations` runs them in order from `config.schemaVersion`
// up to `SCHEMA_VERSION`. Append new migrations to the end of the array and
// the version bumps automatically — never rewrite or reorder existing ones,
// since users in the wild may be at any earlier version.
//
// Each migration must be idempotent on an already-migrated shape so a user
// who installed a mid-release build still converges correctly. Pre-versioned
// configs (no `schemaVersion` field) are treated as v0 and run through the
// entire chain.

import { basename, dirname, join } from 'path'

import type { AgentKind } from '../shared/state/terminals'

export interface PersistedTab {
  id: string
  type: 'agent' | 'shell'
  label: string
  agentKind?: AgentKind
  sessionId?: string
}

export interface PersistedPane {
  id: string
  tabs: PersistedTab[]
  activeTabId: string
}

export type AnyConfig = Record<string, unknown>
export type Migration = (c: AnyConfig) => void

export const migrations: Migration[] = [
  // v0 → v1: single `repoRoot` string → `repoRoots` array.
  (c) => {
    if (typeof c.repoRoot === 'string' && !Array.isArray(c.repoRoots)) {
      c.repoRoots = [c.repoRoot]
    }
    delete c.repoRoot
  },

  // v1 → v2: flat `terminalTabs` + `activeTabId` → flat `panes`
  // (worktreePath → PersistedPane[]). Each worktree's old tab list becomes a
  // single pane with the same active tab. Legacy keys are left in place so a
  // downgrade stays lossless.
  (c) => {
    const terminalTabs = c.terminalTabs as Record<string, PersistedTab[]> | undefined
    const activeTabId = c.activeTabId as Record<string, string> | undefined
    if (!terminalTabs || c.panes) return
    const migrated: Record<string, PersistedPane[]> = {}
    for (const [wtPath, tabs] of Object.entries(terminalTabs)) {
      if (!tabs || tabs.length === 0) continue
      const activeId = activeTabId?.[wtPath] || tabs[0].id
      migrated[wtPath] = [{
        id: `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tabs,
        activeTabId: activeId
      }]
    }
    c.panes = migrated
  },

  // v2 → v3: flat `panes` (wtPath → panes[]) → nested
  // `panes` (repoRoot → wtPath → panes[]). Worktrees are grouped under the
  // repoRoot that owns them by path prefix; the default harness layout puts
  // them in a `<basename>-worktrees/` sibling of the repo. Anything that
  // doesn't match lands in `__orphan__` and is re-keyed by the renderer on
  // first save.
  (c) => {
    const looksFlat = (p: unknown): p is Record<string, PersistedPane[]> => {
      if (!p || typeof p !== 'object') return false
      const values = Object.values(p as object)
      if (values.length === 0) return false
      return Array.isArray(values[0])
    }
    if (!looksFlat(c.panes)) return
    const flat = c.panes as Record<string, PersistedPane[]>
    const repoRoots: string[] = Array.isArray(c.repoRoots) ? (c.repoRoots as string[]) : []
    const ownerPrefixes = repoRoots.map((r) => ({
      repoRoot: r,
      prefixes: [r, join(dirname(r), `${basename(r)}-worktrees`) + '/']
    }))
    const nested: Record<string, Record<string, PersistedPane[]>> = {}
    const orphan: Record<string, PersistedPane[]> = {}
    for (const [wtPath, paneList] of Object.entries(flat)) {
      const owner = ownerPrefixes.find(({ prefixes }) =>
        prefixes.some((p) => wtPath === p || wtPath.startsWith(p.endsWith('/') ? p : p + '/'))
      )
      if (owner) {
        if (!nested[owner.repoRoot]) nested[owner.repoRoot] = {}
        nested[owner.repoRoot][wtPath] = paneList
      } else {
        orphan[wtPath] = paneList
      }
    }
    if (Object.keys(orphan).length > 0) nested['__orphan__'] = orphan
    // Keep the flat shape in `legacyPanes` for one release so a downgrade is
    // lossless.
    c.legacyPanes = flat
    c.panes = nested
  },

  // v3 → v4: tab type 'claude' → 'agent' with agentKind: 'claude'.
  // Walk all persisted panes (nested by repoRoot → wtPath) and migrate
  // each tab's type field.
  (c) => {
    const panes = c.panes as Record<string, Record<string, { tabs: { type: string; agentKind?: string }[] }[]>> | undefined
    if (!panes || typeof panes !== 'object') return
    for (const byWt of Object.values(panes)) {
      if (!byWt || typeof byWt !== 'object') continue
      for (const paneList of Object.values(byWt)) {
        if (!Array.isArray(paneList)) continue
        for (const pane of paneList) {
          if (!pane?.tabs || !Array.isArray(pane.tabs)) continue
          for (const tab of pane.tabs) {
            if (tab.type === 'claude') {
              tab.type = 'agent'
              tab.agentKind = 'claude'
            }
          }
        }
      }
    }
  }
]

export const SCHEMA_VERSION = migrations.length

/** Run all pending migrations on the given config object, mutating it in
 *  place. Sets `schemaVersion` to the current version on return. */
export function runMigrations(parsed: AnyConfig): void {
  const from = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 0
  for (let v = from; v < SCHEMA_VERSION; v++) {
    migrations[v](parsed)
  }
  parsed.schemaVersion = SCHEMA_VERSION
}
