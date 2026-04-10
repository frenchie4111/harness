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
}

export interface PersistedTab {
  id: string
  type: 'claude' | 'shell'
  label: string
}

export type PtyStatus = 'idle' | 'processing' | 'waiting' | 'needs-approval'

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
}

export interface PRStatus {
  number: number
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  url: string
  branch: string
  checks: CheckStatus[]
  checksOverall: 'success' | 'failure' | 'pending' | 'none'
}

export interface ElectronAPI {
  listWorktrees(): Promise<Worktree[]>
  listBranches(): Promise<string[]>
  addWorktree(branchName: string, baseBranch?: string): Promise<Worktree>
  isWorktreeDirty(path: string): Promise<boolean>
  removeWorktree(path: string, force?: boolean): Promise<void>
  getWorktreeDir(): Promise<string>
  selectRepoRoot(): Promise<string | null>
  getRepoRoot(): Promise<string | null>

  getPRStatus(worktreePath: string): Promise<PRStatus | null>
  getChangedFiles(worktreePath: string): Promise<ChangedFile[]>
  getFileDiff(worktreePath: string, filePath: string, staged: boolean): Promise<string>

  getHotkeyOverrides(): Promise<Record<string, string> | null>
  setHotkeyOverrides(hotkeys: Record<string, string>): Promise<boolean>
  resetHotkeyOverrides(): Promise<boolean>
  onHotkeysChanged(callback: (hotkeys: Record<string, string> | null) => void): () => void

  getClaudeCommand(): Promise<string>
  setClaudeCommand(command: string): Promise<boolean>
  getDefaultClaudeCommand(): Promise<string>
  onClaudeCommandChanged(callback: (command: string) => void): () => void

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
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
