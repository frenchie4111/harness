import { useEffect, useRef } from 'react'
import { useBackend } from '../backend'

/** Subscribes to disk-change notifications for a single (worktreePath,
 *  relativePath) file and invokes `onChange` when the file's content
 *  changes on disk. Used by FileView and ReviewDiffPane to refresh
 *  when an agent in another tab — or any external editor — writes the
 *  same file the user is looking at.
 *
 *  Uses a ref to hold the latest `onChange` so the subscription effect
 *  doesn't re-run on every parent re-render. */
export function useFileContentChange(
  worktreePath: string | undefined,
  relativePath: string | undefined,
  onChange: () => void
): void {
  const backend = useBackend()
  const handlerRef = useRef(onChange)
  handlerRef.current = onChange

  useEffect(() => {
    if (!worktreePath || !relativePath) return
    backend.watchFile(worktreePath, relativePath)
    const off = backend.onFileContentChanged((wt, rel) => {
      if (wt !== worktreePath || rel !== relativePath) return
      handlerRef.current()
    })
    return () => {
      off()
      backend.unwatchFile(worktreePath, relativePath)
    }
  }, [worktreePath, relativePath, backend])
}
