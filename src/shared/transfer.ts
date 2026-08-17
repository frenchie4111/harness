// Worktree transfer — moving a worktree (code, uncommitted work and
// chat transcripts) from one Harness backend to another.
//
// Split of responsibilities, because two tools own different halves:
//
//   - git owns the code. A bundle carries the branch's commits, and a
//     `git stash create` commit carries the uncommitted work without
//     touching the source working tree.
//   - lochy owns the transcripts. They live outside the repo in
//     ~/.claude/projects/<slug>/, where the slug is derived from the
//     worktree's absolute path, so they cannot ride along in git and
//     need their paths rewritten for the destination.
//
// COPY, NOT MOVE. The source worktree is left completely intact — this
// transfer never deletes anything. Two reasons. A failed import should
// not be able to destroy the only copy of someone's uncommitted work,
// and a copy is the operation you can retry. The obvious cost of
// copying is that the same session ids become resumable on two
// machines, which double-counts in cost aggregation; we avoid that by
// restoring with lochy's `--new-id`, so the destination gets fresh
// session ids and the two machines never claim the same session.

/** What a backend can do, probed before a transfer starts. A backend
 *  missing lochy can still send and receive code — it just can't carry
 *  transcripts, and the caller should say so rather than silently
 *  transferring half of what the user asked for. */
export interface TransferCapability {
  /** False when lochy isn't installed or predates `--json`. Per lochy's
   *  contract, empty-or-unparseable stdout means no process ran, so we
   *  cannot distinguish "absent" from "too old" and don't try. */
  lochy: boolean
  git: boolean
  platform: NodeJS.Platform
}

export interface TransferSessionSummary {
  sessionId: string
  branch: string | null
  bytes: number
  /** Redaction counts by rule name, as reported by lochy save. The
   *  matched text is never included, by lochy's policy. */
  redactions: Record<string, number>
}

/** Result of packing a worktree on the source backend. The payload
 *  itself is not inlined — it's read back in chunks via
 *  `transfer:readChunk` so a large bundle doesn't have to fit in one
 *  JSON RPC message. */
export interface TransferExport {
  handle: string
  repoRoot: string
  branchName: string
  worktreePath: string
  /** Present when the source worktree had uncommitted changes. This is
   *  a `git stash create` commit, bundled along with the branch, that
   *  the destination applies after checkout. */
  stashSha: string | null
  /** The single content-addressed ref covering every session lochy
   *  found for this worktree — one `save` produces one ref, not one per
   *  session, so the import side restores all transcripts in one call. */
  lochyRef: string | null
  totalBytes: number
  chunkCount: number
  sessions: TransferSessionSummary[]
  /** Total redactions across all sessions — surface this before the
   *  bytes leave the machine. */
  redacted: number
  /** Non-null when lochy was unavailable, in which case `sessions` is
   *  empty and only code was packed. */
  transcriptsSkipped: string | null
}

export interface TransferImportedSession {
  sessionId: string
  originSessionId: string
  /** Paths belonging to the origin machine that survived lochy's
   *  rewrite. Non-empty means the restored session references files
   *  that don't exist here — a correctness warning, not a failure. */
  residualOriginPaths: string[]
  resumeCommand: string
}

/** Independent check that restored transcripts point at the worktree we
 *  put them in. Deliberately does not consult lochy's own reporting: a
 *  restore that rewrites paths wrongly still reports success, and its
 *  residual-path detector cannot see the case where a wrong-but-
 *  well-formed path replaced the origin one. Counted by reading the
 *  restored files back. */
export interface TranscriptPathCheck {
  /** Records carrying a top-level `cwd`. Zero means nothing was
   *  verifiable, which is not the same as everything being correct. */
  checked: number
  /** Records whose `cwd` is the worktree the import created. */
  correct: number
  /** Every other `cwd`, by value, with a count. These name directories
   *  that need not exist here, so a resumed session opens somewhere
   *  wrong. Non-empty is a correctness warning, not a failure — the
   *  transcript content itself is intact. */
  foreign: Record<string, number>
}

export interface TransferImport {
  /** The worktree path as the DESTINATION resolved it. Not necessarily
   *  the path that was requested: on macOS /tmp resolves to /private/tmp,
   *  and lochy derives the transcript directory slug from the resolved
   *  form. Always use this value when locating transcripts or opening
   *  the worktree — computing a slug from the requested path finds a
   *  directory that doesn't exist, and the transfer silently appears to
   *  have produced nothing. */
  worktreePath: string
  branchName: string
  stashApplied: boolean
  sessions: TransferImportedSession[]
  /** Aggregated across sessions so the caller can warn without walking
   *  the list. */
  hasResidualPaths: boolean
  transcriptsSkipped: string | null
  /** Null when no transcripts were restored. */
  transcriptPathCheck: TranscriptPathCheck | null
}

/** Chunk size for the base64 legs. The transport is JSON, so payload
 *  bytes cost ~4/3 on the wire; 4 MiB of source bytes lands around
 *  5.3 MB of JSON per message, which is large enough that a multi-
 *  hundred-MB bundle doesn't turn into thousands of round trips and
 *  small enough not to stall the socket behind one message. */
export const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024
