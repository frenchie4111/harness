import { useEffect, useRef, useState } from 'react'
import { RightPanel } from './RightPanel'
import { useScratchpad } from '../store'
import { useBackend } from '../backend'

interface ScratchpadPanelProps {
  worktreePath: string | null
}

const FLUSH_DEBOUNCE_MS = 400

export function ScratchpadPanel({ worktreePath }: ScratchpadPanelProps): JSX.Element {
  const backend = useBackend()
  const sliceText = useScratchpad(worktreePath)

  const [localText, setLocalText] = useState<string>(sliceText)
  const lastSyncedPathRef = useRef<string | null>(worktreePath)
  const pendingRef = useRef<{ path: string; text: string } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = (): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    void backend.setScratchpadText(pending.path, pending.text)
  }

  // When the active worktree changes, flush the previous worktree's
  // pending edit (so we don't lose it) and re-seed local state from
  // the slice for the new worktree.
  useEffect(() => {
    if (lastSyncedPathRef.current !== worktreePath) {
      flush()
      lastSyncedPathRef.current = worktreePath
      setLocalText(sliceText)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreePath])

  // If the slice value changes from elsewhere (another client, initial
  // hydration completing) AND we have no pending local edit, mirror it.
  useEffect(() => {
    if (pendingRef.current) return
    if (lastSyncedPathRef.current !== worktreePath) return
    setLocalText(sliceText)
  }, [sliceText, worktreePath])

  // Flush any pending edit on unmount so a panel close doesn't lose it.
  useEffect(() => {
    return () => {
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleChange = (next: string): void => {
    setLocalText(next)
    if (!worktreePath) return
    pendingRef.current = { path: worktreePath, text: next }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(flush, FLUSH_DEBOUNCE_MS)
  }

  const disabled = !worktreePath

  return (
    <RightPanel id="scratchpad" title="Scratchpad" grow>
      <textarea
        className="w-full h-full resize-none px-3 py-2 bg-panel text-fg text-xs border-0 focus:outline-none placeholder:text-faint"
        placeholder="Notes for this worktree…"
        spellCheck={false}
        value={localText}
        disabled={disabled}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={flush}
      />
    </RightPanel>
  )
}
