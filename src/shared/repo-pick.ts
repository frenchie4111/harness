/** Outcome of a "pick a folder, add it as a repo" round trip.
 *
 *  Returned by both `repo:add` (native picker on the local backend) and
 *  `repo:addAtPath` (path supplied by the in-app RemoteFilePicker). The
 *  renderer routes on `kind`:
 *
 *  - 'added' — repo was registered; focus the new entry.
 *  - 'canceled' — user dismissed the dialog; no-op.
 *  - 'walked-up' — the picked folder isn't itself a git repo, but git's
 *    upward discovery found a parent that is. Show a confirm modal that
 *    surfaces both paths so the user knows what they're actually adding.
 *  - 'not-a-repo' — no git repository anywhere up the tree from `picked`.
 *    Show an error.
 */
export type AddRepoResult =
  | { kind: 'added'; repoRoot: string }
  | { kind: 'canceled' }
  | { kind: 'walked-up'; picked: string; resolved: string }
  | { kind: 'not-a-repo'; picked: string }
