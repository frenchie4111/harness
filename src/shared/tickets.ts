/**
 * Contract between the ticket-data workstream and the ticket-UI workstream.
 *
 * The premise: Claude already has its own access to tickets at runtime
 * (gh CLI for GitHub, the Notion MCP for Notion, etc.), so Harness does
 * NOT need to model every provider-specific field (labels, assignees,
 * comments, status transitions). Harness only persists the
 * generalizable bits needed to (a) render a ticket-picker, (b) seed an
 * initial prompt when spawning a worktree from a ticket, and (c) link
 * a worktree back to the ticket that spawned it.
 *
 * Anything richer is Claude's job at runtime via its own tools.
 */

/**
 * Generalizable ticket data. Provider-specific fields are intentionally
 * absent — see file header. If a future surface needs a provider's
 * raw payload, add an opaque `raw?: unknown` field rather than promoting
 * provider-specific shapes into this type.
 */
export interface Ticket {
  /** Stable Harness-internal id: `${providerId}:${externalId}`. */
  id: string
  /** Which configured provider this ticket came from. */
  providerId: string
  /** Provider's own id for the ticket. Opaque to Harness — a GitHub
   *  issue number as a string, a Notion page id, etc. */
  externalId: string
  /** Single-line title. */
  title: string
  /** Long-form description / body. May be empty. Markdown if the
   *  provider supports it, plain text otherwise. */
  description: string
  /** URL to view the ticket in its native UI. */
  url: string
}

/** Built-in provider implementations. Add a literal here when adding a
 *  new provider type; the data workstream owns the runtime
 *  implementation under `src/main/tickets/`. */
export type TicketProviderType = 'github-issues' | 'notion'

/** Type-specific config payloads. The `config` field of
 *  `TicketProviderConfig` is one of these, discriminated by `type`. */
export interface GithubIssuesConfig {
  /** "owner/repo" — e.g. "frenchie4111/harness". */
  repo: string
  /** Filter query forwarded to the provider's list call. Empty = open
   *  issues assigned to the authenticated user OR all open issues
   *  (provider decides; document in the impl). */
  defaultQuery?: string
}

export interface NotionConfig {
  /** Notion database id (uuid). */
  databaseId: string
  /** Property name of the database's title column. Defaults to "Name". */
  titleProperty?: string
  /** Property name to read as the ticket description. Optional — if
   *  absent the description is empty and Claude is expected to fetch
   *  richer body content via the Notion MCP at runtime. */
  descriptionProperty?: string
}

/** A user-configured provider instance. Auth tokens live in
 *  `secrets.enc` keyed `ticket-provider-token:<id>`, NOT here. The `id`
 *  is a stable Harness-internal handle (uuid) referenced from worktrees
 *  that were spawned from one of this provider's tickets.
 *
 *  The provider carries its own project membership list
 *  (`appliesToRepoRoots`). The picker in repo X surfaces every provider
 *  whose `appliesToRepoRoots` contains X. This is the opposite of the
 *  classic per-repo `.harness.json` M2M map — a single provider that
 *  spans several local repos under one logical project just adds each
 *  repo's path to its own list, instead of editing N `.harness.json`
 *  files. The list is empty/undefined when the provider hasn't been
 *  assigned anywhere yet. */
export interface TicketProviderConfig {
  id: string
  label: string
  type: TicketProviderType
  config: GithubIssuesConfig | NotionConfig
  /** Repo roots (filesystem paths) this provider's tickets should be
   *  surfaced in. Empty/undefined = unassigned, no picker surfaces it
   *  yet. Editing the list lives on the provider form, not on each
   *  repo's settings, so a multi-repo project is one tick per repo. */
  appliesToRepoRoots?: string[]
}

/** Runtime interface implemented by each provider. Implementations live
 *  in `src/main/tickets/<provider>.ts` and are invoked from main-side
 *  IPC handlers — never from the renderer directly. The renderer calls
 *  `window.api.tickets.list(...)` / `.get(...)` which dispatch to the
 *  right provider. */
export interface TicketProvider {
  list(query?: string): Promise<Ticket[]>
  get(externalId: string): Promise<Ticket | null>
}

/** Reference to the ticket a worktree was spawned from. Lives on the
 *  worktree slice. Only the (providerId, externalId) tuple is
 *  persisted — the cached title/url/etc. is looked up on demand from
 *  the tickets slice so we don't have to invalidate stale copies. */
export interface WorktreeTicketLink {
  providerId: string
  externalId: string
}

/**
 * Test/dev helper: returns a TicketProvider that serves canned tickets.
 * Used by the UI workstream to build against a real interface before
 * the data workstream lands GitHub / Notion implementations. Also
 * useful in reducer + component tests.
 */
export function createMockTicketProvider(
  providerId: string,
  seed?: Ticket[]
): TicketProvider {
  const tickets: Ticket[] = seed ?? [
    {
      id: `${providerId}:1`,
      providerId,
      externalId: '1',
      title: 'Add dark mode toggle to settings',
      description:
        'Users on dark systems get blasted by the white sidebar at night. We should respect the OS-level dark-mode preference and expose a manual override in Settings.',
      url: 'https://example.com/tickets/1'
    },
    {
      id: `${providerId}:2`,
      providerId,
      externalId: '2',
      title: 'Worktree sidebar should remember scroll position',
      description:
        'Scrolling down then opening a worktree resets the sidebar to the top. Annoying when triaging a long list.',
      url: 'https://example.com/tickets/2'
    },
    {
      id: `${providerId}:3`,
      providerId,
      externalId: '3',
      title: 'PR poller wakes on focus even with no worktrees',
      description: '',
      url: 'https://example.com/tickets/3'
    }
  ]

  return {
    async list(query) {
      if (!query) return tickets
      const q = query.toLowerCase()
      return tickets.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q)
      )
    },
    async get(externalId) {
      return tickets.find((t) => t.externalId === externalId) ?? null
    }
  }
}
