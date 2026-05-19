import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, realpathSync } from 'fs'
import { join, resolve as resolvePath } from 'path'

const execFileAsync = promisify(execFile)

export type RepoPathResolution =
  | { kind: 'ok'; root: string }
  | { kind: 'walked-up'; picked: string; resolved: string }
  | { kind: 'not-a-repo'; picked: string }

/** Map a user-picked folder to the git toplevel git would actually use
 *  if we ran `git worktree …` inside it.
 *
 *  Three outcomes — see `AddRepoResult` in shared/repo-pick.ts for the
 *  matching renderer-facing shape:
 *
 *  - 'ok' — picked is itself a git repo root; safe to register as-is.
 *  - 'walked-up' — picked has no `.git`, but git's upward discovery
 *    found a real repo at `resolved`. Caller must surface both paths
 *    to the user before registering, otherwise we silently end up
 *    managing whatever ancestor (often `$HOME`) happens to be a repo.
 *  - 'not-a-repo' — git can't find a repository anywhere up the tree.
 *
 *  Both sides are passed through `realpath` before comparing so the
 *  macOS `/private` symlink prefix doesn't trip a spurious walk-up.
 */
export async function resolveRepoPath(picked: string): Promise<RepoPathResolution> {
  if (!picked || typeof picked !== 'string') {
    return { kind: 'not-a-repo', picked: picked || '' }
  }
  const pickedAbs = resolvePath(picked)

  // Fast path: a `.git` (dir for repos, file for linked worktrees) at
  // the picked folder means git wouldn't walk up. Skip the subprocess.
  // Run through `realpath` so we store the canonical form git reports
  // back from `worktree list` — otherwise paths under symlink prefixes
  // (e.g. macOS `/tmp` → `/private/tmp`) silently break the
  // `isMain: path === repoRoot` match in listWorktrees.
  if (existsSync(join(pickedAbs, '.git'))) {
    let root = pickedAbs
    try { root = realpathSync(pickedAbs) } catch {}
    return { kind: 'ok', root }
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: pickedAbs }
    )
    const resolved = stdout.trim()
    if (!resolved) return { kind: 'not-a-repo', picked: pickedAbs }

    let pickedReal = pickedAbs
    let resolvedReal = resolved
    try { pickedReal = realpathSync(pickedAbs) } catch {}
    try { resolvedReal = realpathSync(resolved) } catch {}
    if (pickedReal === resolvedReal) {
      return { kind: 'ok', root: resolved }
    }
    return { kind: 'walked-up', picked: pickedAbs, resolved }
  } catch {
    return { kind: 'not-a-repo', picked: pickedAbs }
  }
}
