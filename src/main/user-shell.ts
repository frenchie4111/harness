// Pick a shell to wrap diagnostic / utility spawns in. Resolution order:
// $SHELL → /bin/zsh → /bin/bash → /usr/bin/zsh → /usr/bin/bash → /bin/sh.
// First existing candidate wins, then the result is module-cached. The
// `-ilc` wrapper format works on bash, zsh, ksh, and mksh — so we don't
// auto-detect the user's shell flavor today. Fish parses `-ilc` differently;
// users on fish can set SHELL=/bin/bash or override claudeCommand explicitly.
import { existsSync } from 'fs'

let cached: string | null = null

export function resolveUserShell(): string {
  if (cached) return cached
  const candidates = [
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/usr/bin/zsh',
    '/usr/bin/bash',
    '/bin/sh'
  ].filter((c): c is string => !!c && existsSync(c))
  cached = candidates[0] ?? '/bin/sh'
  return cached
}

export function loginShellCommandArgs(cmd: string): string[] {
  return ['-ilc', cmd]
}

export function loginShellArgs(): string[] {
  return ['-il']
}
