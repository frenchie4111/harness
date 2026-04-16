# Review Screen — Research Notes

Research into existing code review tools to inform the Harness review screen design.

---

## 1. GitHub PR Review

**File navigation:** File tree on the left with directory grouping. Files show status (added/modified/deleted), line counts. "Viewed" checkbox per file that persists across page loads. Counter shows "X/Y files viewed."

**Review progress:** Per-file "Viewed" toggle is the primary mechanism. Bold/unbold in the file tree. Progress counter in the header.

**Inline comments:** Click a line number (or select a range) → comment box appears inline below. Comments can be individual or part of a "review" (batch). "Start a review" → accumulate comments → "Submit review" with approve/request-changes/comment. Supports markdown, code suggestions (`suggestion` blocks).

**File ordering:** Alphabetical by full path. No grouping by directory in the diff view (though the file tree groups by directory). No smart ordering by change size or importance.

**AI integration:** Copilot PR summaries (auto-generated description of changes). No inline AI review comments natively.

**What's good:** Universal familiarity. Viewed checkmarks. Batch review submission.
**What's bad:** Slow on large PRs. No keyboard nav for file-to-file in diff view. Terrible diff rendering for large files. No inter-diff (comparing revision N vs N-1).

---

## 2. Graphite

**File navigation:** Collapsible file tree on the left sidebar. Toggle with `F` key. When collapsed, a "mini-tree" stays visible for orientation. Files highlighted green (new) / red (deleted). Clicking a file scrolls diff into view.

**Review progress:** Pending comment counter in header. No prominent per-file "viewed" checkmarks (unlike GitHub). Relies on file tree position and comment counts. AI review status shown as "Running" / "Completed."

**Inline comments:** "Floating comments" — comments hover beside the code on the right side rather than being embedded inline in the diff. This keeps the diff uninterrupted. Rich text editing with slash commands. Can comment on any line, not just changed lines.

**File ordering:** Directory-structure grouping (mirrors repo layout). No documented sort by diff size.

**AI integration:** Graphite Agent auto-reviews PRs with inline comments (problem + why it matters + concrete fix). One-click commit of AI suggestions. Interactive chat on the PR page. Custom review rules (OWASP, style guides). Auto-generated PR titles/descriptions.

**Key patterns:**
- Floating comments preserve diff reading flow
- Mini-tree on collapse is a clever middle ground
- One-click commit of AI suggestions

---

## 3. ReviewBoard

**File navigation:** File list with status icons. Click to open side-by-side diff.

**Review progress:** Explicit review request lifecycle: pending → submitted → discarded. Ship-it indicator.

**Inline comments:** Click line or drag to select range. Comments are drafts until published as a batch. Each comment can be flagged as an "issue" (open/resolved/dropped) with a summary showing open issue count.

**File ordering:** Alphabetical by path.

**Key pioneered patterns:**
- **Inter-diff:** Compare revision N vs N-1 of a review (not just latest vs base). Lets reviewers see "what changed since my last review."
- **Draft-then-publish:** All comments are drafts, published as a single batch. Prevents notification spam. Superior to per-comment submission.
- **Issue tracking within reviews:** Comments can be "issues" with open/resolved/dropped states and a count.

---

## 4. Gerrit

**File navigation:** File list tab showing all modified files. Magic files (Commit Message, Merge List) appear first. Real files sorted alphabetically by full path. `J`/`K` to navigate between files in diff view. `U` to go back up.

**Review progress:** Binary reviewed/not-reviewed flag per file per user. Checkbox in file list and diff header. `R` to toggle. Auto-mark option: files marked reviewed when you open them. State is per-user, per-patch-set — resets when a new patch set is uploaded. Unreviewed changes appear bold on dashboard.

**Inline comments:** Click line or press `C`. Comments are drafts. `A` opens Reply dialog to publish ALL drafts + vote simultaneously. Each comment is "unresolved" or "resolved." Quick resolve with "Done" or "Ack."

**Attention set:** Answers "whose turn is it?" per change. Users in the attention set get a chevron icon + bold name. Automated rules:
- Adding a reviewer → they're in the attention set
- Replying → removes you from attention set
- Reviewer replies → owner added to attention set
- Submitting/abandoning → clears attention set

**Key patterns:**
- Per-file reviewed flag with `R` keyboard shortcut
- Draft-then-publish with simultaneous vote
- Attention set for turn-taking clarity
- Inter-diff via patch set selector on each side of diff

---

## 5. VS Code GitHub Pull Requests Extension

**File navigation:** "Changes" tree in sidebar groups files by directory with status icons (added/modified/deleted). Click opens side-by-side diff in editor tabs. Sequential file navigation buttons.

**Review progress:** "Viewed" checkboxes per file (synced with GitHub). Check run statuses shown as badges.

**Inline comments:** Comment widgets embedded in the diff editor gutter. Click line or select range to add comment. Existing threads shown as gutter decorations, click to expand inline. Separate "Comments" panel aggregates all PR comments.

**Key patterns:**
- IDE-context during review (go-to-definition, hover docs work in diffs)
- Comments as editor gutter widgets
- Everything anchored to the diff view

---

## 6. Cursor

**No dedicated review UI.** AI changes appear as inline diffs with green/red highlighting. Accept/reject per-change with keyboard shortcuts. No comment threads, no review status, no multi-pass review. Binary accept/reject model optimized for speed over deliberation.

**Key insight:** For reviewing AI-generated changes, the friction should be low. But Harness can do better than binary accept/reject — the user wants to understand changes, not just approve them.

---

## 7. JetBrains Space

**File navigation:** IDE-integrated, same keybindings as normal editing.

**Review progress:** Explicit "waiting on author" vs "waiting on reviewer" states.

**Inline comments:** Editor annotations. Reviewers can propose code changes directly (inline suggestions).

**Key patterns:**
- Timeline-based review mixing code comments, status changes, CI results
- Turn-based model with explicit state
- Inline code suggestions from reviewers

---

## Top 5 Patterns to Steal

### 1. Per-file "Reviewed" toggle with keyboard shortcut (GitHub + Gerrit)
A checkbox per file that marks it as reviewed. `R` or `Space` to toggle. Counter in the header showing "12/34 files reviewed." Visually dims reviewed files in the tree. This is the single most important UX pattern for review progress — without it, you lose your place.

### 2. Draft-then-publish comment batching (ReviewBoard + Gerrit + GitHub)
All comments accumulate as drafts during the review session. A single "Submit" action publishes them all at once. For the Claude use case: all comments get collected into a single follow-up prompt. For GitHub: they become a single review submission. This prevents fragmented feedback and lets the reviewer organize thoughts before sending.

### 3. Keyboard-driven file navigation (Gerrit)
`J`/`K` (or `↑`/`↓`) to move between files in the file tree. `Enter` to open a file's diff. `R` to mark reviewed. `C` to add a comment. The entire review flow should be completable without touching the mouse. Gerrit's `J`/`K`/`R`/`C` vocabulary is the gold standard.

### 4. Directory-grouped file tree with smart ordering (Graphite + custom)
Group files by directory (collapsible). Within each directory, order by: deleted files first (quick to review), then modified files by change size descending (biggest changes first — front-load the hard ones), then added files. This is better than alphabetical because it prioritizes reviewer attention.

### 5. Floating/contextual comments that don't interrupt diff flow (Graphite)
Comments appear beside the diff (or in a collapsible inline widget) rather than being inserted between diff lines. This keeps the diff readable even when there are many comments. For Harness's prototype: a slide-out comment input below the clicked line that can be collapsed, rather than a permanent insertion that pushes lines down.
