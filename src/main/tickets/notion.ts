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

function toTicket(
  providerId: string,
  config: NotionConfig,
  page: NotionPage
): Ticket {
  const titleProp = config.titleProperty || 'Name'
  const title = plainTextFromProperty(page.properties[titleProp])
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
      if (query) {
        body.filter = {
          property: config.titleProperty || 'Name',
          title: { contains: query }
        }
      }
      try {
        const data = (await notionFetch(token, `/databases/${config.databaseId}/query`, {
          method: 'POST',
          body: JSON.stringify(body)
        })) as NotionQueryResult
        const pages = data.results ?? []
        return pages
          .filter((p) => !p.archived)
          .map((p) => toTicket(providerId, config, p))
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
