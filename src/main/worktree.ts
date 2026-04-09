import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface WorktreeInfo {
  path: string
  branch: string
  head: string
  isBare: boolean
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot
  })

  const worktrees: WorktreeInfo[] = []
  let current: Partial<WorktreeInfo> = {}

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length)
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '')
    } else if (line === 'bare') {
      current.isBare = true
    } else if (line === '') {
      if (current.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch || '(detached)',
          head: current.head || '',
          isBare: current.isBare || false
        })
      }
      current = {}
    }
  }

  return worktrees
}

export async function addWorktree(
  repoRoot: string,
  name: string
): Promise<WorktreeInfo> {
  const worktreePath = `${repoRoot}/../${name}`
  await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', name], {
    cwd: repoRoot
  })
  const trees = await listWorktrees(repoRoot)
  const created = trees.find((t) => t.branch === name)
  if (!created) throw new Error(`Failed to create worktree ${name}`)
  return created
}

export async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  await execFileAsync('git', ['worktree', 'remove', path], {
    cwd: repoRoot
  })
}
