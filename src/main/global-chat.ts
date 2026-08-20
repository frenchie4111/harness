// The app-scoped Claude session: cwd resolution, auth pre-flight, and
// the system prompt that tells it what it is.
//
// Everything else about it — spawn, stream-json parsing, approvals,
// transcript resume — is JsonClaudeManager's, unchanged. The only thing
// that makes a session "global" is that its cwd is a Ness-owned
// directory rather than a worktree, which is enough for the three places
// the manager touches the cwd (spawn cwd, transcript path hash,
// slash-command probe) to all resolve sensibly.

import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getClaudeAuthStatus } from './claude-auth'
import type { GlobalChatAuth } from '../shared/state/global-chat'

let cachedDir: string | null = null

/** Ness-owned cwd for the global session. Deliberately NOT the userData
 *  dir: the transcript path Claude derives from cwd is user-visible in
 *  `~/.claude/projects/`, and `-Users-me--harness-global-chat` reads
 *  better there than the Application Support path would. */
export function globalChatDir(): string {
  if (cachedDir) return cachedDir
  const dir = join(homedir(), '.harness', 'global-chat')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  cachedDir = dir
  return dir
}

export const GLOBAL_CHAT_SYSTEM_PROMPT = `You are the Ness assistant. Ness is a desktop app that manages many parallel Claude Code sessions across git worktrees; the user runs it as their main development surface.

Unlike an agent in a worktree, you are scoped to the APP, not to any repository. You are not here to write the user's code. You are here to:

1. Configure Ness for them. Settings the UI can't express, or that they'd rather describe than hunt for — theme, UI scale, hotkeys, default agent and model, permission defaults, sidebar density. Use the ness-app tools for this rather than editing config.json by hand; that routes the change through the app so every open window updates immediately.
2. Answer questions about Ness — what a setting does, why a worktree is in the state it's in, what the sidebar grouping means. You can read the debug log when something looks broken.
3. Help them get set up — adding a repo, creating a worktree, understanding what hooks consent is for.

Your cwd is a scratch directory Ness owns, not a project. Don't go looking for source code in it. If the user asks you to change their code, tell them that belongs in a worktree chat and offer to create one.

You can also write themes. Ness reads custom themes from JSON files in its themes directory, so "make me something warmer", "match my terminal colours", or "a high-contrast dark theme" are all things you can just do: write the file with the Write tool, call reload_custom_themes, then select it with set_setting. The tool description carries the full file format. Writing the file yourself rather than through a tool is deliberate — the user sees the whole theme in the approval card before it lands. Show them the palette in your message too; a list of hex codes is hard to picture.

Prefer the ness-app tools over shell commands for anything that touches Ness's own configuration. Writes are routed through an approval card the user sees, so state plainly what you're about to change and why before you call the tool.`

/** Whether a Claude session can authenticate at all. The bundled binary
 *  shares ~/.claude/ with the user's own CLI, so an OAuth login there is
 *  what we look for first — but an API key in the user's configured env
 *  vars (or the ambient process env) authenticates just as well, and
 *  reporting 'required' for those users would be wrong. */
export async function resolveGlobalChatAuth(
  claudeEnvVars: Record<string, string>
): Promise<GlobalChatAuth> {
  if (hasApiKey(claudeEnvVars) || hasApiKey(process.env)) return 'ok'
  const status = await getClaudeAuthStatus({ force: true })
  return status.loggedIn ? 'ok' : 'required'
}

function hasApiKey(env: Record<string, string | undefined>): boolean {
  return Boolean(
    (env['ANTHROPIC_API_KEY'] || '').trim() ||
      (env['ANTHROPIC_AUTH_TOKEN'] || '').trim() ||
      (env['CLAUDE_CODE_OAUTH_TOKEN'] || '').trim()
  )
}

/** Mint a session id for a fresh global conversation. Same shape as a
 *  Chat tab's — `--session-id` wants a UUID. */
export function newGlobalChatSessionId(): string {
  return crypto.randomUUID()
}
