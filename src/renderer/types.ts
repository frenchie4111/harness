export interface Worktree {
  path: string
  branch: string
  head: string
  isBare: boolean
  isMain: boolean
}

export interface TerminalTab {
  id: string
  type: 'claude' | 'shell' | 'diff'
  label: string
  /** For diff tabs: the file path being diffed */
  filePath?: string
  /** For diff tabs: whether the diff is for staged changes */
  staged?: boolean
  /** For diff tabs: show the branch diff (base...HEAD) instead of working-tree diff */
  branchDiff?: boolean
  /** For claude tabs: UUID passed to `claude --session-id` so the tab resumes its own session. */
  sessionId?: string
  /** For claude tabs: one-shot kickoff prompt appended to the claude command on first spawn. Not persisted. */
  initialPrompt?: string
}

export interface PersistedTab {
  id: string
  type: 'claude' | 'shell'
  label: string
  sessionId?: string
}

export type PtyStatus = 'idle' | 'processing' | 'waiting' | 'needs-approval'

export type QuestStep = 'hidden' | 'spawn-second' | 'switch-between' | 'finale' | 'done'

export type UpdaterStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; error: string }

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
}

export interface ElectronAPI {
  listWorktrees(): Promise<Worktree[]>
  listBranches(): Promise<string[]>
  addWorktree(branchName: string, baseBranch?: string): Promise<Worktree>
  continueWorktree(
    worktreePath: string,
    newBranchName: string,
    baseBranch?: string
  ): Promise<{ worktree: Worktree; stashReapplied: boolean; stashConflict: boolean }>
  isWorktreeDirty(path: string): Promise<boolean>
  removeWorktree(path: string, force?: boolean): Promise<void>
  getWorktreeDir(): Promise<string>
  selectRepoRoot(): Promise<string | null>
  getRepoRoot(): Promise<string | null>

  getPRStatus(worktreePath: string): Promise<PRStatus | null>
  getMainWorktreeStatus(): Promise<MainWorktreeStatus>
  prepareMainForMerge(): Promise<MainWorktreeStatus>
  previewMergeConflicts(sourceBranch: string): Promise<MergeConflictPreview>
  mergeWorktreeLocally(
    sourceBranch: string,
    strategy: MergeStrategy
  ): Promise<MergeLocalResult>
  getMergedStatus(): Promise<Record<string, boolean>>
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

  getTheme(): Promise<string>
  setTheme(theme: string): Promise<boolean>
  getAvailableThemes(): Promise<readonly string[]>
  onThemeChanged(callback: (theme: string) => void): () => void

  getOnboarding(): Promise<{ quest?: QuestStep }>
  setOnboardingQuest(quest: QuestStep): Promise<boolean>

  getWorktreeBase(): Promise<'remote' | 'local'>
  setWorktreeBase(mode: 'remote' | 'local'): Promise<boolean>
  getMergeStrategy(): Promise<MergeStrategy>
  setMergeStrategy(strategy: MergeStrategy): Promise<boolean>

  getEditor(): Promise<string>
  setEditor(editorId: string): Promise<boolean>
  getAvailableEditors(): Promise<{ id: string; name: string }[]>
  openInEditor(worktreePath: string, filePath?: string): Promise<{ ok: true } | { ok: false; error: string }>
  onEditorChanged(callback: (editorId: string) => void): () => void

  getTerminalTabs(): Promise<{
    tabs: Record<string, PersistedTab[]>
    activeTabId: Record<string, string>
  }>
  setTerminalTabs(
    tabs: Record<string, PersistedTab[]>,
    activeTabId: Record<string, string>
  ): Promise<boolean>
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
  onOpenSettings(callback: () => void): () => void

  checkHooks(worktreePath: string): Promise<boolean>
  installHooks(worktreePath: string): Promise<boolean>

  createTerminal(id: string, cwd: string, cmd: string, args: string[]): void
  writeTerminal(id: string, data: string): void
  resizeTerminal(id: string, cols: number, rows: number): void
  killTerminal(id: string): void
  onTerminalData(callback: (id: string, data: string) => void): () => void
  onStatusChange(callback: (id: string, status: PtyStatus) => void): () => void
  onTerminalExit(callback: (id: string, exitCode: number) => void): () => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
