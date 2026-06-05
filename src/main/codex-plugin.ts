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
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from './debug'
import { harnessPluginMarketplaceRoot } from './claude-plugin'
import type { CodexPluginVerification } from '../shared/codex-plugin'

export type { CodexPluginVerification }

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

const verificationFailure = (message: string): CodexPluginVerification => ({
  ok: false,
  pluginEnabled: false,
  hooksPresent: false,
  hooksTrusted: false,
  message
})

/** Probe a presumed-installed plugin and return per-assertion booleans.
 *  Safe to call any time; never mutates state. */
export function probeCodexPlugin(codexCommand: string): CodexPluginVerification {
  const list = runCodex(codexCommand, [
    'plugin',
    'list',
    '--marketplace',
    MARKETPLACE_NAME
  ])
  const enabledLine = list.output
    .split('\n')
    .find((line) => line.startsWith(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`))
  const pluginEnabled = !!enabledLine && /installed, enabled/.test(enabledLine)

  // Plugin cache lives at ~/.codex/plugins/cache/<marketplace>/<plugin>/
  // <version>/hooks/hooks.json. We probe the static path components and
  // fall back to scanning for any version directory if the bundled
  // version we'd guess doesn't exist yet.
  const cacheBase = join(codexHome(), 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME)
  let hooksPresent = false
  try {
    if (existsSync(cacheBase)) {
      const versions = readdirSync(cacheBase)
      hooksPresent = versions.some((v) => existsSync(join(cacheBase, v, 'hooks', 'hooks.json')))
    }
  } catch {
    hooksPresent = false
  }

  const hooksTrusted = areHooksTrusted(cacheBase)

  const ok = pluginEnabled && hooksPresent
  return {
    ok,
    pluginEnabled,
    hooksPresent,
    hooksTrusted,
    message: ok ? undefined : verificationMessage({ pluginEnabled, hooksPresent })
  }
}

/** Check whether Codex has persisted trust for every event in the
 *  plugin's hooks.json.
 *
 *  Codex stores per-event trust as
 *    [hooks.state."<plugin>@<marketplace>:hooks/hooks.json:<event_snake>:0:0"]
 *    trusted_hash = "sha256:…"
 *  in `${CODEX_HOME:-~/.codex}/config.toml`. The hash is over a
 *  normalized form we can't easily reproduce from the command string
 *  alone, so we verify by **key presence** rather than hash equality.
 *  Codex only writes the entry on a positive "Trust all and continue"
 *  decision, so presence == user-granted trust. If the underlying
 *  hook content later drifts, Codex itself will detect the
 *  current_hash mismatch at session start and re-prompt — we don't
 *  need to re-verify the hash ourselves.
 *
 *  Returns false on any read/parse failure — treated as "not trusted"
 *  so the UI surfaces the issue rather than silently passing. */
function areHooksTrusted(cacheBase: string): boolean {
  // Find the most recent version dir under the cache so we know which
  // events to look for in config.toml.
  if (!existsSync(cacheBase)) return false
  let hooksJson: string | null = null
  try {
    const versions = readdirSync(cacheBase).filter((v) => /\d/.test(v))
    if (versions.length === 0) return false
    versions.sort()
    const latest = versions[versions.length - 1]
    const hooksPath = join(cacheBase, latest, 'hooks', 'hooks.json')
    if (!existsSync(hooksPath)) return false
    hooksJson = readFileSync(hooksPath, 'utf-8')
  } catch {
    return false
  }
  if (!hooksJson) return false

  let parsed: { hooks?: Record<string, unknown[]> }
  try {
    parsed = JSON.parse(hooksJson)
  } catch {
    return false
  }
  if (!parsed.hooks) return false
  // Limit verification to events Codex actually understands. Our
  // hooks.json includes `Notification`, which Claude consumes but
  // Codex ignores entirely — it never writes a [hooks.state] entry
  // for unrecognized events, so requiring trust for them would
  // permanently fail the check. List is from Codex 0.133 binary
  // strings; keep in sync if Codex adds more.
  const CODEX_HOOK_EVENTS = new Set([
    'pre_tool_use',
    'post_tool_use',
    'session_start',
    'user_prompt_submit',
    'stop',
    'subagent_start',
    'subagent_stop',
    'pre_compact',
    'post_compact',
    'permission_request'
  ])
  const events = Object.keys(parsed.hooks).filter((e) =>
    CODEX_HOOK_EVENTS.has(toSnakeCase(e))
  )
  if (events.length === 0) return false

  const configPath = join(codexHome(), 'config.toml')
  let config = ''
  try {
    config = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
  } catch {
    return false
  }

  return events.every((event) => {
    // Codex stores event names snake_cased in trust keys.
    const snake = toSnakeCase(event)
    // Match the [hooks.state."…"] block for this event and confirm it
    // has a non-empty trusted_hash. We don't pin the index suffix to
    // 0:0 because Codex might in principle use other index pairs for
    // multi-entry events — we only have one entry per event today,
    // but be liberal in what we accept here.
    const blockRe = new RegExp(
      `^\\[hooks\\.state\\."${PLUGIN_NAME}@${MARKETPLACE_NAME}:hooks/hooks\\.json:${snake}:[0-9]+:[0-9]+"\\][^\\n]*\\n(?:(?!^\\[)[^\\n]*\\n?)*?trusted_hash\\s*=\\s*"sha256:[0-9a-f]+"`,
      'm'
    )
    return blockRe.test(config)
  })
}

function toSnakeCase(pascal: string): string {
  return pascal.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

/** Erase the harness-control entry from the cached `.mcp.json` after
 *  `codex plugin add` materializes it.
 *
 *  Why: the plugin's source `.mcp.json` is shared with Claude (which
 *  reads it via --plugin-dir) and uses `${HARNESS_NODE_EXEC}` /
 *  `${HARNESS_PORT}` / etc. interpolation that Claude expands at MCP
 *  launch time. **Codex does no interpolation at all** — empirically
 *  verified: `${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`, and arbitrary
 *  process env vars all pass through to `execve` as literal strings
 *  (Codex 0.133, May 2026). Worse, Codex spawns MCP subprocesses with
 *  a clean env — only HOME/PATH/PWD/USER/LANG inherit, so even if the
 *  command resolved, the bridge would have no port/token to dial back.
 *
 *  Rather than maintain a Codex-specific .mcp.json variant or pollute
 *  the source with literal absolute paths that break under packaging,
 *  we strip the MCP definition from Codex's view entirely and inject
 *  it per-session via `-c mcp_servers.harness-control.*` overrides on
 *  the Codex spawn command line (see src/main/agents/codex.ts —
 *  buildSpawnArgs). The plugin still ships hooks + skills to Codex
 *  unchanged. */
function neutralizeCachedMcpJson(): void {
  const cacheBase = join(codexHome(), 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME)
  if (!existsSync(cacheBase)) return
  let versions: string[]
  try {
    versions = readdirSync(cacheBase)
  } catch {
    return
  }
  for (const version of versions) {
    const mcpPath = join(cacheBase, version, '.mcp.json')
    if (!existsSync(mcpPath)) continue
    try {
      writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2))
    } catch (err) {
      log(
        'codex-plugin',
        `failed to neutralize cached ${mcpPath}: ${err instanceof Error ? err.message : err}`
      )
    }
  }
}

function verificationMessage(fields: {
  pluginEnabled: boolean
  hooksPresent: boolean
}): string {
  const failed: string[] = []
  if (!fields.pluginEnabled) failed.push('plugin not enabled')
  if (!fields.hooksPresent) failed.push('hooks file missing from cache')
  return failed.join(', ')
}

/** Ensure the bundled Harness marketplace + plugin are registered and
 *  enabled, then immediately probe Codex to verify the install took.
 *  Idempotent — safe to call on every Harness boot. Logs but never
 *  throws; missing codex or a failed step surfaces as
 *  `verification.ok === false` with a human-readable `message`. */
export function installCodexPlugin(codexCommand: string): CodexPluginVerification {
  const root = harnessPluginMarketplaceRoot()
  log('codex-plugin', `registering marketplace from ${root}`)

  const mkt = runCodex(codexCommand, ['plugin', 'marketplace', 'add', JSON.stringify(root)])
  if (!mkt.ok) {
    // codex may print "marketplace already exists" — treat as success.
    if (!/already/i.test(mkt.output)) {
      const msg = `marketplace add failed: ${mkt.output.trim()}`
      log('codex-plugin', msg)
      return verificationFailure(msg)
    }
  }

  const add = runCodex(codexCommand, ['plugin', 'add', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`])
  if (!add.ok) {
    const msg = `plugin add failed: ${add.output.trim()}`
    log('codex-plugin', msg)
    return verificationFailure(msg)
  }

  ensureCodexHooksFeatureEnabled()
  neutralizeCachedMcpJson()

  const verification = probeCodexPlugin(codexCommand)
  log(
    'codex-plugin',
    verification.ok
      ? 'installed, enabled, and verified'
      : `installed but verification failed: ${verification.message}`
  )
  return verification
}

/** Remove the bundled marketplace + plugin from the user's Codex
 *  install. Idempotent; logs but doesn't throw.
 *
 *  Three steps:
 *   1. `codex plugin remove` — also removes the cache dir.
 *   2. `codex plugin marketplace remove` — drops the [marketplaces.harness]
 *      table from ~/.codex/config.toml.
 *   3. Strip leftover `[hooks.state]` entries pointing at our (now-deleted)
 *      cache path AND entries whose `trusted_hash` matches one of our
 *      hook commands' sha256 (handles legacy ~/.codex/hooks.json install
 *      hashes that survived the migration). This ensures a reinstall
 *      re-prompts for trust review rather than silently inheriting the
 *      prior decision via content-hash match. */
export function uninstallCodexPlugin(codexCommand: string): void {
  runCodex(codexCommand, ['plugin', 'remove', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`])
  runCodex(codexCommand, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME])
  stripHarnessHookTrustEntries()
  log('codex-plugin', 'uninstalled')
}

/** Remove `[hooks.state]` entries from ~/.codex/config.toml that
 *  belong to Harness's plugin install. Codex keys plugin trust entries
 *  as `[hooks.state."<plugin>@<marketplace>:hooks/hooks.json:<event>:<n>:<m>"]`,
 *  so we match by the `harness-status@harness:` prefix — unambiguous,
 *  no risk of clobbering user-authored hook trust.
 *
 *  We don't try to also strip legacy `~/.codex/hooks.json` trust
 *  entries here: the prior install path's keys (`<absolute-path>:event:0:0`)
 *  could in principle match user-authored hooks if the user still keeps
 *  their own entries there, and Codex's `trusted_hash` is a normalized
 *  form we can't replicate to disambiguate by content. The pre-plugin
 *  migration already strips the hook entries themselves; the orphaned
 *  trust hashes left behind are harmless. */
function stripHarnessHookTrustEntries(): void {
  const configPath = join(codexHome(), 'config.toml')
  if (!existsSync(configPath)) return
  let original: string
  try {
    original = readFileSync(configPath, 'utf-8')
  } catch (err) {
    log(
      'codex-plugin',
      `read config.toml for trust strip failed: ${err instanceof Error ? err.message : err}`
    )
    return
  }

  const ownedPrefix = `${PLUGIN_NAME}@${MARKETPLACE_NAME}:`

  // [hooks.state."KEY"] blocks span until the next [section] or EOF.
  // Match each block, decide whether to drop it, then reassemble.
  const blockRe =
    /^\[hooks\.state\.(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\][^\n]*\n((?:(?!^\[)[^\n]*\n?)*)/gm
  const dropped: string[] = []
  const next = original.replace(blockRe, (match, dq, sq, bare) => {
    const key = (dq ?? sq ?? bare ?? '') as string
    if (key.startsWith(ownedPrefix)) {
      dropped.push(key)
      return ''
    }
    return match
  })

  if (dropped.length === 0) return
  // Squash any blank-line runs the strip left behind.
  const cleaned = next.replace(/\n{3,}/g, '\n\n')
  try {
    writeFileSync(configPath, cleaned)
    log(
      'codex-plugin',
      `stripped ${dropped.length} [hooks.state] trust entries: ${dropped.join(', ')}`
    )
  } catch (err) {
    log(
      'codex-plugin',
      `write config.toml for trust strip failed: ${err instanceof Error ? err.message : err}`
    )
  }
}

/** Codex 0.133 deprecated `[features].codex_hooks` in favor of
 *  `[features].hooks`. Without it, the plugin's hooks.json is parsed
 *  but the hooks never fire. We rewrite the config.toml to use the
 *  new key (and strip the deprecated alias if present) so users on
 *  current Codex don't see the deprecation warning on every spawn. */
export function ensureCodexHooksFeatureEnabled(): void {
  const path = join(codexHome(), 'config.toml')
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
  return join(codexHome(), 'hooks.json')
}

/** Per-worktree hooks file path. */
export function legacyWorktreeHooksPath(worktreePath: string): string {
  return join(worktreePath, '.codex', 'hooks.json')
}
