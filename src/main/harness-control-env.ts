// Env vars consumed by the bundled Harness status plugin's .mcp.json
// when it spawns the harness-control MCP bridge. The plugin file
// references these via ${...} interpolation at Claude launch time, and
// the bridge subprocess inherits them through its parent (Claude).
//
// Separated from src/main/mcp-config.ts so the env-building logic stays
// in one place even after we deleted the per-terminal config-file
// writer.

import type { CallerScope } from './control-server'

export interface HarnessControlEnvDeps {
  /** process.execPath at runtime (Electron's binary when running via
   *  ELECTRON_RUN_AS_NODE=1, plain Node when headless). The plugin
   *  invokes this to run the bridge script. */
  execPath: string
  /** Control server port + token. Plugin references them as
   *  ${HARNESS_PORT} / ${HARNESS_TOKEN}. */
  port: number
  token: string
  /** The terminal id the bridge should claim. Surfaced under
   *  HARNESS_MCP_TERMINAL_ID so it doesn't collide with
   *  HARNESS_TERMINAL_ID (which gates the status hooks — json-mode tabs
   *  intentionally scrub that to avoid double-tracking, but still want
   *  the MCP bridge to know which session it's bound to). */
  terminalId: string
  /** Optional caller scope. Plugin references the fields via
   *  ${HARNESS_WORKTREE_ID:-} etc. with empty-string defaults. */
  scope: CallerScope | null
}

/** Build the env block that must be present on Claude's spawn env so the
 *  bundled plugin's .mcp.json can resolve its ${...} placeholders. */
export function buildHarnessControlEnv(deps: HarnessControlEnvDeps): Record<string, string> {
  const env: Record<string, string> = {
    HARNESS_NODE_EXEC: deps.execPath,
    HARNESS_PORT: String(deps.port),
    HARNESS_TOKEN: deps.token,
    HARNESS_MCP_TERMINAL_ID: deps.terminalId
  }
  if (deps.scope) {
    env.HARNESS_WORKTREE_ID = deps.scope.worktreePath
    env.HARNESS_REPO_ROOT = deps.scope.repoRoot
    if (deps.scope.isMain) env.HARNESS_IS_MAIN = '1'
  }
  return env
}
