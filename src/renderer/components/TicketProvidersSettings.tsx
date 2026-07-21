// Settings UI for managing ticket providers (github-issues / notion).
//
// Single surface here — <TicketProvidersSettingsSection /> — that lists
// configured providers and handles add/edit/remove. Each provider
// carries its own project membership list (which repos its tickets show
// up in), edited inline in the provider form via a checkbox list of the
// user's known repos. No per-repo .harness.json plumbing needed.

import { useEffect, useMemo, useState } from 'react'
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  CircleDot,
  BookOpen,
  AlertCircle,
  Loader2,
  Search
} from 'lucide-react'
import { useBackend } from '../backend'
import { useTicketProviders, useWorktrees } from '../store'
import type { NotionDatabaseSchema, NotionDatabaseSummary } from '../types'

/** Asks main whether the given provider has a token recorded in
 *  secrets.enc. Tokens are write-only over IPC, so this is the only way
 *  to drive the "Token configured" / "Replace token" UX state.
 *  Re-fires whenever `id` or `version` changes — bump `version` after a
 *  successful add/update/replace to refresh. */
function useTicketProviderHasToken(id: string, version: number = 0): boolean {
  const backend = useBackend()
  const [hasToken, setHasToken] = useState(false)
  useEffect(() => {
    if (!id) {
      setHasToken(false)
      return
    }
    let cancelled = false
    void backend.ticketsHasProviderToken(id).then((v) => {
      if (!cancelled) setHasToken(Boolean(v))
    })
    return () => {
      cancelled = true
    }
  }, [backend, id, version])
  return hasToken
}
import { RepoIcon } from './RepoIcon'
import type {
  GithubIssuesConfig,
  NotionConfig,
  TicketProviderConfig,
  TicketProviderType
} from '../../shared/tickets'

const PROVIDER_LABELS: Record<TicketProviderType, string> = {
  'github-issues': 'GitHub Issues',
  notion: 'Notion'
}

/** Provider-type icon shared by every surface (settings list, picker
 *  modal row, sidebar chip). Returns a lucide icon as a JSX element so
 *  the className canonical `icon-*` set is enforced at the call site. */
export function TicketProviderIcon({
  type,
  className = 'icon-sm'
}: {
  type: TicketProviderType
  className?: string
}): JSX.Element {
  // GitHub: brand glyph isn't in this lucide version (CLAUDE.md notes),
  // so CircleDot — lucide's own "issue" icon — stands in for github-issues.
  // BookOpen for Notion mirrors how Notion's own docs surface looks.
  if (type === 'github-issues') return <CircleDot className={className} />
  return <BookOpen className={className} />
}

export function TicketProvidersSettingsSection(): JSX.Element {
  const providers = useTicketProviders()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [addingNew, setAddingNew] = useState(false)

  return (
    <div>
      <h2 className="text-lg font-semibold text-fg-bright mb-1">Ticket Providers</h2>
      <p className="text-sm text-dim mb-4">
        Connect ticket sources so the New Worktree screen can spawn a branch
        from an issue or Notion page. Harness only stores the bits needed to
        pick a ticket and seed the kickoff prompt — Claude reads richer
        context (comments, links) at runtime via its own tools.
      </p>

      {providers.length === 0 && !addingNew && (
        <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 bg-panel-raised/40 text-center mb-4">
          <p className="text-sm text-dim mb-1">No providers configured yet.</p>
          <p className="text-xs text-faint mb-3">
            Add one to pick tickets from GitHub Issues or a Notion database.
          </p>
        </div>
      )}

      {providers.length > 0 && (
        <div className="space-y-2 mb-3">
          {providers.map((p) =>
            editingId === p.id ? (
              <TicketProviderForm
                key={p.id}
                initial={p}
                onSubmit={() => setEditingId(null)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <TicketProviderRow
                key={p.id}
                provider={p}
                onEdit={() => setEditingId(p.id)}
              />
            )
          )}
        </div>
      )}

      {addingNew ? (
        <TicketProviderForm
          onSubmit={() => setAddingNew(false)}
          onCancel={() => setAddingNew(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAddingNew(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
        >
          <Plus className="icon-xs" />
          Add provider
        </button>
      )}
    </div>
  )
}

interface TicketProviderRowProps {
  provider: TicketProviderConfig
  onEdit: () => void
}

function repoBasename(repoRoot: string): string {
  return repoRoot.split('/').pop() || repoRoot
}

function TicketProviderRow({ provider, onEdit }: TicketProviderRowProps): JSX.Element {
  const backend = useBackend()
  // GitHub providers reuse the shared GitHub PAT / gh-cli token resolved at
  // boot — there's no per-provider token to track or display.
  const needsToken = provider.type === 'notion'
  const hasToken = useTicketProviderHasToken(needsToken ? provider.id : '')
  const summary =
    provider.type === 'github-issues'
      ? (provider.config as GithubIssuesConfig).repo
      : (provider.config as NotionConfig).databaseId
  const appliesTo = provider.appliesToRepoRoots ?? []

  const handleRemove = async (): Promise<void> => {
    // Mirror existing Settings.tsx convention — no inline confirm modal
    // for low-blast-radius removes; the user can re-add if it was an
    // accident.
    await backend.ticketsRemoveProvider(provider.id)
  }

  return (
    <div className="rounded border border-border bg-panel px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-3">
        <TicketProviderIcon type={provider.type} className="icon-base text-dim shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg-bright truncate">{provider.label}</span>
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-panel-raised text-dim border border-border-strong shrink-0">
              {PROVIDER_LABELS[provider.type]}
            </span>
          </div>
          <div className="text-xs text-faint font-mono truncate">{summary || '—'}</div>
        </div>
        {needsToken && (
          <span
            className={`text-xs shrink-0 ${hasToken ? 'text-success' : 'text-warning'}`}
            title={
              hasToken
                ? 'A token is configured for this provider'
                : 'No token configured — list/get calls may be rate-limited or fail'
            }
          >
            {hasToken ? 'Token configured' : 'No token'}
          </span>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="text-faint hover:text-fg p-1 rounded cursor-pointer"
          title="Edit provider"
        >
          <Pencil className="icon-xs" />
        </button>
        <button
          type="button"
          onClick={() => void handleRemove()}
          className="text-faint hover:text-danger p-1 rounded cursor-pointer"
          title="Remove provider"
        >
          <Trash2 className="icon-xs" />
        </button>
      </div>
      <div className="flex items-center flex-wrap gap-1.5 text-xs">
        <span className="text-faint shrink-0">Projects:</span>
        {appliesTo.length === 0 ? (
          <span className="text-warning">
            Unassigned — edit to pick which projects this provider applies to.
          </span>
        ) : (
          appliesTo.map((root) => (
            <span
              key={root}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-panel-raised border border-border-strong text-dim"
              title={root}
            >
              <RepoIcon repoName={repoBasename(root)} className="text-xs" />
              {repoBasename(root)}
            </span>
          ))
        )}
      </div>
    </div>
  )
}

interface TicketProviderFormProps {
  initial?: TicketProviderConfig
  onSubmit: () => void
  onCancel: () => void
}

function TicketProviderForm({ initial, onSubmit, onCancel }: TicketProviderFormProps): JSX.Element {
  const backend = useBackend()
  const worktrees = useWorktrees()
  const [type, setType] = useState<TicketProviderType>(initial?.type ?? 'github-issues')
  // GitHub providers reuse the shared GitHub PAT / gh-cli token resolved at
  // boot — no per-provider token slot. Only Notion uses it.
  const needsToken = type === 'notion'
  const hasExistingToken = useTicketProviderHasToken(needsToken ? (initial?.id ?? '') : '')
  const [label, setLabel] = useState(initial?.label ?? '')
  const initialGh =
    initial && initial.type === 'github-issues'
      ? (initial.config as GithubIssuesConfig)
      : null
  const initialNotion =
    initial && initial.type === 'notion' ? (initial.config as NotionConfig) : null
  const [ghRepo, setGhRepo] = useState(initialGh?.repo ?? '')
  const [ghDefaultQuery, setGhDefaultQuery] = useState(initialGh?.defaultQuery ?? '')
  const [notionDatabaseId, setNotionDatabaseId] = useState(initialNotion?.databaseId ?? '')
  const [notionDescriptionProperty, setNotionDescriptionProperty] = useState(
    initialNotion?.descriptionProperty ?? ''
  )
  // Selected project roots (M2M). Carries forward the saved value on
  // edit, otherwise starts empty so the user explicitly picks.
  const [appliesToRepoRoots, setAppliesToRepoRoots] = useState<string[]>(
    initial?.appliesToRepoRoots ?? []
  )
  // Token UX matches the GitHub PAT block: hidden by default, "replace
  // token" reveals the input when one is already configured.
  const [replaceToken, setReplaceToken] = useState(!hasExistingToken)
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleRepo = (repoRoot: string): void => {
    setAppliesToRepoRoots((curr) =>
      curr.includes(repoRoot) ? curr.filter((r) => r !== repoRoot) : [...curr, repoRoot]
    )
  }

  const canSubmit =
    label.trim().length > 0 &&
    (type === 'github-issues' ? ghRepo.trim().length > 0 : notionDatabaseId.trim().length > 0)

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const config: GithubIssuesConfig | NotionConfig =
        type === 'github-issues'
          ? { repo: ghRepo.trim(), defaultQuery: ghDefaultQuery.trim() || undefined }
          : {
              databaseId: notionDatabaseId.trim(),
              descriptionProperty: notionDescriptionProperty.trim() || undefined
            }
      if (initial) {
        await backend.ticketsUpdateProvider(
          initial.id,
          { label: label.trim(), config, appliesToRepoRoots },
          replaceToken && token ? token : undefined
        )
      } else {
        await backend.ticketsAddProvider(
          { label: label.trim(), type, config, appliesToRepoRoots },
          replaceToken && token ? token : undefined
        )
      }
      onSubmit()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save provider')
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded border border-accent bg-panel-raised px-3 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-dim">Type</span>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as TicketProviderType)}
          disabled={!!initial}
          title={initial ? 'Cannot change the type of an existing provider' : undefined}
          className="flex-1 bg-app border border-border-strong rounded px-2 py-1 text-sm text-fg-bright outline-none focus:border-accent cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <option value="github-issues">{PROVIDER_LABELS['github-issues']}</option>
          <option value="notion">{PROVIDER_LABELS.notion}</option>
        </select>
      </div>

      <label className="block">
        <div className="text-xs font-semibold uppercase tracking-wider text-dim mb-1">Label</div>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Frontend tickets"
          className="w-full bg-app border border-border-strong rounded px-2 py-1.5 text-sm text-fg-bright outline-none focus:border-accent"
        />
      </label>

      {type === 'github-issues' && (
        <>
          <label className="block">
            <div className="text-xs font-semibold uppercase tracking-wider text-dim mb-1">
              Repo
            </div>
            <input
              type="text"
              value={ghRepo}
              onChange={(e) => setGhRepo(e.target.value)}
              placeholder="owner/repo"
              className="w-full bg-app border border-border-strong rounded px-2 py-1.5 text-sm text-fg-bright outline-none focus:border-accent font-mono"
            />
          </label>
          <label className="block">
            <div className="text-xs font-semibold uppercase tracking-wider text-dim mb-1">
              Default query <span className="text-faint normal-case font-normal">(optional)</span>
            </div>
            <input
              type="text"
              value={ghDefaultQuery}
              onChange={(e) => setGhDefaultQuery(e.target.value)}
              placeholder="is:open assignee:@me"
              className="w-full bg-app border border-border-strong rounded px-2 py-1.5 text-sm text-fg-bright outline-none focus:border-accent font-mono"
            />
            <p className="mt-1 text-xs text-faint">
              GitHub search syntax. Passed to the issues API as a filter.
            </p>
          </label>
        </>
      )}

      {type === 'notion' && (
        <NotionSetupFields
          initialDatabaseId={initialNotion?.databaseId ?? ''}
          initialDescriptionProperty={initialNotion?.descriptionProperty ?? ''}
          hasExistingToken={hasExistingToken}
          replaceToken={replaceToken}
          onReplaceToken={() => setReplaceToken(true)}
          token={token}
          onTokenChange={setToken}
          databaseId={notionDatabaseId}
          onDatabaseIdChange={setNotionDatabaseId}
          descriptionProperty={notionDescriptionProperty}
          onDescriptionPropertyChange={setNotionDescriptionProperty}
        />
      )}

      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-dim mb-1">
          Apply to projects
        </div>
        {worktrees.repoRoots.length === 0 ? (
          <p className="text-xs text-faint">
            No projects configured yet. Add a repository to Harness first; you can come back and link
            this provider afterwards.
          </p>
        ) : (
          <div className="space-y-1">
            {worktrees.repoRoots.map((root) => {
              const checked = appliesToRepoRoots.includes(root)
              return (
                <label
                  key={root}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-panel cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleRepo(root)}
                    className="accent-current icon-base cursor-pointer"
                  />
                  <RepoIcon repoName={repoBasename(root)} className="text-sm" />
                  <span className="text-sm text-fg">{repoBasename(root)}</span>
                  <span className="text-xs text-faint font-mono truncate ml-1">{root}</span>
                </label>
              )
            })}
          </div>
        )}
        <p className="mt-1 text-xs text-faint">
          Tickets from this provider show up in the "From ticket" picker for each selected project.
        </p>
      </div>

      {type === 'github-issues' && (
        <p className="text-xs text-faint">
          GitHub providers reuse the same token Harness uses for PR data — either your Settings PAT or the local <code className="bg-panel-raised px-1 rounded">gh</code> CLI's auth. No per-provider token needed here.
        </p>
      )}

      {error && (
        <div className="flex items-center gap-1.5 text-xs text-danger bg-danger/10 border border-danger/30 rounded px-2 py-1.5">
          <AlertCircle className="icon-xs" />
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-3 py-1 text-sm text-dim hover:text-fg transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit || submitting}
          className="flex items-center gap-1.5 px-3 py-1 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Check className="icon-xs" />
          {initial ? 'Save' : 'Add provider'}
        </button>
      </div>
    </div>
  )
}

interface NotionSetupFieldsProps {
  initialDatabaseId: string
  initialDescriptionProperty: string
  hasExistingToken: boolean
  replaceToken: boolean
  onReplaceToken: () => void
  token: string
  onTokenChange: (v: string) => void
  databaseId: string
  onDatabaseIdChange: (v: string) => void
  descriptionProperty: string
  onDescriptionPropertyChange: (v: string) => void
}

/** Progressive-disclosure Notion setup.
 *
 *  1. Token — paste, then Harness queries Notion for every database the
 *     integration can see.
 *  2. Database — pick from a searchable list; Harness fetches the schema
 *     for the selected one.
 *  3. Description property — dropdown populated from the schema.
 *
 *  When editing an existing provider the user hasn't opted to replace the
 *  token for, we can't call the discovery IPC (we don't have the token
 *  in the renderer), so we degrade to a read-only display of the saved
 *  values with a "Replace token" affordance that unlocks the picker. */
function NotionSetupFields({
  initialDatabaseId,
  initialDescriptionProperty,
  hasExistingToken,
  replaceToken,
  onReplaceToken,
  token,
  onTokenChange,
  databaseId,
  onDatabaseIdChange,
  descriptionProperty,
  onDescriptionPropertyChange
}: NotionSetupFieldsProps): JSX.Element {
  const backend = useBackend()
  const canDiscover = replaceToken && token.trim().length > 0
  const [databases, setDatabases] = useState<NotionDatabaseSummary[]>([])
  const [dbLoading, setDbLoading] = useState(false)
  const [dbError, setDbError] = useState<string | null>(null)
  const [dbSearch, setDbSearch] = useState('')
  const [schema, setSchema] = useState<NotionDatabaseSchema | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [schemaError, setSchemaError] = useState<string | null>(null)

  // Fetch databases whenever the token becomes non-empty. Debounced so a
  // paste + minor edit doesn't fire twice back-to-back.
  useEffect(() => {
    if (!canDiscover) {
      setDatabases([])
      setDbLoading(false)
      setDbError(null)
      return
    }
    const t = token.trim()
    setDbLoading(true)
    setDbError(null)
    const handle = setTimeout(() => {
      let cancelled = false
      void backend
        .ticketsNotionListDatabases(t)
        .then((list) => {
          if (cancelled) return
          setDatabases(list)
          setDbLoading(false)
        })
        .catch(() => {
          if (cancelled) return
          setDbError('Could not list databases — check the token.')
          setDbLoading(false)
        })
      return () => {
        cancelled = true
      }
    }, 250)
    return () => clearTimeout(handle)
  }, [backend, canDiscover, token])

  // Fetch the schema whenever a database is selected AND we have a live
  // token in memory. On edit-without-replace we skip; the saved
  // descriptionProperty is what shows.
  useEffect(() => {
    if (!canDiscover || !databaseId) {
      setSchema(null)
      setSchemaLoading(false)
      setSchemaError(null)
      return
    }
    let cancelled = false
    setSchemaLoading(true)
    setSchemaError(null)
    void backend
      .ticketsNotionDescribeDatabase(token.trim(), databaseId)
      .then((s) => {
        if (cancelled) return
        setSchema(s)
        setSchemaLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setSchemaError('Could not fetch the database schema.')
        setSchemaLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [backend, canDiscover, databaseId, token])

  const filteredDatabases = useMemo(() => {
    if (!dbSearch.trim()) return databases
    const q = dbSearch.trim().toLowerCase()
    return databases.filter((d) => d.title.toLowerCase().includes(q))
  }, [databases, dbSearch])

  // Description-property choices — anything text-shaped. `title` is
  // technically valid but is already the ticket title, so exclude it.
  const descriptionChoices = useMemo(() => {
    if (!schema) return null
    return schema.properties.filter(
      (p) => p.type === 'rich_text' || p.type === 'text'
    )
  }, [schema])

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-dim mb-1">
          Integration token
        </div>
        {hasExistingToken && !replaceToken ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-success">Token configured</span>
            <button
              type="button"
              onClick={onReplaceToken}
              className="text-xs text-dim hover:text-fg underline cursor-pointer"
            >
              Replace token
            </button>
          </div>
        ) : (
          <input
            type="password"
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder="Notion integration token (secret_… or ntn_…)"
            autoComplete="off"
            className="w-full bg-app border border-border-strong rounded px-2 py-1.5 text-sm text-fg-bright outline-none focus:border-accent font-mono"
          />
        )}
        <p className="mt-1 text-xs text-faint">
          From{' '}
          <span className="font-mono">notion.so/my-integrations</span>. Once pasted, Harness
          lists the databases the integration can see. Tokens are write-only —
          Harness encrypts them in{' '}
          <code className="bg-panel-raised px-1 rounded">secrets.enc</code> and never reads them back.
        </p>
      </div>

      {hasExistingToken && !replaceToken ? (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-dim mb-1">
            Database
          </div>
          <div className="text-sm text-fg font-mono truncate">{initialDatabaseId || '—'}</div>
          <p className="mt-1 text-xs text-faint">
            Replace the token above to switch databases or change the description property.
          </p>
          {initialDescriptionProperty && (
            <div className="mt-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-dim mb-1">
                Description property
              </div>
              <div className="text-sm text-fg font-mono">{initialDescriptionProperty}</div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-dim mb-1">
              Database
            </div>
            {!canDiscover ? (
              <p className="text-xs text-faint">Paste a token above to see your databases.</p>
            ) : dbError ? (
              <div className="flex items-center gap-1.5 text-xs text-danger">
                <AlertCircle className="icon-xs" />
                {dbError}
              </div>
            ) : dbLoading ? (
              <div className="flex items-center gap-1.5 text-xs text-dim">
                <Loader2 className="icon-xs animate-spin" />
                Listing databases…
              </div>
            ) : databases.length === 0 ? (
              <p className="text-xs text-warning">
                No databases visible. Share at least one with your integration (database → ··· →
                Connections).
              </p>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="icon-xs absolute left-2 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
                  <input
                    type="text"
                    value={dbSearch}
                    onChange={(e) => setDbSearch(e.target.value)}
                    placeholder="Filter…"
                    className="w-full bg-app border border-border-strong rounded pl-7 pr-2 py-1.5 text-sm text-fg-bright outline-none focus:border-accent"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto rounded border border-border bg-app">
                  {filteredDatabases.length === 0 ? (
                    <p className="text-xs text-faint px-2 py-2">No matches.</p>
                  ) : (
                    filteredDatabases.map((db) => {
                      const selected = db.id === databaseId
                      return (
                        <button
                          key={db.id}
                          type="button"
                          onClick={() => onDatabaseIdChange(db.id)}
                          className={`w-full text-left px-2 py-1.5 text-sm transition-colors cursor-pointer ${
                            selected
                              ? 'bg-accent/20 text-fg-bright'
                              : 'hover:bg-panel text-fg'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <BookOpen className="icon-xs text-dim shrink-0" />
                            <span className="truncate">{db.title}</span>
                            {selected && <Check className="icon-xs text-accent shrink-0 ml-auto" />}
                          </div>
                          <div className="text-xs text-faint font-mono truncate">{db.id}</div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-dim mb-1">
              Description property{' '}
              <span className="text-faint normal-case font-normal">(optional)</span>
            </div>
            {!databaseId ? (
              <p className="text-xs text-faint">Pick a database first.</p>
            ) : schemaLoading ? (
              <div className="flex items-center gap-1.5 text-xs text-dim">
                <Loader2 className="icon-xs animate-spin" />
                Loading schema…
              </div>
            ) : schemaError ? (
              <div className="flex items-center gap-1.5 text-xs text-danger">
                <AlertCircle className="icon-xs" />
                {schemaError}
              </div>
            ) : descriptionChoices && descriptionChoices.length === 0 ? (
              <p className="text-xs text-faint">
                No text properties in this database. Description will be empty — Claude picks up
                richer body content via the Notion MCP at runtime.
              </p>
            ) : (
              <select
                value={descriptionProperty}
                onChange={(e) => onDescriptionPropertyChange(e.target.value)}
                className="w-full bg-app border border-border-strong rounded px-2 py-1.5 text-sm text-fg-bright outline-none focus:border-accent cursor-pointer"
              >
                <option value="">— None (Claude fetches at runtime) —</option>
                {(descriptionChoices ?? []).map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <p className="mt-1 text-xs text-faint">
              The title is auto-detected — every Notion database has exactly one title column, and
              Harness finds it regardless of what it's named.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

