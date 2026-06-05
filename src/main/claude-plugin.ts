// Harness ships its Claude status hooks as a local Claude Code plugin
// bundled under resources/plugins/harness-status/. Every Claude spawn
// passes --plugin-dir <thisDir> so the plugin loads for Harness sessions
// only; sessions outside Harness never see it. Two benefits over the
// previous user-scope settings.json install:
//   1. Zero writes to user-owned files — no consent prompt, no merge
//      against user-authored hooks.
//   2. Coupled to a single Harness release — no drift between what
//      Harness expects on stdin and what hooks.json emits.
//
// The hook command still env-gates on $HARNESS_TERMINAL_ID as a second
// line of defense in case the bundle gets copied or referenced
// elsewhere. STATUS_DIR / makeHookCommand are the single source of
// truth; src/main/claude-plugin.test.ts asserts the static hooks.json
// matches what makeHookCommand would generate today so the two never
// drift silently.
//
// Path resolution mirrors src/main/mcp-config.ts:getBridgeScriptPath
// (packaged → process.resourcesPath, dev → relative to __dirname). The
// plugin tree is shipped via electron-builder's extraResources.

import { join } from 'path'
import { isPackaged } from './paths'

/** Absolute path to the bundled Harness status plugin. Pass this to
 *  every Claude spawn via --plugin-dir. */
export function harnessPluginDir(): string {
  if (isPackaged()) {
    return join(process.resourcesPath, 'plugins', 'harness-status')
  }
  return join(__dirname, '..', '..', 'resources', 'plugins', 'harness-status')
}

/** Absolute path to the marketplace root containing the bundled plugin.
 *  This is the parent of harnessPluginDir() and the dir that holds
 *  .agents/plugins/marketplace.json — pass to `codex plugin marketplace
 *  add` so Codex picks up the same tree. */
export function harnessPluginMarketplaceRoot(): string {
  if (isPackaged()) {
    return join(process.resourcesPath, 'plugins')
  }
  return join(__dirname, '..', '..', 'resources', 'plugins')
}
