/** Wire types for the session import browser.
 *
 *  These live in shared/ rather than next to the main-process modules that
 *  produce them because the renderer imports them too, and the renderer never
 *  reaches into main/. The scanner, tree builder and import manager re-export
 *  from here so main-side callers keep importing from the module they use. */

export interface DiscoveredSession {
  sessionId: string
  transcriptPath: string
  /** Working directory the session actually ran in, read from line content. */
  cwd: string | null
  gitBranch: string | null
  title: string | null
  titleSource: 'custom' | 'ai' | 'first-message' | null
  prNumber: number | null
  prUrl: string | null
  prRepository: string | null
  firstTimestamp: number | null
  lastTimestamp: number | null
  /** Count of turns the user would actually see in the transcript. */
  userTurns: number
  /** False when the file was too large to read whole — `userTurns` is then a
   *  lower bound taken from the head+tail chunks. */
  userTurnsExact: boolean
  sizeBytes: number
  mtimeMs: number
  cliVersion: string | null
}

export type SessionGroupKind = 'repo' | 'location' | 'temporary' | 'unknown'

export interface BranchNode {
  key: string
  branch: string | null
  sessions: DiscoveredSession[]
  sessionCount: number
  latestTimestamp: number
  prCount: number
}

export interface SessionGroupNode {
  key: string
  label: string
  kind: SessionGroupKind
  /** Resolved repository root, when one could be determined. */
  path: string | null
  branches: BranchNode[]
  sessionCount: number
  latestTimestamp: number
  prCount: number
}

export interface ImportOutcome {
  ok: boolean
  /** Session id the new tab runs under. Differs from the requested id when
   *  the transcript had to be forked into another worktree. */
  sessionId?: string
  /** How the transcript was attached. 'adopt' resumes the original file in
   *  place; 'fork' copies it into the target worktree's project dir. */
  mode?: 'adopt' | 'fork'
  reason?: string
}
