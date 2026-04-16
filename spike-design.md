# Review Screen — Design Document

## How the user enters the review screen

**Primary entry:** A "Review" button in the ChangedFilesPanel header (next to the refresh button). When clicked, it opens the review screen as a full-pane takeover (same pattern as Activity/Cleanup/CommandCenter). The button is only enabled when there are changed files.

**State:** A new `showReview` boolean in App.tsx, plus `reviewMode: 'working' | 'branch'` to carry the current ChangedFilesPanel mode into the review screen. Same visibility exclusion pattern as other full-pane views.

**Exit:** Back button in the review header bar (same as Activity). `Escape` also closes it.

---

## Top-level layout

```
┌──────────────────────────────────────────────────────────────────┐
│  ReviewSummaryBar                                                │
│  ← Back   branch-name   12 files · +340 −89   8/12 reviewed    │
│           [Send to Claude]  [Copy Comments]                      │
├─────────────────┬────────────────────────────────────────────────┤
│ ReviewFileTree   │  ReviewDiffPane                               │
│                  │                                                │
│ 📁 src/main/     │  src/main/store.ts                            │
│   ☐ store.ts     │  ─────────────────────────────────────        │
│   ☑ index.ts     │  @@ -42,6 +42,8 @@                          │
│ 📁 src/renderer/ │   const x = foo()                             │
│   ☐ App.tsx      │  +const y = bar()                             │
│   ☐ store.ts     │  +const z = baz()                             │
│                  │   return x                                     │
│                  │                                                │
│                  │  💬 [Click a line to comment]                  │
│                  │                                                │
│                  │  ── Pending Comments (3) ──                    │
│                  │  src/main/store.ts:45 — "Why not use..."      │
│                  │  src/renderer/App.tsx:12 — "This should..."   │
│                  │                                                │
└─────────────────┴────────────────────────────────────────────────┘
```

- **Left panel (ReviewFileTree):** ~240px wide, resizable. Directory-grouped file list with reviewed checkmarks, +/- counts, status badges.
- **Right panel (ReviewDiffPane):** Fills remaining space. Shows the diff for the selected file. Below the diff (or in a collapsible footer): pending comments list.
- The review screen replaces the workspace view entirely (full-pane takeover), same as Activity/Cleanup.

---

## File tree (ReviewFileTree)

### Grouping and ordering
Files grouped by directory (collapsible). Within each directory:
1. **Deleted files first** — quick to review, knock them out fast
2. **Modified files by total changes descending** — biggest diffs first to front-load hard ones
3. **Added files last** — new files are often boilerplate or generated

### Per-file display
Each file row shows:
- Checkbox (☐/☑) for reviewed status — click to toggle, or press `R`
- Status badge: `A` (green), `M` (yellow), `D` (red), `R` (blue)
- File name (not full path — directory is the group header)
- `+N −M` line counts in subdued text
- Comment count badge if >0 pending comments on this file

### Visual states
- **Selected file:** highlighted background (same as sidebar active worktree)
- **Reviewed file:** dimmed text, checkbox filled
- **Unreviewed with comments:** normal text, comment badge visible
- **Current file being viewed:** border-left accent

### Keyboard navigation
- `J` / `↓` — select next file
- `K` / `↑` — select previous file  
- `Enter` — open selected file's diff (auto-opens on selection)
- `R` — toggle reviewed status of selected file
- `C` — jump to comment input in the diff
- `]` — next unreviewed file (skip reviewed ones)
- `[` — previous unreviewed file
- `Escape` — close review screen

---

## Diff rendering (ReviewDiffPane)

### Approach: Reuse MonacoDiffEditor

**Decision: Reuse the existing MonacoDiffEditor component in read-only mode.**

Rationale:
- It already handles syntax highlighting, hidden unchanged regions, and the glyph margin
- The review screen diffs are always read-only (no editing during review), so we use `readOnly={true}`
- Monaco is already loaded in the app (it's used for file editing and existing diffs), so there's no additional bundle cost
- Building a custom lightweight diff renderer would be a significant effort for marginal speed gains, especially in a prototype
- The glyph margin can be repurposed for "add comment" clicks (it already has `onReferenceLine`)

### Header per file
Above the Monaco editor: file path, status badge, change stats, "Mark reviewed" button.

### Comment interaction
- Click the glyph margin (line number area) → a comment input widget appears below the diff (anchored to that line number)
- The `onReferenceLine` callback from MonacoDiffEditor already fires on glyph margin clicks — we repurpose this
- Comment input: a text area with line reference shown, "Add Comment" button saves as draft
- Draft comments appear as a list below the diff pane

---

## Inline comment system (ReviewCommentInput)

### Draft model
All comments are drafts during the review session. They accumulate in a local array:

```ts
interface ReviewComment {
  id: string
  filePath: string
  lineNumber: number
  body: string
  timestamp: number
}
```

No persistence across app restarts (prototype scope). Comments live in ReviewScreen's `useState`.

### Comment display
- Below the diff: a "Pending Comments" section listing all drafts for the current file
- Each comment shows: line number, preview of the comment text, delete button
- In the file tree: a badge count per file showing number of pending comments

### Submission modes

**"Send to Claude" (primary for prototype):**
1. Collect all comments across all files
2. Format as a structured message:
   ```
   Review feedback on your changes:
   
   src/main/store.ts:45 — Why not use a Map here instead of a plain object?
   src/renderer/App.tsx:12 — This should check for null before accessing .path
   ```
3. Write to the active Claude terminal via `window.api.writeTerminal(terminalId, message)`
4. Optionally close the review screen after sending

**"Copy to Clipboard" (self-review fallback):**
- Same formatted text, but copied to clipboard instead of sent to a terminal

**GitHub submission:** Out of scope for prototype. Future: `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with all comments batched.

---

## Review summary bar (ReviewSummaryBar)

A fixed header bar at the top of the review screen:

- **Left:** Back button (←), branch name
- **Center:** File count, total additions/deletions, review progress ("8/12 files reviewed")
- **Right:** Action buttons:
  - "Send to Claude" (primary, blue) — enabled when there are pending comments
  - "Copy Comments" (secondary) — copies all pending comments to clipboard
  - Pending comment count badge

---

## Data source

**For prototype: local git diff only.**

- Reuse `window.api.getChangedFiles(worktreePath, mode)` to get the file list
- Reuse `window.api.getFileDiffSides(worktreePath, filePath, false, mode)` to get original/modified content for Monaco
- The `mode` parameter ('working' or 'branch') is passed through from the ChangedFilesPanel's toggle state
- No GitHub API calls needed for the prototype

**Future:** For PR review from GitHub, we'd add `GET /repos/{owner}/{repo}/pulls/{number}/files` to fetch the diff, then reconstruct original/modified sides from the patch.

---

## Component structure

```
src/renderer/components/
  ReviewScreen.tsx          — full-pane container, manages review state
                              (selected file, reviewed set, comments array)
  ReviewFileTree.tsx        — left-side file list with directory grouping,
                              checkmarks, keyboard nav
  ReviewDiffPane.tsx        — right-side: file header + MonacoDiffEditor +
                              comment input + pending comments list
  ReviewCommentInput.tsx    — the comment text area widget (line ref + body + add button)
  ReviewSummaryBar.tsx      — header bar with progress, actions, branch name
```

### Props flow
- `ReviewScreen` receives: `worktreePath`, `mode`, `onClose`, `onSendToClaude`
- `ReviewScreen` owns: `selectedFile`, `reviewedFiles: Set<string>`, `comments: ReviewComment[]`, `changedFiles: ChangedFile[]`
- `ReviewFileTree` receives: files, selectedFile, reviewedFiles, commentCounts, onSelectFile, onToggleReviewed
- `ReviewDiffPane` receives: worktreePath, filePath, mode, comments for this file, onAddComment, onDeleteComment, onToggleReviewed, reviewed status
- `ReviewSummaryBar` receives: branchName, fileCount, additions, deletions, reviewedCount, totalCount, pendingCommentCount, onSendToClaude, onCopyComments, onClose

### No new IPC needed
All data comes from existing `getChangedFiles` and `getFileDiffSides` IPC calls. Terminal writing uses existing `writeTerminal`. No new main-process code required for the prototype.

---

## Integration with App.tsx

```tsx
// New state
const [showReview, setShowReview] = useState(false)
const [reviewMode, setReviewMode] = useState<'working' | 'branch'>('branch')

// In the full-pane section (after CommandCenter):
{showReview && activeWorktreeId && (
  <div className="flex-1 min-w-0 flex">
    <ReviewScreen
      worktreePath={activeWorktreeId}
      mode={reviewMode}
      onClose={() => setShowReview(false)}
      onSendToClaude={(text) => {
        // Find the active Claude terminal for this worktree and write to it
        handleSendToClaude(text)
        setShowReview(false)
      }}
    />
  </div>
)}

// Visibility exclusion: add showReview to all the !show* guards
```

### ChangedFilesPanel integration
Add an `onOpenReview` prop to ChangedFilesPanel. The button calls it with the current mode. App.tsx wires it to set `showReview=true` and `reviewMode=mode`.
