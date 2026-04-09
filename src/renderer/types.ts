export interface Worktree {
  path: string
  branch: string
  head: string
  isBare: boolean
}

export interface TerminalTab {
  id: string
  type: 'claude' | 'shell'
  label: string
}

export type PtyStatus = 'idle' | 'processing' | 'waiting' | 'needs-approval'

export interface ElectronAPI {
  listWorktrees(): Promise<Worktree[]>
  addWorktree(name: string): Promise<Worktree>
  removeWorktree(path: string): Promise<void>
  selectRepoRoot(): Promise<string | null>
  getRepoRoot(): Promise<string | null>

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
