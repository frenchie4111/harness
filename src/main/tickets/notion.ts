// Notion provider.
//
// Same minimal-contract logic as github-issues: Claude has the Notion
// MCP at runtime and can fetch rich page content directly. Harness only
// pulls enough to render a picker + seed a kickoff prompt. The
// description here is a best-effort single-property read; if the page
// stores its body as block children (the common case), the renderer
// surfaces the title and Claude takes it from there at runtime.

import { log, formatErr } from '../debug'
// trackedFetch is named for its GitHub use but is really a generic
// instrumented fetch. Aliased so the Notion calls don't read as
// GitHub-recorder calls in stack traces.
import { trackedFetch as recordedFetch } from '../github-recorder'
import { getSecret } from '../secrets'
import type {
  NotionConfig,
  NotionDatabaseSchema,
  NotionDatabaseSummary,
  Ticket,
  TicketProvider
} from '../../shared/tickets'

const NOTION_VERSION = '2022-06-28'

interface NotionRichText {
  plain_text?: string
}

interface NotionTitleProperty {
  id: string
  type: 'title'
  title: NotionRichText[]
}

interface NotionRichTextProperty {
  id: string
  type: 'rich_text'
  rich_text: NotionRichText[]
}

type NotionProperty =
  | NotionTitleProperty
  | NotionRichTextProperty
  | { type: string; id: string }

interface NotionPage {
  id: string
  url: string
  archived?: boolean
  properties: Record<string, NotionProperty>
}

interface NotionQueryResult {
  results?: NotionPage[]
}

function notionTokenKey(providerId: string): string {
  return `ticket-provider-token:${providerId}`
}

async function notionFetch(
  token: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const url = `https://api.notion.com/v1${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'User-Agent': 'Harness'
  }
  if (init?.body) headers['Content-Type'] = 'application/json'
  const res = await recordedFetch(url, { ...init, headers })
  if (!res.ok) {
    throw new Error(`Notion API ${res.status} ${res.statusText} for ${path}`)
  }
  return res.json()
}

function plainTextFromProperty(prop: NotionProperty | undefined): string {
  if (!prop) return ''
  if (prop.type === 'title') {
    const t = prop as NotionTitleProperty
    return (t.title ?? []).map((r) => r.plain_text ?? '').join('')
  }
  if (prop.type === 'rich_text') {
    const r = prop as NotionRichTextProperty
    return (r.rich_text ?? []).map((rt) => rt.plain_text ?? '').join('')
  }
  // Anything else (select, date, formula, …) isn't simple text. Per the
  // contract: skip with a debug line + empty string.
  return ''
}

/** Every Notion database has exactly one property of type "title", but
 *  its key depends on what the user named the column ("Name", "Title",
 *  "Task", …) and is case-sensitive. Falling back to the first
 *  title-typed property when the configured name doesn't match lets the
 *  common case (a database with a normal title column of any name) work
 *  with `titleProperty` blank, while still honoring an explicit override. */
function findTitleValue(page: NotionPage, hint: string | undefined): string {
  if (hint) {
    const hinted = plainTextFromProperty(page.properties[hint])
    if (hinted) return hinted
  }
  for (const key of Object.keys(page.properties)) {
    const prop = page.properties[key]
    if (prop?.type === 'title') return plainTextFromProperty(prop)
  }
  return ''
}

function toTicket(
  providerId: string,
  config: NotionConfig,
  page: NotionPage
): Ticket {
  const title = findTitleValue(page, config.titleProperty)
  let description = ''
  if (config.descriptionProperty) {
    const descProp = page.properties[config.descriptionProperty]
    description = plainTextFromProperty(descProp)
    if (!description && descProp && descProp.type !== 'title' && descProp.type !== 'rich_text') {
      log(
        'tickets-notion',
        `description property "${config.descriptionProperty}" on page ${page.id} is ${descProp.type} — skipping`
      )
    }
  }
  return {
    id: `${providerId}:${page.id}`,
    providerId,
    externalId: page.id,
    title: title || '(untitled)',
    description,
    url: page.url
  }
}

export function createNotionProvider(
  providerId: string,
  config: NotionConfig
): TicketProvider {
  if (!config.databaseId || typeof config.databaseId !== 'string') {
    throw new Error('notion provider: missing databaseId')
  }

  function readToken(): string {
    const token = getSecret(notionTokenKey(providerId))
    if (!token) {
      throw new Error(
        `Notion provider ${providerId}: missing token in secrets.enc (key ${notionTokenKey(providerId)})`
      )
    }
    return token
  }

  return {
    async list(query) {
      const token = readToken()
      const body: Record<string, unknown> = { page_size: 50 }
      // Server-side filter only when the user explicitly told us the title
      // property key — otherwise we don't know what to `property` against.
      // When it's unset we fall back to fetching unfiltered and filtering
      // client-side by title (which findTitleValue resolves per-page).
      if (query && config.titleProperty) {
        body.filter = {
          property: config.titleProperty,
          title: { contains: query }
        }
      }
      try {
        const data = (await notionFetch(token, `/databases/${config.databaseId}/query`, {
          method: 'POST',
          body: JSON.stringify(body)
        })) as NotionQueryResult
        const pages = data.results ?? []
        const tickets = pages
          .filter((p) => !p.archived)
          .map((p) => toTicket(providerId, config, p))
        if (query && !config.titleProperty) {
          const q = query.toLowerCase()
          return tickets.filter((t) => t.title.toLowerCase().includes(q))
        }
        return tickets
      } catch (err) {
        log('tickets-notion', `list failed for db ${config.databaseId}`, formatErr(err))
        throw err
      }
    },

    async get(externalId) {
      const token = readToken()
      try {
        const page = (await notionFetch(token, `/pages/${externalId}`)) as NotionPage
        if (!page || !page.id) return null
        return toTicket(providerId, config, page)
      } catch (err) {
        log('tickets-notion', `get failed for page ${externalId}`, formatErr(err))
        return null
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Setup-time discovery helpers. The Notion provider form calls these with an
// ephemeral token BEFORE the provider is saved — nothing here touches
// secrets.enc. Both are simple pass-throughs over the Notion API.

interface NotionDatabaseObject {
  id: string
  url: string
  title?: NotionRichText[]
  properties?: Record<string, NotionProperty>
}

interface NotionSearchResult {
  results?: NotionDatabaseObject[]
}

function databaseTitle(db: NotionDatabaseObject): string {
  if (!db.title || db.title.length === 0) return '(untitled database)'
  const joined = db.title.map((r) => r.plain_text ?? '').join('').trim()
  return joined || '(untitled database)'
}

/** Return every database the integration behind `token` has access to,
 *  optionally filtered by name. Used by the provider form to render a
 *  picker instead of asking the user to paste a UUID. */
export async function listNotionDatabases(
  token: string,
  query?: string
): Promise<NotionDatabaseSummary[]> {
  if (!token) return []
  const body: Record<string, unknown> = {
    filter: { property: 'object', value: 'database' },
    page_size: 100
  }
  if (query && query.trim().length > 0) body.query = query.trim()
  try {
    const data = (await notionFetch(token, '/search', {
      method: 'POST',
      body: JSON.stringify(body)
    })) as NotionSearchResult
    return (data.results ?? []).map((db) => ({
      id: db.id,
      title: databaseTitle(db),
      url: db.url
    }))
  } catch (err) {
    log('tickets-notion', 'listDatabases failed', formatErr(err))
    throw err
  }
}

/** Fetch the property schema for a single database. Powers the "pick a
 *  description property" dropdown in the provider form. */
export async function describeNotionDatabase(
  token: string,
  databaseId: string
): Promise<NotionDatabaseSchema | null> {
  if (!token || !databaseId) return null
  try {
    const db = (await notionFetch(token, `/databases/${databaseId}`)) as NotionDatabaseObject
    if (!db || !db.id) return null
    const properties: { name: string; type: string }[] = []
    for (const key of Object.keys(db.properties ?? {})) {
      const prop = (db.properties ?? {})[key]
      properties.push({ name: key, type: prop?.type ?? 'unknown' })
    }
    return { id: db.id, title: databaseTitle(db), properties }
  } catch (err) {
    log('tickets-notion', `describeDatabase failed for ${databaseId}`, formatErr(err))
    throw err
  }
}
