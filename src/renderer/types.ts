import type { StateEvent, StateSnapshot } from '../shared/state'
export type { StateEvent, StateSnapshot }

import type { Worktree, PendingWorktree, PendingDeletion } from '../shared/state/worktrees'
export type { Worktree, PendingWorktree, PendingDeletion }

import type { RepoConfig } from '../shared/state/repo-configs'
export type { RepoConfig }

export interface FileReadResult {
  content: string | null
  size: number
  binary: boolean
  truncated: boolean
  error?: string
}

export interface FileWriteResult {
  ok: boolean
  error?: string
}

export interface FileDiffSides {
  original: string
  modified: string
  originalExists: boolean
  modifiedExists: boolean
  modifiedBinary: boolean
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

import type { UpdaterStatus } from '../shared/state/updater'
export type { UpdaterStatus }

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
  additions?: number
  deletions?: number
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
  ): Promise<{ queued: true }>
  dismissPendingDeletion(path: string): Promise<boolean>
  getWorktreeDir(repoRoot: string): Promise<string>
  listRepos(): Promise<string[]>
  addRepo(): Promise<string | null>
  removeRepo(repoRoot: string): Promise<boolean>

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
  writeWorktreeFile(
    worktreePath: string,
    filePath: string,
    contents: string
  ): Promise<FileWriteResult>
  getChangedFiles(worktreePath: string, mode?: 'working' | 'branch'): Promise<ChangedFile[]>
  getFileDiff(
    worktreePath: string,
    filePath: string,
    staged: boolean,
    mode?: 'working' | 'branch'
  ): Promise<string>
  getFileDiffSides(
    worktreePath: string,
    filePath: string,
    staged: boolean,
    mode?: 'working' | 'branch'
  ): Promise<FileDiffSides>

  // Settings — all reads come from useSettings()/useRepoConfigs()/etc.
  // Only the mutation methods + a few constant accessors remain on the IPC.
  setHotkeyOverrides(hotkeys: Record<string, string>): Promise<boolean>
  resetHotkeyOverrides(): Promise<boolean>
  setClaudeCommand(command: string): Promise<boolean>
  getDefaultClaudeCommand(): Promise<string>
  setHarnessMcpEnabled(enabled: boolean): Promise<boolean>
  prepareMcpForTerminal(terminalId: string): Promise<string | null>
  onWorktreesExternalCreate(
    callback: (payload: { repoRoot: string; worktree: Worktree; initialPrompt?: string }) => void
  ): () => void
  setClaudeEnvVars(vars: Record<string, string>): Promise<boolean>
  setNameClaudeSessions(enabled: boolean): Promise<boolean>
  setTheme(theme: string): Promise<boolean>
  getAvailableThemes(): Promise<readonly string[]>
  setTerminalFontFamily(fontFamily: string): Promise<boolean>
  getDefaultTerminalFontFamily(): Promise<string>
  setTerminalFontSize(fontSize: number): Promise<boolean>
  setOnboardingQuest(quest: QuestStep): Promise<boolean>
  setWorktreeScripts(scripts: { setup: string; teardown: string }): Promise<boolean>
  setRepoConfig(repoRoot: string, next: Partial<RepoConfig>): Promise<RepoConfig | null>
  setWorktreeBase(mode: 'remote' | 'local'): Promise<boolean>
  setMergeStrategy(strategy: MergeStrategy): Promise<boolean>
  setEditor(editorId: string): Promise<boolean>
  getAvailableEditors(): Promise<{ id: string; name: string }[]>
  openInEditor(worktreePath: string, filePath?: string): Promise<{ ok: true } | { ok: false; error: string }>

  panesAddTab(wtPath: string, tab: TerminalTab, paneId?: string): Promise<boolean>
  panesCloseTab(wtPath: string, tabId: string): Promise<boolean>
  panesRestartClaudeTab(wtPath: string, tabId: string, newId: string): Promise<boolean>
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
  panesEnsureInitialized(wtPath: string): Promise<boolean>
  saveTerminalHistory(id: string, content: string): Promise<boolean>
  saveTerminalHistorySync(id: string, content: string): void
  loadTerminalHistory(id: string): Promise<string | null>
  clearTerminalHistory(id: string): Promise<boolean>
  claudeSessionFileExists(cwd: string, sessionId: string): Promise<boolean>
  getLatestClaudeSessionId(cwd: string): Promise<string | null>

  hasGithubToken(): Promise<boolean>
  setGithubToken(token: string): Promise<{ ok: boolean; username?: string; error?: string }>
  clearGithubToken(): Promise<boolean>
  setHarnessStarred(starred: boolean): Promise<{ ok: boolean; error?: string }>

  getVersion(): Promise<string>
  checkForUpdates(): Promise<{ ok: boolean; available?: boolean; version?: string; releaseDate?: string; error?: string }>
  quitAndInstall(): Promise<boolean>

  openExternal(url: string): void
  getFilePath(file: File): string
  onOpenSettings(callback: () => void): () => void

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
