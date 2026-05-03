import { existsSync } from 'fs'
import { readdir, stat, lstat } from 'fs/promises'
import { join, resolve } from 'path'
import { homedir } from 'os'

export interface FsEntry {
  name: string
  isDir: boolean
  isGitRepo: boolean
  isSymlink: boolean
  truncated?: true
}

export interface ListDirOptions {
  showHidden?: boolean
}

const MAX_ENTRIES = 500

/** True if the directory looks like a git repo. `.git` is a directory in
 *  normal repos and a regular file in linked worktrees, so existsSync is
 *  enough — we deliberately avoid spawning `git rev-parse` per row. */
export function isGitRepoSync(dirPath: string): boolean {
  return existsSync(join(dirPath, '.git'))
}

export async function isGitRepo(dirPath: string): Promise<boolean> {
  return isGitRepoSync(dirPath)
}

export async function resolveHome(): Promise<string> {
  return homedir()
}

export async function listDir(
  dirPath: string,
  opts: ListDirOptions = {}
): Promise<FsEntry[]> {
  const target = resolve(dirPath && dirPath.trim() ? dirPath : homedir())
  let names: string[]
  try {
    names = await readdir(target)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EACCES') throw new Error(`Permission denied: ${target}`)
    if (err.code === 'ENOENT') throw new Error(`No such directory: ${target}`)
    if (err.code === 'ENOTDIR') throw new Error(`Not a directory: ${target}`)
    throw new Error(err.message || String(err))
  }

  const filtered = opts.showHidden
    ? names
    : names.filter((n) => !n.startsWith('.'))

  // isDir is the symlink TARGET kind (stat), isSymlink is intrinsic (lstat).
  // Broken symlinks throw on stat and are silently dropped.
  const entries: FsEntry[] = []
  for (const name of filtered) {
    const full = join(target, name)
    try {
      const [linkInfo, info] = await Promise.all([lstat(full), stat(full)])
      const isDir = info.isDirectory()
      entries.push({
        name,
        isDir,
        isGitRepo: isDir && isGitRepoSync(full),
        isSymlink: linkInfo.isSymbolicLink()
      })
    } catch {
      // Skip unreadable entries (broken symlinks, permission issues per row).
    }
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  if (entries.length > MAX_ENTRIES) {
    const truncated = entries.slice(0, MAX_ENTRIES)
    truncated.push({
      name: `… (${entries.length - MAX_ENTRIES} more entries hidden)`,
      isDir: false,
      isGitRepo: false,
      isSymlink: false,
      truncated: true
    })
    return truncated
  }
  return entries
}
