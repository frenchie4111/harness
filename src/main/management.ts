import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { hooksInstalled, installHooks } from './hooks'
import { log } from './debug'

/** Synthetic repoRoot used to namespace persisted panes for the management workspace. */
export const MANAGEMENT_REPO_SENTINEL = '__management__'

/** Human-friendly branch label shown in the terminal tab header. */
export const MANAGEMENT_BRANCH_LABEL = 'management'

/**
 * Harness's standalone "management" workspace: a single Claude Code session
 * that runs outside any git repo, so it can do meta-level work like spinning
 * up new projects and driving Harness via the harness-control MCP.
 */
export function getManagementWorkspacePath(): string {
  return join(app.getPath('userData'), 'management-workspace')
}

/**
 * Ensure the management workspace directory exists and our status-detection
 * hooks are installed there. Safe to call repeatedly — both operations are
 * idempotent. We own this directory, so no user consent is needed.
 */
export function ensureManagementWorkspace(): string {
  const dir = getManagementWorkspacePath()
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
      log('management', `created workspace at ${dir}`)
    } catch (err) {
      log('management', 'failed to create workspace dir', err instanceof Error ? err.message : err)
    }
  }
  if (!hooksInstalled(dir)) {
    try {
      installHooks(dir)
    } catch (err) {
      log('management', 'failed to install hooks', err instanceof Error ? err.message : err)
    }
  }
  return dir
}
