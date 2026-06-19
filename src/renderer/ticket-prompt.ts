// Helpers shared by the ticket picker, the New Worktree wiring, and the
// component tests. Kept tiny + pure so they're trivially testable
// without React.

import type { Ticket, TicketProviderType, WorktreeTicketLink } from '../shared/tickets'

/** Maps the contract's `TicketProviderType` literals to the short branch
 *  prefix used by `suggestedBranchName`. Keep adding entries when new
 *  provider types land in `src/shared/tickets.ts`. */
export const PROVIDER_BRANCH_SHORTCODE: Record<TicketProviderType, string> = {
  'github-issues': 'gh',
  notion: 'notion'
}

/** Slugify a ticket title for use as a branch name. The rule:
 *
 *  - lowercase, strip diacritics
 *  - drop everything outside `[a-z0-9 -]`
 *  - collapse whitespace + dashes into a single dash
 *  - trim leading/trailing dashes
 *  - cap to 50 chars, dropping a trailing partial word so the output
 *    doesn't end mid-token
 *
 *  Branch names live downstream of `sanitizeBranchInput` (the New
 *  Worktree input live-sanitizes), so this only needs to produce
 *  reasonable input — anything that survives `isValidBranchName` is
 *  fine, but we aim for "feels hand-typed" not "passes the regex".
 */
export function slugifyTitle(title: string, maxLen = 50): string {
  const normalized = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (normalized.length <= maxLen) return normalized
  const truncated = normalized.slice(0, maxLen)
  const lastDash = truncated.lastIndexOf('-')
  // Drop the partial trailing word if we have a reasonable cut point;
  // otherwise keep the hard cut so very-long single tokens still produce
  // a valid (if ugly) slug.
  return lastDash > maxLen / 2 ? truncated.slice(0, lastDash) : truncated
}

/** Compose a suggested branch name from a ticket. Format:
 *  `<providerShortcode-externalId>/<slug>`, e.g. `gh-42/add-dark-mode-toggle`.
 *  Users can override in the New Worktree input; this just primes it. */
export function suggestedBranchName(
  ticket: Pick<Ticket, 'title' | 'externalId'>,
  providerType: TicketProviderType
): string {
  const slug = slugifyTitle(ticket.title) || 'work'
  const prefix = `${PROVIDER_BRANCH_SHORTCODE[providerType]}-${ticket.externalId}`
  return `${prefix}/${slug}`
}

/** Render the user's ticket-worktree prompt template against the chosen
 *  ticket. Substitutes `{title}` / `{description}` / `{url}` /
 *  `{externalId}` / `{providerType}` in a single pass — no nesting, no
 *  escaping needed because the placeholders are ascii-only and don't
 *  collide with anything in markdown. Unknown placeholders pass through
 *  unchanged. */
export function renderTicketPrompt(
  template: string,
  ticket: Ticket,
  providerType: TicketProviderType
): string {
  return template
    .replace(/\{title\}/g, ticket.title)
    .replace(/\{description\}/g, ticket.description)
    .replace(/\{url\}/g, ticket.url)
    .replace(/\{externalId\}/g, ticket.externalId)
    .replace(/\{providerType\}/g, providerType)
}

/** Convenience constructor — the contract's `WorktreeTicketLink` is the
 *  (providerId, externalId) tuple. Used by both the picker and the
 *  sidebar chip to round-trip a ticket id. */
export function toWorktreeTicketLink(ticket: Ticket): WorktreeTicketLink {
  return { providerId: ticket.providerId, externalId: ticket.externalId }
}
