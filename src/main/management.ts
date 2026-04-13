import { app } from 'electron'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdirSync, existsSync } from 'fs'
import { hooksInstalled, installHooks } from './hooks'
import { log } from './debug'

const execFileAsync = promisify(execFile)

/** Synthetic repoRoot used to namespace persisted panes for the management workspace. */
export const MANAGEMENT_REPO_SENTINEL = '__management__'

/** Human-friendly branch label shown in the terminal tab header. */
export const MANAGEMENT_BRANCH_LABEL = 'management'

/**
 * Harness's standalone "management" workspace: a single Claude Code session
 * that runs outside the user's project repos, so it can do meta-level work
 * like spinning up new projects and driving Harness via the harness-control
 * MCP. The directory is a minimal git repo with an initial empty commit so
 * the management session can `git worktree add` to fork itself — which
 * doubles as the "no project yet" flow for users who don't use git at all.
 */
export function getManagementWorkspacePath(): string {
  return join(app.getPath('userData'), 'management-workspace')
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function hasAnyCommit(dir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir })
    return true
  } catch {
    return false
  }
}

/**
 * Ensure the management workspace directory exists, is a git repo with at
 * least one commit on `main`, and has our status-detection hooks installed.
 * Safe to call repeatedly — every step is idempotent. We own this directory,
 * so no user consent is needed for the hook install.
 */
export async function ensureManagementWorkspace(): Promise<string> {
  const dir = getManagementWorkspacePath()
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
      log('management', `created workspace at ${dir}`)
    } catch (err) {
      log('management', 'failed to create workspace dir', err instanceof Error ? err.message : err)
    }
  }

  // Turn the directory into a git repo so the management session can
  // `git worktree add` to fork itself through the same plumbing every other
  // repo uses.
  try {
    if (!(await isGitRepo(dir))) {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir })
      log('management', `git init ${dir}`)
    }
    if (!(await hasAnyCommit(dir))) {
      // Hardcoded identity + gpgsign disabled so we work even when the user
      // has no global git config. An empty commit is enough to give HEAD
      // something to point at; no stray files on disk.
      await execFileAsync(
        'git',
        [
          '-c',
          'user.email=harness@localhost',
          '-c',
          'user.name=Harness',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '-m',
          'Initial management workspace'
        ],
        { cwd: dir }
      )
      log('management', 'created initial commit on main')
    }
  } catch (err) {
    log('management', 'git init failed', err instanceof Error ? err.message : err)
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

