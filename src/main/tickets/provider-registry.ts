import type {
  GithubIssuesConfig,
  NotionConfig,
  TicketProvider,
  TicketProviderConfig
} from '../../shared/tickets'
import { createGithubIssuesProvider } from './github-issues'
import { createNotionProvider } from './notion'

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
