export type Action =
  | 'nextWorktree'
  | 'prevWorktree'
  | 'worktree1'
  | 'worktree2'
  | 'worktree3'
  | 'worktree4'
  | 'worktree5'
  | 'worktree6'
  | 'worktree7'
  | 'worktree8'
  | 'worktree9'
  | 'newShellTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'newWorktree'
  | 'refreshWorktrees'
  | 'focusTerminal'
  | 'toggleSidebar'
  | 'openPR'
  | 'openInEditor'
  | 'toggleCommandCenter'

export interface Modifiers {
  cmd?: boolean
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export interface HotkeyBinding {
  key: string
  modifiers: Modifiers
}

export const DEFAULT_HOTKEYS: Record<Action, HotkeyBinding> = {
  nextWorktree: { key: 'ArrowDown', modifiers: { cmd: true } },
  prevWorktree: { key: 'ArrowUp', modifiers: { cmd: true } },
  worktree1: { key: '1', modifiers: { cmd: true } },
  worktree2: { key: '2', modifiers: { cmd: true } },
  worktree3: { key: '3', modifiers: { cmd: true } },
  worktree4: { key: '4', modifiers: { cmd: true } },
  worktree5: { key: '5', modifiers: { cmd: true } },
  worktree6: { key: '6', modifiers: { cmd: true } },
  worktree7: { key: '7', modifiers: { cmd: true } },
  worktree8: { key: '8', modifiers: { cmd: true } },
  worktree9: { key: '9', modifiers: { cmd: true } },
  newShellTab: { key: 't', modifiers: { cmd: true } },
  closeTab: { key: 'w', modifiers: { cmd: true } },
  nextTab: { key: 'Tab', modifiers: { ctrl: true } },
  prevTab: { key: 'Tab', modifiers: { ctrl: true, shift: true } },
  newWorktree: { key: 'n', modifiers: { cmd: true } },
  refreshWorktrees: { key: 'r', modifiers: { cmd: true, shift: true } },
  focusTerminal: { key: '`', modifiers: { cmd: true } },
  toggleSidebar: { key: 'b', modifiers: { cmd: true } },
  openPR: { key: 'g', modifiers: { cmd: true, shift: true } },
  openInEditor: { key: 'e', modifiers: { cmd: true, shift: true } },
  toggleCommandCenter: { key: 'k', modifiers: { cmd: true, shift: true } },
}

/** Check if a KeyboardEvent matches a hotkey binding */
export function matchesBinding(e: KeyboardEvent, binding: HotkeyBinding): boolean {
  const wantCmd = binding.modifiers.cmd ?? false
  const wantCtrl = binding.modifiers.ctrl ?? false
  const wantShift = binding.modifiers.shift ?? false
  const wantAlt = binding.modifiers.alt ?? false

  if (e.metaKey !== wantCmd) return false
  if (e.ctrlKey !== wantCtrl) return false
  if (e.shiftKey !== wantShift) return false
  if (e.altKey !== wantAlt) return false

  // Normalize key comparison — e.key is case-sensitive but we want case-insensitive for letters
  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const bindingKey = binding.key.length === 1 ? binding.key.toLowerCase() : binding.key

  return eventKey === bindingKey
}

/**
 * Parse a shortcut string like "Cmd+Shift+T" into a HotkeyBinding.
 * Recognized modifier tokens: Cmd, Ctrl, Shift, Alt.
 * The last token is the key.
 */
export function parseBinding(shortcut: string): HotkeyBinding {
  const parts = shortcut.split('+')
  const modifiers: Modifiers = {}

  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].trim().toLowerCase()
    if (mod === 'cmd' || mod === 'meta') modifiers.cmd = true
    else if (mod === 'ctrl' || mod === 'control') modifiers.ctrl = true
    else if (mod === 'shift') modifiers.shift = true
    else if (mod === 'alt' || mod === 'option') modifiers.alt = true
  }

  const key = parts[parts.length - 1].trim()

  return { key, modifiers }
}

/** Convert a binding back to a human-readable string like "Cmd+Shift+T" */
export function bindingToString(binding: HotkeyBinding): string {
  const parts: string[] = []
  if (binding.modifiers.cmd) parts.push('Cmd')
  if (binding.modifiers.ctrl) parts.push('Ctrl')
  if (binding.modifiers.alt) parts.push('Alt')
  if (binding.modifiers.shift) parts.push('Shift')
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  return parts.join('+')
}

/** Human-readable labels for each action */
export const ACTION_LABELS: Record<Action, string> = {
  nextWorktree: 'Next worktree',
  prevWorktree: 'Previous worktree',
  worktree1: 'Switch to worktree 1',
  worktree2: 'Switch to worktree 2',
  worktree3: 'Switch to worktree 3',
  worktree4: 'Switch to worktree 4',
  worktree5: 'Switch to worktree 5',
  worktree6: 'Switch to worktree 6',
  worktree7: 'Switch to worktree 7',
  worktree8: 'Switch to worktree 8',
  worktree9: 'Switch to worktree 9',
  newShellTab: 'New shell tab',
  closeTab: 'Close tab',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
  newWorktree: 'New worktree',
  refreshWorktrees: 'Refresh worktrees',
  focusTerminal: 'Focus terminal',
  toggleSidebar: 'Toggle sidebar',
  openPR: 'Open PR in browser',
  openInEditor: 'Open worktree in editor',
  toggleCommandCenter: 'Toggle command center'
}

/** Capture a KeyboardEvent into a HotkeyBinding (for the rebind UI) */
export function eventToBinding(e: KeyboardEvent): HotkeyBinding | null {
  // Ignore pure modifier presses
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null
  return {
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
    modifiers: {
      cmd: e.metaKey,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey
    }
  }
}

/** Build a resolved hotkey map by merging defaults with user overrides */
export function resolveHotkeys(
  overrides?: Record<string, string>
): Record<Action, HotkeyBinding> {
  if (!overrides) return { ...DEFAULT_HOTKEYS }

  const resolved = { ...DEFAULT_HOTKEYS }
  for (const [action, shortcut] of Object.entries(overrides)) {
    if (action in DEFAULT_HOTKEYS) {
      resolved[action as Action] = parseBinding(shortcut)
    }
  }
  return resolved
}
