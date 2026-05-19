import { execFile } from 'child_process'
import { promisify } from 'util'
import { realpathSync } from 'fs'
import { resolve as resolvePath } from 'path'
import { isGitRepoSync } from './fs-listing'
import type { RepoPathResolution } from '../shared/repo-pick'

const execFileAsync = promisify(execFile)

export type { RepoPathResolution }

/** Map a user-picked folder to the git toplevel git would actually use
 *  if we ran `git worktree …` inside it.
 *
 *  The non-'ok' variants must surface to the user — silently registering
 *  the walked-up ancestor would happily manage `$HOME` (or whatever
 *  ancestor is a repo) without the user knowing.
 *
 *  Both sides are passed through `realpath` before comparing so the
 *  macOS `/private` symlink prefix doesn't trip a spurious walk-up.
 */
export async function resolveRepoPath(picked: string): Promise<RepoPathResolution> {
  if (!picked || typeof picked !== 'string') {
    return { kind: 'not-a-repo', picked: picked || '' }
  }
  const pickedAbs = resolvePath(picked)

  // Fast path: picked already has its own `.git` so git wouldn't walk
  // up. Run through `realpath` so we store the canonical form git
  // reports back from `worktree list` — otherwise paths under symlink
  // prefixes (macOS `/tmp` → `/private/tmp`) silently break the
  // `isMain: path === repoRoot` match in listWorktrees.
  if (isGitRepoSync(pickedAbs)) {
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
