// A session forked into a new worktree resumes with a transcript full of
// successful Edit/Write calls whose results are not necessarily on disk
// anymore: the new worktree branches from a base ref, so neither the source
// branch's commits nor its uncommitted working tree are guaranteed to come
// along. Left to itself the agent assumes its edits landed, and then either
// rebuilds work that is already there or re-applies edits to a file that
// never had them.
//
// So we probe the real git relationship between the two worktrees at fork
// time and state the answer plainly, rather than emitting a generic "things
// may have changed" hedge the agent can reasonably ignore.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { log } from './debug'

const execFileAsync = promisify(execFile)

export interface RelocationContext {
  sourceWorktreePath: string
  destWorktreePath: string
  baseRef?: string
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    return null
  }
}

/** Parse `git status --porcelain` v1 output into paths. The two status
 *  columns are fixed-width and the first is a space for unstaged-only
 *  changes, so lines must NOT be left-trimmed before slicing. */
export function parsePorcelainPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trimEnd())
    .filter(Boolean)
    .map((p) => {
      // Renames are recorded as "old -> new"; the new path is what exists.
      const arrow = p.indexOf(' -> ')
      return arrow >= 0 ? p.slice(arrow + 4) : p
    })
}

async function uncommittedPaths(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd })
  return parsePorcelainPaths(stdout)
}

/** Whether the source worktree's committed history is reachable from the
 *  new worktree's HEAD. This is the question that actually matters — not
 *  "same branch?" — because a new worktree cut from the source branch does
 *  carry its commits, while one cut from main does not. */
async function sourceCommitsReachable(ctx: RelocationContext): Promise<boolean> {
  const sourceHead = await git(ctx.sourceWorktreePath, ['rev-parse', 'HEAD'])
  try {
    await git(ctx.destWorktreePath, ['merge-base', '--is-ancestor', sourceHead, 'HEAD'])
    return true
  } catch {
    // Non-zero exit means "not an ancestor". Distinguishing that from a
    // genuine git failure isn't worth it: an unknown commit is also absent.
    return false
  }
}

function formatFileList(paths: string[]): string {
  const shown = paths.slice(0, 10)
  const rest = paths.length - shown.length
  const list = shown.map((p) => `\`${p}\``).join(', ')
  return rest > 0 ? `${list}, and ${rest} more` : list
}

/** Describe, concretely, which of the agent's earlier changes survived the
 *  move. Returns null if git couldn't be probed, so the caller can fall
 *  back to an explicitly-uncertain phrasing instead of a confident wrong
 *  one. */
async function describeSurvivingWork(ctx: RelocationContext): Promise<string | null> {
  let reachable: boolean
  let dirty: string[]
  try {
    reachable = await sourceCommitsReachable(ctx)
    dirty = await uncommittedPaths(ctx.sourceWorktreePath)
  } catch (err) {
    log('fork', 'relocation git probe failed', err instanceof Error ? err.message : err)
    return null
  }

  const parts: string[] = []
  if (reachable) {
    parts.push(
      'Committed work from the previous worktree IS present here — its HEAD is an ancestor of this branch, so anything you committed there is on disk.'
    )
  } else {
    const from = ctx.baseRef ? `\`${ctx.baseRef}\`` : 'the repository default base branch'
    parts.push(
      `Committed work from the previous worktree is NOT present here. This branch was created from ${from}, and the previous branch's commits are not in its history. Anything you committed earlier in this conversation is absent from this checkout.`
    )
  }

  if (dirty.length === 0) {
    parts.push('The previous worktree had no uncommitted changes, so nothing was left behind uncommitted.')
  } else {
    parts.push(
      `The previous worktree also had ${dirty.length} uncommitted file(s) which did NOT come along: ${formatFileList(dirty)}. Any edits you made to those files are absent here.`
    )
  }

  return parts.join(' ')
}

/** Build the note prepended to the new session's kickoff prompt. Delivered
 *  as part of the first user turn (rather than as a synthesized transcript
 *  line) so it lands identically on the json-mode and terminal paths, and
 *  so the user can see exactly what was injected. */
export async function buildRelocationPreamble(ctx: RelocationContext): Promise<string> {
  const [sourceBranch, destBranch, surviving] = await Promise.all([
    currentBranch(ctx.sourceWorktreePath),
    currentBranch(ctx.destWorktreePath),
    describeSurvivingWork(ctx)
  ])

  const sourceLabel = sourceBranch ? ` (branch \`${sourceBranch}\`)` : ''
  const destLabel = destBranch ? ` (branch \`${destBranch}\`)` : ''

  const survivingLine =
    surviving ??
    'Ness could not determine which of your earlier changes are present here. Treat every edit you made earlier as unverified and check the files before building on them.'

  return [
    '[Ness] You have been moved to a new git worktree. Read this before continuing.',
    '',
    'The conversation above is real and it is yours, but it happened somewhere else on disk.',
    '',
    `- You are now working in: ${ctx.destWorktreePath}${destLabel}`,
    `- That history happened in: ${ctx.sourceWorktreePath}${sourceLabel}`,
    `- ${survivingLine}`,
    '- Absolute paths in the conversation above point at the OLD worktree. Re-resolve them against the new path before reading or writing. Do not read from or write to the old worktree — it is a separate checkout someone else may be using.',
    '',
    'Before you build on any file you edited earlier, check its current contents here. Do not assume an edit from the history above is present in this worktree.',
    '',
    '---',
    ''
  ].join('\n')
}
