// Drives a worktree transfer across two backends. This lives in the
// renderer rather than in either main process because neither end can
// see the other: backends don't talk to each other, only the shell that
// holds connections to both does. So the renderer pumps the bytes —
// export handle on one side, import handle on the other, chunks
// shuttled between them.

import { getBackend } from './backend'
import type { TransferExport, TransferImport } from '../shared/transfer'

export interface TransferProgress {
  phase: 'probing' | 'packing' | 'sending' | 'unpacking' | 'done'
  chunk?: number
  chunkCount?: number
}

export interface TransferRequest {
  fromBackendId: string
  toBackendId: string
  worktreePath: string
  /** Where the repo lives on the destination. Paths differ between
   *  machines, so this can't be inferred from the source's repoRoot. */
  destRepoRoot: string
  onProgress?: (p: TransferProgress) => void
}

export async function transferWorktree(req: TransferRequest): Promise<TransferImport> {
  const api = getBackend()
  const report = req.onProgress ?? ((): void => {})

  report({ phase: 'probing' })
  const [from, to] = await Promise.all([
    api.transferProbe(req.fromBackendId),
    api.transferProbe(req.toBackendId)
  ])
  if (!from.git || !to.git) throw new Error('git is missing on one of the machines')

  report({ phase: 'packing' })
  const exported: TransferExport = await api.transferExport(req.fromBackendId, {
    worktreePath: req.worktreePath
  })

  try {
    const { handle: importHandle } = await api.transferBegin(req.toBackendId, {
      repoRoot: req.destRepoRoot,
      branchName: exported.branchName,
      chunkCount: exported.chunkCount,
      totalBytes: exported.totalBytes
    })

    try {
      // Strictly sequential. Both ends address chunks by absolute
      // offset so out-of-order writes would be correct, but overlapping
      // reads would put the whole payload in flight at once — the thing
      // chunking exists to avoid.
      for (let i = 0; i < exported.chunkCount; i++) {
        report({ phase: 'sending', chunk: i + 1, chunkCount: exported.chunkCount })
        const base64 = await api.transferReadChunk(req.fromBackendId, exported.handle, i)
        await api.transferWriteChunk(req.toBackendId, importHandle, i, base64)
      }

      report({ phase: 'unpacking' })
      const result = await api.transferFinish(req.toBackendId, importHandle)
      report({ phase: 'done' })
      return result
    } catch (err) {
      await api.transferDiscard(req.toBackendId, importHandle).catch(() => {})
      throw err
    }
  } finally {
    // The source worktree is untouched either way; this only drops the
    // staged payload.
    await api.transferDiscard(req.fromBackendId, exported.handle).catch(() => {})
  }
}
