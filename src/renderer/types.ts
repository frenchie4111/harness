import type { StateEvent, StateSnapshot } from '../shared/state'
export type { StateEvent, StateSnapshot }

import type { Worktree, PendingWorktree } from '../shared/state/worktrees'
export type { Worktree, PendingWorktree }

export interface RepoConfig {
  version?: number
  setupCommand?: string
  teardownCommand?: string
  mergeStrategy?: 'squash' | 'merge-commit' | 'fast-forward'
  hideMergePanel?: boolean
  hidePrPanel?: boolean
}

export interface FileReadResult {
  content: string | null
  size: number
  binary: boolean
  truncated: boolean
  error?: string
}

import type {
  PtyStatus,
  PendingTool,
  TerminalTab,
  WorkspacePane
} from '../shared/state/terminals'
export type { PtyStatus, PendingTool, TerminalTab, WorkspacePane }

export interface PersistedTab {
  id: string
  type: 'claude' | 'shell'
  label: string
  sessionId?: string
}

export interface PersistedPane {
  id: string
  tabs: PersistedTab[]
  activeTabId: string
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

import type { CheckStatus, PRReview, PRStatus } from '../shared/state/prs'
export type { CheckStatus, PRReview, PRStatus }

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

export interface ElectronAPI {
  listWorktrees(repoRoot: string): Promise<Worktree[]>
  listBranches(repoRoot: string): Promise<string[]>
  runPendingWorktree(params: {
    id: string
    repoRoot: string
    branchName: string
    initialPrompt?: string
    teleportSessionId?: string
  }): Promise<
    | { id: string; outcome: 'success'; createdPath: string }
    | { id: string; outcome: 'setup-failed'; createdPath: string }
    | { id: string; outcome: 'error'; error: string }
  >
  retryPendingWorktree(id: string): Promise<
    | { id: string; outcome: 'success'; createdPath: string }
    | { id: string; outcome: 'setup-failed'; createdPath: string }
    | { id: string; outcome: 'error'; error: string }
  >
  dismissPendingWorktree(id: string): Promise<boolean>
  refreshWorktreesList(): Promise<boolean>
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

  getMainWorktreeStatus(repoRoot: string): Promise<MainWorktreeStatus>
  prepareMainForMerge(repoRoot: string): Promise<MainWorktreeStatus>
  previewMergeConflicts(repoRoot: string, sourceBranch: string): Promise<MergeConflictPreview>
  mergeWorktreeLocally(
    repoRoot: string,
    sourceBranch: string,
    strategy: MergeStrategy
  ): Promise<MergeLocalResult>

  refreshPRsAll(): Promise<boolean>
  refreshPRsAllIfStale(): Promise<boolean>
  refreshPRsOne(worktreePath: string): Promise<boolean>
  refreshPRsOneIfStale(worktreePath: string): Promise<boolean>
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

  getClaudeCommand(): Promise<string>
  setClaudeCommand(command: string): Promise<boolean>
  getDefaultClaudeCommand(): Promise<string>
  getHarnessMcpEnabled(): Promise<boolean>
  setHarnessMcpEnabled(enabled: boolean): Promise<boolean>
  prepareMcpForTerminal(terminalId: string): Promise<string | null>
  onWorktreesExternalCreate(
    callback: (payload: { repoRoot: string; worktree: Worktree; initialPrompt?: string }) => void
  ): () => void

  getClaudeEnvVars(): Promise<Record<string, string>>
  setClaudeEnvVars(vars: Record<string, string>): Promise<boolean>

  getNameClaudeSessions(): Promise<boolean>
  setNameClaudeSessions(enabled: boolean): Promise<boolean>

  getTheme(): Promise<string>
  setTheme(theme: string): Promise<boolean>
  getAvailableThemes(): Promise<readonly string[]>

  getTerminalFontFamily(): Promise<string>
  setTerminalFontFamily(fontFamily: string): Promise<boolean>
  getDefaultTerminalFontFamily(): Promise<string>
  getTerminalFontSize(): Promise<number>
  setTerminalFontSize(fontSize: number): Promise<boolean>

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

  panesAddTab(wtPath: string, tab: TerminalTab, paneId?: string): Promise<boolean>
  panesCloseTab(wtPath: string, tabId: string): Promise<boolean>
  panesRestartClaudeTab(
    wtPath: string,
    tabId: string,
    newId: string,
    newSessionId: string
  ): Promise<boolean>
  panesSelectTab(wtPath: string, paneId: string, tabId: string): Promise<boolean>
  panesReorderTabs(
    wtPath: string,
    paneId: string,
    fromId: string,
    toId: string
  ): Promise<boolean>
  panesMoveTabToPane(
    wtPath: string,
    tabId: string,
    toPaneId: string,
    toIndex?: number
  ): Promise<boolean>
  panesSplitPane(wtPath: string, fromPaneId: string): Promise<WorkspacePane | null>
  panesClearForWorktree(wtPath: string): Promise<boolean>
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
  acceptHooks(): Promise<boolean>
  declineHooks(): Promise<boolean>
  dismissHooksJustInstalled(): Promise<boolean>

  createTerminal(id: string, cwd: string, cmd: string, args: string[], isClaude?: boolean): void
  writeTerminal(id: string, data: string): void
  resizeTerminal(id: string, cols: number, rows: number): void
  killTerminal(id: string): void
  onTerminalData(callback: (id: string, data: string) => void): () => void
  onTerminalExit(callback: (id: string, exitCode: number) => void): () => void

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
