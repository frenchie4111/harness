/** Auto-naming for worktrees created from nothing but a kickoff prompt.
 *
 *  Two halves, deliberately split: Ness picks a *provisional* branch name
 *  locally (cheap, deterministic, no model call — and it has to be decided
 *  before `git worktree add` runs), then asks the agent to replace it with
 *  a real one via the `rename_worktree` MCP tool once it has read the task.
 *  The provisional name is what the directory on disk is called forever,
 *  so it still has to be readable on its own if the agent never renames.
 */

import { wrapAutomatedMessage } from './state/json-claude'

/** Words that carry no meaning in a branch name. Only filler — verbs and
 *  nouns stay, because they're what makes the slug recognizable. */
const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or', 'but',
  'please', 'can', 'could', 'would', 'should', 'will', 'i', 'we', 'you', 'my',
  'our', 'your', 'it', 'its', 'is', 'are', 'be', 'been', 'that', 'this',
  'with', 'so', 'just', 'also', 'if', 'then', 'lets', 'let', 'want', 'need',
  'like', 'me', 'us', 'do', 'does', 'now', 'here', 'there', 'some', 'any'
])

/** Used when the prompt is empty or slugs down to nothing (emoji, CJK, a
 *  bare URL). Callers append a numeric suffix on collision. */
export const AUTO_BRANCH_FALLBACK = 'new-task'

const MAX_SLUG_WORDS = 5
const MAX_SLUG_LEN = 40

/** Derive a provisional branch name from a kickoff prompt. Lowercase
 *  kebab-case, filler stripped, capped at 5 words / 40 chars — long enough
 *  to recognize in the sidebar, short enough to live in a path. */
export function slugifyPromptToBranch(prompt: string): string {
  // Only the first line: multi-paragraph prompts bury the ask in context,
  // and the opening sentence is almost always the ask itself.
  const firstLine = prompt.trim().split('\n')[0] ?? ''
  const words = firstLine
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

  const meaningful = words.filter((w) => !FILLER_WORDS.has(w))
  // A prompt made entirely of filler ("can you do it?") still deserves a
  // name derived from what the user actually typed.
  const picked = (meaningful.length > 0 ? meaningful : words).slice(0, MAX_SLUG_WORDS)
  if (picked.length === 0) return AUTO_BRANCH_FALLBACK

  let slug = picked.join('-')
  if (slug.length > MAX_SLUG_LEN) {
    // Cut at a word boundary so the name doesn't end mid-word.
    slug = slug.slice(0, MAX_SLUG_LEN).replace(/-[^-]*$/, '')
  }
  slug = slug.replace(/^-+|-+$/g, '')
  return slug || AUTO_BRANCH_FALLBACK
}

/** The "ask the agent to rename itself" half lives in the
 *  `worktree-autoname` automated-message sentinel
 *  (`src/shared/state/json-claude.ts`): its guidance footer carries the
 *  instruction to the model, and `parseAutomatedMessage` strips it back off
 *  so the chat card shows only what the user typed. */
export function withAutoNameInstruction(prompt: string): string {
  return wrapAutomatedMessage('worktree-autoname', prompt.trim())
}
