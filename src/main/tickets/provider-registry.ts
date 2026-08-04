import type {
  GithubIssuesConfig,
  NotionConfig,
  TicketProvider,
  TicketProviderConfig,
  TicketProviderType
} from '../../shared/tickets'
import { createGithubIssuesProvider } from './github-issues'
import { createNotionProvider } from './notion'

/** Shape-check a stored config's `config` payload against its declared
 *  `type`. Cheap runtime validation that catches malformed renderer
 *  input or wrong-shape patches before they land on disk and crash a
 *  later `list()` call. Returns null on failure. */
export function validateProviderConfig(
  type: TicketProviderType,
  raw: unknown
): GithubIssuesConfig | NotionConfig | null {
  if (!raw || typeof raw !== 'object') return null
  if (type === 'github-issues') {
    const repo = (raw as { repo?: unknown }).repo
    if (typeof repo !== 'string' || !repo.includes('/') || repo.startsWith('/') || repo.endsWith('/')) {
      return null
    }
    const defaultQuery = (raw as { defaultQuery?: unknown }).defaultQuery
    const out: GithubIssuesConfig = { repo }
    if (typeof defaultQuery === 'string') out.defaultQuery = defaultQuery
    return out
  }
  if (type === 'notion') {
    const databaseId = (raw as { databaseId?: unknown }).databaseId
    if (typeof databaseId !== 'string' || !databaseId) return null
    const titleProperty = (raw as { titleProperty?: unknown }).titleProperty
    const descriptionProperty = (raw as { descriptionProperty?: unknown })
      .descriptionProperty
    const out: NotionConfig = { databaseId }
    if (typeof titleProperty === 'string' && titleProperty) out.titleProperty = titleProperty
    if (typeof descriptionProperty === 'string' && descriptionProperty) {
      out.descriptionProperty = descriptionProperty
    }
    return out
  }
  const _exhaustive: never = type
  void _exhaustive
  return null
}

/** Build a runtime TicketProvider from its stored config. Throws on
 *  unknown type — caller is expected to surface the error. */
export function createTicketProvider(
  config: TicketProviderConfig
): TicketProvider {
  switch (config.type) {
    case 'github-issues':
      return createGithubIssuesProvider(config.id, config.config as GithubIssuesConfig)
    case 'notion':
      return createNotionProvider(config.id, config.config as NotionConfig)
    default: {
      const _exhaustive: never = config.type
      void _exhaustive
      throw new Error(`Unknown ticket provider type: ${(config as { type: string }).type}`)
    }
  }
}
