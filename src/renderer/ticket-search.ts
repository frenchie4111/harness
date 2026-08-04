// Search + merge logic shared by the picker. Extracted so it's
// trivially testable without mounting React — same `list(providerId,
// query)` boundary the picker uses, just typed against the per-
// provider TicketProvider contract instead of `backend.ticketsList`.

import type { Ticket, TicketProviderConfig } from '../shared/tickets'

export interface MergedTicketRow {
  ticket: Ticket
  provider: TicketProviderConfig
}

export interface SearchAndMergeResult {
  rows: MergedTicketRow[]
  /** Per-provider failure messages, keyed by provider id. Successful
   *  providers don't appear. Empty when everything succeeded. */
  errors: Record<string, string>
}

export type ListTicketsFn = (providerId: string, query: string) => Promise<Ticket[]>

/** Fan out to every provider concurrently, await results, and stitch
 *  them into a single row list in the order providers were passed in.
 *  Per-provider rejections are captured so a flaky provider doesn't
 *  blank the picker — its slot in the `errors` map drives the inline
 *  warning row. */
export async function searchAndMergeTickets(
  providers: readonly TicketProviderConfig[],
  query: string,
  list: ListTicketsFn
): Promise<SearchAndMergeResult> {
  if (providers.length === 0) return { rows: [], errors: {} }
  const results = await Promise.allSettled(providers.map((p) => list(p.id, query)))
  const rows: MergedTicketRow[] = []
  const errors: Record<string, string> = {}
  results.forEach((r, i) => {
    const provider = providers[i]
    if (r.status === 'fulfilled') {
      for (const t of r.value) rows.push({ ticket: t, provider })
    } else {
      errors[provider.id] = r.reason instanceof Error ? r.reason.message : 'fetch failed'
    }
  })
  return { rows, errors }
}
