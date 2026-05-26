// Harness ships its status hooks for Codex as the same plugin tree that
// Claude consumes via --plugin-dir. Codex doesn't accept a --plugin-dir
// flag — instead, plugins live under a *marketplace* registered in
// ~/.codex/config.toml. We register the bundled marketplace + enable
// the plugin at boot via the `codex plugin marketplace add` and
// `codex plugin add` commands. Both write to config.toml, but cleanly:
// removable via the matching `remove` subcommands.
//
// Why every boot, not "once":
//   Codex caches plugins under ~/.codex/plugins/cache/<marketplace>/
//   <plugin>/<version>/ and never refreshes automatically. Running
//   `plugin add` on every Harness boot re-copies the bundled source
//   into the cache so a fresh Harness release picks up immediately.
//   Version-bump the plugin in .claude-plugin/plugin.json on every
//   Harness release to evict the old cache dir cleanly.
//
// Why the same plugin works for both agents:
//   Codex 0.133+ reads .claude-plugin/plugin.json when no .codex-plugin/
//   sibling exists. Hook event names (UserPromptSubmit/PreToolUse/…) and
//   the hooks.json schema are identical to Claude's. Codex auto-loads
//   the plugin's .mcp.json and resolves both ${PLUGIN_ROOT} and
//   ${CLAUDE_PLUGIN_ROOT}, so the MCP bridge entry needs no changes.
//   Skills under skills/<name>/SKILL.md are discovered the same way.

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from './debug'
import { harnessPluginMarketplaceRoot } from './claude-plugin'

const MARKETPLACE_NAME = 'harness'
const PLUGIN_NAME = 'harness-status'

function runCodex(codexCommand: string, args: string[]): { ok: boolean; output: string } {
  // Wrap in a login shell so Homebrew/nvm/etc. paths resolve the same
  // way as the user's terminal. path-fix.ts merges PATH at boot but
  // some environments (headless, weird shells) still benefit from the
  // explicit login wrap.
  const cmd = [codexCommand, ...args].join(' ')
  try {
    const result = spawnSync('/bin/zsh', ['-ilc', cmd], {
      encoding: 'utf-8',
      timeout: 30_000
    })
    const output = (result.stdout || '') + (result.stderr || '')
    if (result.status === 0) return { ok: true, output }
    return { ok: false, output: output || `exited ${result.status}` }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) }
  }
}

/** Ensure the bundled Harness marketplace + plugin are registered and
 *  enabled. Idempotent — safe to call on every Harness boot. Returns
 *  true if both steps succeeded, false if codex is missing or either
 *  step failed (logged but never throws). */
export function installCodexPlugin(codexCommand: string): boolean {
  const root = harnessPluginMarketplaceRoot()
  log('codex-plugin', `registering marketplace from ${root}`)

  const mkt = runCodex(codexCommand, ['plugin', 'marketplace', 'add', JSON.stringify(root)])
  if (!mkt.ok) {
    // codex may print "marketplace already exists" — treat as success.
    if (!/already/i.test(mkt.output)) {
      log('codex-plugin', `marketplace add failed: ${mkt.output.trim()}`)
      return false
    }
  }

  const add = runCodex(codexCommand, ['plugin', 'add', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`])
  if (!add.ok) {
    log('codex-plugin', `plugin add failed: ${add.output.trim()}`)
    return false
  }

  ensureCodexHooksFeatureEnabled()
  log('codex-plugin', 'installed and enabled')
  return true
}

/** Remove the bundled marketplace + plugin from the user's Codex
 *  install. Idempotent; logs but doesn't throw. */
export function uninstallCodexPlugin(codexCommand: string): void {
  runCodex(codexCommand, ['plugin', 'remove', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`])
  runCodex(codexCommand, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME])
  log('codex-plugin', 'uninstalled')
}

/** Codex 0.133 deprecated `[features].codex_hooks` in favor of
 *  `[features].hooks`. Without it, the plugin's hooks.json is parsed
 *  but the hooks never fire. We rewrite the config.toml to use the
 *  new key (and strip the deprecated alias if present) so users on
 *  current Codex don't see the deprecation warning on every spawn. */
export function ensureCodexHooksFeatureEnabled(): void {
  const path = join(homedir(), '.codex', 'config.toml')
  let content = ''
  try {
    content = existsSync(path) ? readFileSync(path, 'utf-8') : ''
  } catch (err) {
    log('codex-plugin', `failed to read config.toml: ${err instanceof Error ? err.message : err}`)
    return
  }

  let next = content
  // Drop deprecated alias if present anywhere in [features].
  next = next.replace(/^\s*codex_hooks\s*=.*$\n?/gm, '')

  if (/^\s*hooks\s*=\s*true/m.test(next)) {
    if (next !== content) {
      try {
        writeFileSync(path, next)
      } catch (err) {
        log(
          'codex-plugin',
          `failed to update config.toml: ${err instanceof Error ? err.message : err}`
        )
      }
    }
    return
  }

  // Insert under [features]; create the section if missing.
  if (/^\[features\]/m.test(next)) {
    next = next.replace(/(^\[features\][^\n]*\n)/m, '$1hooks = true\n')
  } else {
    next = next.trimEnd() + '\n\n[features]\nhooks = true\n'
  }

  try {
    writeFileSync(path, next)
    log('codex-plugin', 'enabled [features].hooks in ~/.codex/config.toml')
  } catch (err) {
    log('codex-plugin', `failed to write config.toml: ${err instanceof Error ? err.message : err}`)
  }
}

/** One-shot migration from the prior `~/.codex/hooks.json` install
 *  path. Strips any Harness-installed entries (recognized by the
 *  /tmp/harness-status signature baked into the command) and removes
 *  empty event arrays. Returns true if anything was changed. */
export function stripHarnessEntriesFromHooksFile(path: string): boolean {
  if (!existsSync(path)) return false
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return false
  }
  let data: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }
  try {
    data = JSON.parse(raw)
  } catch {
    return false
  }
  if (!data.hooks) return false

  let changed = false
  const SIG = '/tmp/harness-status'
  for (const event of Object.keys(data.hooks)) {
    const before = data.hooks[event].length
    data.hooks[event] = data.hooks[event].filter(
      (entry) =>
        !entry.hooks?.some((h) => typeof h.command === 'string' && h.command.includes(SIG))
    )
    if (data.hooks[event].length !== before) changed = true
    if (data.hooks[event].length === 0) delete data.hooks[event]
  }
  if (!changed) return false
  if (Object.keys(data.hooks).length === 0) delete data.hooks

  try {
    writeFileSync(path, JSON.stringify(data, null, 2))
    log('codex-plugin', `stripped legacy Harness entries from ${path}`)
    return true
  } catch (err) {
    log(
      'codex-plugin',
      `failed to write stripped hooks file: ${err instanceof Error ? err.message : err}`
    )
    return false
  }
}

/** Global hooks file path — used by the boot migration to locate the
 *  legacy install. */
export function legacyGlobalHooksPath(): string {
  return join(homedir(), '.codex', 'hooks.json')
}

/** Per-worktree hooks file path. */
export function legacyWorktreeHooksPath(worktreePath: string): string {
  return join(worktreePath, '.codex', 'hooks.json')
}
