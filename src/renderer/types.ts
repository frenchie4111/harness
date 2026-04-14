import type { StateEvent, StateSnapshot } from '../shared/state'
export type { StateEvent, StateSnapshot }

export interface Worktree {
  path: string
  branch: string
  head: string
  isBare: boolean
  isMain: boolean
  /** Directory birthtime in ms since epoch; 0 if unavailable. */
  createdAt: number
  /** Repo this worktree belongs to. Set by the renderer after a cross-repo listWorktrees merge. */
  repoRoot: string
}

export interface PendingWorktree {
  /** Prefixed id like `pending:<uuid>` so App state can use it as an activeWorktreeId. */
  id: string
  repoRoot: string
  branchName: string
  status: 'creating' | 'setup' | 'setup-failed' | 'error'
  error?: string
  initialPrompt?: string
  teleportSessionId?: string
  setupLog?: string
  setupExitCode?: number
}

export interface RepoConfig {
  version?: number
  setupCommand?: string
  teardownCommand?: string
  mergeStrategy?: 'squash' | 'merge-commit' | 'fast-forward'
  hideMergePanel?: boolean
  hidePrPanel?: boolean
}

export interface WorktreeScriptEvent {
  runId: string
  phase: 'setup' | 'teardown'
  type: 'start' | 'output' | 'end'
  stream?: 'stdout' | 'stderr'
  data?: string
  ok?: boolean
  exitCode?: number
}

export interface FileReadResult {
  content: string | null
  size: number
  binary: boolean
  truncated: boolean
  error?: string
}

export interface TerminalTab {
  id: string
  type: 'claude' | 'shell' | 'diff' | 'file'
  label: string
  /** For diff/file tabs: the file path */
  filePath?: string
  /** For diff tabs: whether the diff is for staged changes */
  staged?: boolean
  /** For diff tabs: show the branch diff (base...HEAD) instead of working-tree diff */
  branchDiff?: boolean
  /** For diff tabs: when set, show this commit's full diff instead of a file diff */
  commitHash?: string
  /** For claude tabs: UUID passed to `claude --session-id` so the tab resumes its own session. */
  sessionId?: string
  /** For claude tabs: one-shot kickoff prompt appended to the claude command on first spawn. Not persisted. */
  initialPrompt?: string
  /** For claude tabs: one-shot teleport session id. When set, spawns `claude --teleport <id>` instead of the normal flow. Not persisted. */
  teleportSessionId?: string
}

export interface PersistedTab {
  id: string
  type: 'claude' | 'shell'
  label: string
  sessionId?: string
}

export interface WorkspacePane {
  id: string
  tabs: TerminalTab[]
  activeTabId: string
}

export interface PersistedPane {
  id: string
  tabs: PersistedTab[]
  activeTabId: string
}

export type PtyStatus = 'idle' | 'processing' | 'waiting' | 'needs-approval'

export interface PendingTool {
  name: string
  input: Record<string, unknown>
}

export type QuestStep = 'hidden' | 'spawn-second' | 'switch-between' | 'finale' | 'done'

export type UpdaterStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; error: string }

export interface CommitDiff {
  hash: string
  shortHash: string
  author: string
  authorEmail: string
  date: string
  subject: string
  body: string
  diff: string
}

export interface BranchCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  relativeDate: string
  timestamp: number
}

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

export interface CheckStatus {
  name: string
  state: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'error'
  description: string
  /** Longer failure summary from the check's output (markdown, may be multi-line) */
  summary?: string
  /** External URL to the check's log / details page */
  detailsUrl?: string
}

export type MergeStrategy = 'squash' | 'merge-commit' | 'fast-forward'

export interface MainWorktreeStatus {
  path: string
  currentBranch: string
  baseBranch: string
  isOnBase: boolean
  isDirty: boolean
  ready: boolean
}

export interface MergeConflictPreview {
  hasConflict: boolean
  files: string[]
  unsupported?: boolean
}

export interface MergeLocalResult {
  ok: true
  strategy: MergeStrategy
  mergedBranch: string
  baseBranch: string
  mainPath: string
}

export interface PRReview {
  user: string
  avatarUrl: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  body: string
  submittedAt: string
  htmlUrl: string
}

export interface PRStatus {
  number: number
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  url: string
  branch: string
  checks: CheckStatus[]
  checksOverall: 'success' | 'failure' | 'pending' | 'none'
  /** true = has conflicts with base, false = mergeable, null = still computing */
  hasConflict: boolean | null
  reviews: PRReview[]
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | 'none'
}

export interface ElectronAPI {
  listWorktrees(repoRoot: string): Promise<Worktree[]>
  listBranches(repoRoot: string): Promise<string[]>
  addWorktree(repoRoot: string, branchName: string, baseBranch?: string, runId?: string): Promise<Worktree>
  onWorktreeScriptEvent(callback: (event: WorktreeScriptEvent) => void): () => void
  continueWorktree(
    repoRoot: string,
    worktreePath: string,
    newBranchName: string,
    baseBranch?: string
  ): Promise<{ worktree: Worktree; stashReapplied: boolean; stashConflict: boolean }>
  isWorktreeDirty(path: string): Promise<boolean>
  removeWorktree(
    repoRoot: string,
    path: string,
    force?: boolean,
    removeMeta?: { prNumber?: number; prState?: PRStatus['state'] }
  ): Promise<void>
  getWorktreeDir(repoRoot: string): Promise<string>
  listRepos(): Promise<string[]>
  addRepo(): Promise<string | null>
  removeRepo(repoRoot: string): Promise<boolean>
  onReposChanged(callback: (repos: string[]) => void): () => void

  getPRStatus(worktreePath: string): Promise<PRStatus | null>
  getMainWorktreeStatus(repoRoot: string): Promise<MainWorktreeStatus>
  prepareMainForMerge(repoRoot: string): Promise<MainWorktreeStatus>
  previewMergeConflicts(repoRoot: string, sourceBranch: string): Promise<MergeConflictPreview>
  mergeWorktreeLocally(
    repoRoot: string,
    sourceBranch: string,
    strategy: MergeStrategy
  ): Promise<MergeLocalResult>
  getMergedStatus(repoRoot: string): Promise<Record<string, boolean>>
  getBranchCommits(worktreePath: string): Promise<BranchCommit[]>
  getCommitDiff(worktreePath: string, hash: string): Promise<CommitDiff | null>
  listAllFiles(worktreePath: string): Promise<string[]>
  readWorktreeFile(worktreePath: string, filePath: string): Promise<FileReadResult>
  getChangedFiles(worktreePath: string, mode?: 'working' | 'branch'): Promise<ChangedFile[]>
  getFileDiff(
    worktreePath: string,
    filePath: string,
    staged: boolean,
    mode?: 'working' | 'branch'
  ): Promise<string>

  getHotkeyOverrides(): Promise<Record<string, string> | null>
  setHotkeyOverrides(hotkeys: Record<string, string>): Promise<boolean>
  resetHotkeyOverrides(): Promise<boolean>
  onHotkeysChanged(callback: (hotkeys: Record<string, string> | null) => void): () => void

  getClaudeCommand(): Promise<string>
  setClaudeCommand(command: string): Promise<boolean>
  getDefaultClaudeCommand(): Promise<string>
  onClaudeCommandChanged(callback: (command: string) => void): () => void
  getHarnessMcpEnabled(): Promise<boolean>
  setHarnessMcpEnabled(enabled: boolean): Promise<boolean>
  onHarnessMcpEnabledChanged(callback: (enabled: boolean) => void): () => void
  prepareMcpForTerminal(terminalId: string): Promise<string | null>
  onWorktreesExternalCreate(
    callback: (payload: { repoRoot: string; worktree: Worktree; initialPrompt?: string }) => void
  ): () => void

  getClaudeEnvVars(): Promise<Record<string, string>>
  setClaudeEnvVars(vars: Record<string, string>): Promise<boolean>
  onClaudeEnvVarsChanged(callback: (vars: Record<string, string>) => void): () => void

  getNameClaudeSessions(): Promise<boolean>
  setNameClaudeSessions(enabled: boolean): Promise<boolean>
  onNameClaudeSessionsChanged(callback: (enabled: boolean) => void): () => void

  getTheme(): Promise<string>
  setTheme(theme: string): Promise<boolean>
  getAvailableThemes(): Promise<readonly string[]>

  getTerminalFontFamily(): Promise<string>
  setTerminalFontFamily(fontFamily: string): Promise<boolean>
  getDefaultTerminalFontFamily(): Promise<string>
  onTerminalFontFamilyChanged(callback: (fontFamily: string) => void): () => void
  getTerminalFontSize(): Promise<number>
  setTerminalFontSize(fontSize: number): Promise<boolean>
  onTerminalFontSizeChanged(callback: (fontSize: number) => void): () => void

  getOnboarding(): Promise<{ quest?: QuestStep }>
  setOnboardingQuest(quest: QuestStep): Promise<boolean>

  getWorktreeScripts(): Promise<{ setup: string; teardown: string }>
  setWorktreeScripts(scripts: { setup: string; teardown: string }): Promise<boolean>
  getRepoConfig(repoRoot: string): Promise<RepoConfig>
  setRepoConfig(repoRoot: string, next: Partial<RepoConfig>): Promise<RepoConfig | null>
  getEffectiveMergeStrategy(repoRoot: string): Promise<MergeStrategy>
  onRepoConfigChanged(
    callback: (payload: { repoRoot: string; config: RepoConfig }) => void
  ): () => void

  getWorktreeBase(): Promise<'remote' | 'local'>
  setWorktreeBase(mode: 'remote' | 'local'): Promise<boolean>
  getMergeStrategy(): Promise<MergeStrategy>
  setMergeStrategy(strategy: MergeStrategy): Promise<boolean>

  getEditor(): Promise<string>
  setEditor(editorId: string): Promise<boolean>
  getAvailableEditors(): Promise<{ id: string; name: string }[]>
  openInEditor(worktreePath: string, filePath?: string): Promise<{ ok: true } | { ok: false; error: string }>
  onEditorChanged(callback: (editorId: string) => void): () => void

  getWorkspacePanes(): Promise<Record<string, Record<string, PersistedPane[]>>>
  setWorkspacePanes(panes: Record<string, Record<string, PersistedPane[]>>): Promise<boolean>
  saveTerminalHistory(id: string, content: string): Promise<boolean>
  saveTerminalHistorySync(id: string, content: string): void
  loadTerminalHistory(id: string): Promise<string | null>
  clearTerminalHistory(id: string): Promise<boolean>
  claudeSessionFileExists(cwd: string, sessionId: string): Promise<boolean>
  getLatestClaudeSessionId(cwd: string): Promise<string | null>

  hasGithubToken(): Promise<boolean>
  setGithubToken(token: string, options?: { starRepo?: boolean }): Promise<{ ok: boolean; username?: string; error?: string; starred?: boolean }>
  clearGithubToken(): Promise<boolean>

  getVersion(): Promise<string>
  checkForUpdates(): Promise<{ ok: boolean; available?: boolean; version?: string; releaseDate?: string; error?: string }>
  quitAndInstall(): Promise<boolean>
  onUpdaterStatus(callback: (status: UpdaterStatus) => void): () => void

  openExternal(url: string): void
  getFilePath(file: File): string
  onOpenSettings(callback: () => void): () => void

  checkHooks(worktreePath: string): Promise<boolean>
  installHooks(worktreePath: string): Promise<boolean>

  createTerminal(id: string, cwd: string, cmd: string, args: string[], isClaude?: boolean): void
  writeTerminal(id: string, data: string): void
  resizeTerminal(id: string, cols: number, rows: number): void
  killTerminal(id: string): void
  onTerminalData(callback: (id: string, data: string) => void): () => void
  onStatusChange(
    callback: (id: string, status: PtyStatus, pendingTool: PendingTool | null) => void
  ): () => void
  onShellActivity(
    callback: (id: string, payload: { active: boolean; processName?: string }) => void
  ): () => void
  onTerminalExit(callback: (id: string, exitCode: number) => void): () => void

  recordActivity(worktreePath: string, state: string): void
  getActivityLog(): Promise<ActivityLog>
  clearActivityLog(worktreePath?: string): Promise<boolean>

  getStateSnapshot(): Promise<StateSnapshot>
  onStateEvent(callback: (event: StateEvent, seq: number) => void): () => void
}

export type ActivityState = 'processing' | 'waiting' | 'needs-approval' | 'idle' | 'merged'
export interface ActivityEvent { t: number; s: ActivityState }
export interface ActivityDiffStats {
  added: number
  removed: number
  files: number
}
export interface ActivityRecord {
  branch?: string
  repoRoot?: string
  createdAt?: number
  removedAt?: number
  diffStats?: ActivityDiffStats
  prNumber?: number
  prState?: PRStatus['state']
  events: ActivityEvent[]
}
export type ActivityLog = Record<string, ActivityRecord>

declare global {
  interface Window {
    api: ElectronAPI
  }
}
