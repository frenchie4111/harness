/** What `resolveRepoPath` returns for an arbitrary user-picked folder. */
export type RepoPathResolution =
  | { kind: 'ok'; root: string }
  | { kind: 'walked-up'; picked: string; resolved: string }
  | { kind: 'not-a-repo'; picked: string }

/** Result of a "pick a folder, register it as a repo" round trip.
 *  The 'walked-up' / 'not-a-repo' variants are passed straight through
 *  from `RepoPathResolution` — see desktop-shell.ts and index.ts where
 *  `return resolution` relies on that compatibility. */
export type AddRepoResult =
  | { kind: 'added'; repoRoot: string }
  | { kind: 'canceled' }
  | Exclude<RepoPathResolution, { kind: 'ok' }>
