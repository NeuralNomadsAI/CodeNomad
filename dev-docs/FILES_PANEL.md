# Files panel

The right panel has one Files entry with three compact modes:

- **Workspace** (initial default): lazy directory tree for the browsed worktree.
- **Changes**: indexed and working-tree changes, including new/deleted files.
- **Commits**: paginated history, commit message and changed-file list.

The last selected mode and diff/wrap preferences use client layout storage. A
one-time migration merges the old Git and Files tab positions and visibility,
keeping access when either was visible. Each mode keeps its mounted navigation
while switching. Tree snapshots are scoped to the physical worktree directory;
mode activation revalidates only absent or stale data, and reopening a folder
re-reads its visible subtree only when the filesystem changed since loading.
An open row menu survives resizing until dismissal. Change counts are muted;
additions use success green, deletions error red.

Changes has two independently collapsible sections, initially expanded: Staged
Changes (Git actions and the compact commit field before its rows) and Changes. Collapsing keeps the commit draft and
selection, reads no status and leaves the header a staging drop target; mode
switches and refreshes keep both disclosure states.

### Large inventories

Frequent `filesystem.changed` refreshes (agents fire them, including from nested
worktrees) over thousands of changes are bounded by three rules:

- **Unchanged refreshes publish nothing.** `reuseUnchanged`
  (`git-changes-model.ts`) returns the previous status array when a read is
  structurally identical, so no memo recomputes and no row is touched. When the
  status changed, entries and list items whose fields all match (by path / by
  item id) keep their previous objects; only changed, added or removed rows reach
  the DOM. List items therefore hold primitive fields only. Request-version,
  worktree and whitespace-option fences discard stale reads.
- **Bounded sections.** `git-change-window.ts` renders each section's first
  `GIT_CHANGE_ROW_LIMIT` (200) rows and closes it with an in-place "Show 200
  more" line stating how many files are not shown; header and file counts stay the
  full totals. Revealing moves keyboard focus to the first revealed row. Reveals
  survive refreshes and mode switches, and reset when the worktree changes.
  Current, previewed and bulk-selected rows always render, and the pins are
  sticky (`stickyPins`): a row once pinned stays rendered until the worktree
  changes or its file leaves the loaded inventory (a returning file starts
  unpinned; discarding the list while Changes is hidden keeps the pins). Beyond the bound they follow the window in list order, before Show
  more, so an auto-selected most-changed file or a preview moved by staging stays
  reachable without rendering every row before it, and rows shown there stay when
  a preview closes, the selection moves or focus leaves. The sticky set grows only
  through selection and previews; focus never pins a row. A focused row that unmounts (staged/unstaged into the other
  section, changed or removed by a refresh) hands focus to its replacement for
  the same file, else to the nearest following row or Show more control that
  survived (a bulk move removes neighbours in the same update), the nearest
  preceding row, or the section header without scrolling
  (`git-change-row-focus.ts`): never the
  commit box or an action on another file, never the document.
  Shift ranges span the rendered rows only, so bulk actions never include files
  hidden beyond the bound; a collapsed section's windowed rows count as rendered.
- **Per-row selection state** uses `createSelector`, so a selection change only
  updates the rows whose state changed.

The Changes body stays mounted (hidden) in Workspace/Commits modes to keep its
disclosure state; with the bound and the unchanged-refresh rule that costs at
most a few hundred idle rows.

## Folders without a repository

The empty state reads "This folder is not a Git repository." Initialize Git
needs no confirmation: like staging, it only creates `.git`, unlike worktree or
temporary-folder removal. The route takes `{ directory }`, also refuses linked
worktrees, refuses directory-only mode with `git_required`, and translates
`location.get` through WSL when needed. A 501, an existing repository, a
mismatched folder and missing Git each show a localized message. Explicit
refresh rechecks the inventory, noticing a repository created outside
CodeNomad. Native `vcs.init` initializes the location's project directory,
which for a markerless folder is the folder itself; an unborn repository's
project ID is `global`.

## Central reader

`files-preview-view.tsx` selects the shared diff reader or the editable workspace
reader (source, rendered Markdown, raster/vector image, or binary fallback).
The composer stays mounted below it. Selections are bound to the originating
project/session and cleared on session/worktree changes. Opening the browser
preview replaces the file reader; opening a file returns the browser to chat mode.
Cancelling or hiding a view fences pending reads. Workspace/local-diff readers
refresh on filesystem invalidation, while commit contents remain immutable.

### Hide whitespace-only changes

Stored with the UI settings; the rules are in Agent conventions. Beyond them:

- The `-w` read compares worktree with index in one process, never per file.
  Because it starts after the unstaged numstat, a write between the two reads
  can only make the hidden state follow the newer content.
- Only an unstaged tracked `modified` text file with a non-zero ordinary numstat
  can get `unstagedWhitespaceOnly`. Git omits a file from `-w` output when only
  whitespace changed and its mode did not. `0 0` also covers a mode change plus
  a whitespace-only edit, and an unmerged path (a conflict resolved with "ours",
  re-indented, not added).
- Detection never compares index with HEAD: a file staged with real content and
  re-indented afterwards shows only its staged row.
- `useGitChanges` exposes only the visible inventory, so hidden files stay
  unstaged. Toggling while Changes is hidden
  drops its cached rows for the next activation; turning the option off shows
  flagged rows immediately.
- In diffs, indentation and trailing spaces/tabs compare equal while inner
  whitespace stays visible; image diffs ignore the option. The viewer always
  passes it explicitly (Monaco's default ignores trim whitespace). On Windows
  the Git LF blob often differs from CRLF worktree bytes only by line endings,
  which Monaco never draws. In show mode, Monaco 0.52's legacy diff compares
  the original line with itself, so `"foo\t"` → `"foo "` and `"\t"` → `" "` are
  never drawn.

`git-image-preview.ts` reads Git image bytes (base64) through bounded worker
reads and the bounded filesystem reader, without checkout; `GitImagePreview`
shows before/after (one-sided for additions/deletions) and other binaries keep
the unavailable-preview fallback.

Saves ask before overwriting external changes; read/write errors preserve the
draft, and explicit refresh asks before discarding edits.

Clicked readers have a reserved one-request lane beside the two background scan
slots. Start the local Monaco load alongside the content read; preview Git work
uses the worker's foreground queue. Commit metadata and parent IDs share one Git
process. Ownership checks and cancellation fencing apply to all of them.

`lib/monaco/theme.ts` resolves the selected palette's CSS tokens into Monaco hex
colors, including source tokens, editor surfaces and added/removed-line tints.
Its observer follows live appearance/custom-palette changes and is disposed with
the viewer. Read-only previews disable cross-model occurrence highlighting to
avoid Monaco 0.52's leaked cancellation on fast model changes; text selection and
insertion into the composer remain available.

## Backend boundaries

Listings register their watch before reading the directory, because native
filesystem events miss some browsed folders; this path needs no initialized
OpenCode client. Each `workspace.filesChanged` batch carries the workspace ID and
the changed listing directories. Stale visible directories reread on the
shared background read budget, with one coalesced follow-up when busy. Never
add periodic scans or polling; explicit Refresh rereads every visible directory. Version metadata is disposed with the workspace. Watches
never follow an outward symlink and cover at most the 256 most recently listed
directories per backend. A replaced directory rebinds its inode identity; setup
errors stay best effort and a later listing retries. Directory entries carry an
opaque device/inode identity distinct from mtime.

- `/api/workspaces/:id/files/preview` accepts a relative `path` and the browsed
  `directory`, validates it through the manager's worktree ownership,
  and uses the bounded filesystem content reader (5 MiB, base64). This also works
  for the explicitly opened directory in Git-degraded mode.
- `/api/workspaces/:id/worktrees/:slug/git-history` returns up to 50 commits plus
  a continuation flag. Later pages retain their original HEAD hash.
- `PUT /api/workspaces/:id/files/content` accepts the exact browsed `directory`
  alongside the relative path, checks current ownership and the deletion fence,
  and uses the shared filesystem writer. It never redirects a linked-worktree
  edit to the root checkout.
- `/git-history/:commit` returns the message and files; an optional `path` returns
  before/after text against the first parent (empty for a root commit).
- Commit IDs are full SHA-1/SHA-256 hashes. Files must belong to the commit's
  authoritative change list. Git commands run in the shared Git worker with a
  timeout and output bound. Renames use their original path; gitlinks show their
  object IDs rather than reading another repository. Binary diffs use a fallback.

## Validation

- `workspaces/file-watches.test.ts`: real host file operations, replacement,
  physical containment, bounded handles and disposal/admission fencing.
- `tests/browser/workspace-file-refresh.test.ts`: real filesystem changes through
  the watcher, shared event bus and SSE into the real Workspace tree; create,
  rename, unlink and nested files appear without F5, while idle/hidden/collapsed
  views do not generate scans.
- `lib/filesystem-events.test.ts` and `useWorkspaceTree.test.ts`: continuous
  observation bursts cannot repeatedly invalidate caches; multi-worktree batches
  reread only changed visible directories, while explicit writes remain immediate.
- `server/routes/files-history.test.ts`: real temporary root/linked repositories,
  route ownership, file bounds, history/diff and directory-only reading.
- `workspaces/git-history.test.ts`: root/merge/rename/delete/binary/gitlink cases
  and snapshot pagination across a new HEAD.
- `workspaces/git-init.test.ts` and `server/routes/git-init.test.ts`: exact-folder
  and parent refusal, ownership/deletion fence, 501/conflict/uncertain mapping
  without retry, and inventory republication; `git-requirement.test.ts` covers
  the directory-only refusal.
- `tests/browser/git-init.test.ts`: the `?uninitialized` fixture's empty state,
  Initialize Git, refreshed Changes/branch and the unsupported-runtime message.
- `node scripts/test-git-init-native.mjs <absolute CLI>`: an isolated daemon
  initializes a markerless child folder (never its parent) and checks session
  continuity plus unborn-repository inventory, status and history.
- `tests/browser/git-history.test.ts`: the real panel/readers and SessionView,
  draft preservation, late-read/session fencing, filesystem refresh and keyboard
  tree navigation. Its `?advanced` fixture mode renders the real Advanced settings
  section: by default whitespace/CRLF-only rows leave the list and its counts, a
  range "stage selected" spanning them stages only visible files; turning the
  option off lists them with their factual whitespace and line-ending notes, and
  the shared Commits reader follows it.
- `workspaces/git-status.test.ts`: real repositories with whitespace-only,
  CRLF-only, final-newline-only, real, binary, untracked, staged and
  staged-then-reindented files; a worktree mode change and an unmerged
  "ours"-resolved re-indent (both listed `0 0`, kept visible) and a staged chmod;
  the `-w` read starting after the unstaged numstat; option-keyed singleflight
  and fail-open detection.
- `tests/browser/git-changes-scale.test.ts`: a 2,700-file inventory renders 200
  rows per section plus the auto-selected row beyond the bound; an identical
  refresh mutates no node and a one-file change replaces only that row
  (MutationObserver); Show more focus, reveal persistence and worktree reset;
  cross-section ranges, row staging, a staged preview beyond the bound and drag;
  with real keyboard/mouse input, a sticky row across preview close, Tab/Shift+Tab,
  a click and its compact … menu; focus after a bulk unstage (nearest surviving
  row, scroll kept), unstage/refresh removal and never on the commit box; sticky
  rows kept across a hidden-mode discard, pruned with their file and cleared on a
  worktree change. It logs DOM/time measurements for each refresh.
- `git-change-window.test.ts`; `git-changes-model.test.ts` / `useGitChanges.test.ts`:
  identity reuse, unchanged refresh and windowing, the option in the read, staged
  rows kept, bulk targets, live toggling and stale-option responses;
  `file-viewer/diff-whitespace.test.ts` (CRLF/CR/BOM, empty sides, linear time on
  long blank runs) and `settings/behavior-registry.test.ts` cover the classifier
  and the preference. `node scripts/preview-git-history.mjs` renders the design
  fixture with synthetic data only.

## Agent conventions

- Workspace text is editable in the central file reader (including Markdown source), with Save and Ctrl/Cmd+S. Keep dirty drafts in `components/workspace-file-editor.ts`, scoped by instance/directory/path; invalidation must not replace them. Saves reread for external-change confirmation and pass the exact owned directory through the deletion-fenced filesystem write route. Images, binary content and historical diffs are read-only.
- Files row selection never opens the central preview implicitly. All three modes reuse `FileRowActions` with a pinned eye using the shared `icon-toggle` active state; secondary actions use whole-row overflow measurements. Keep selection beneath the entire row including controls and rollover in `styles/panels/control-hover.css`. Changes keeps staged/unstaged disclosures with commit actions at the top of the staged section. Git image readers use exact bounded HEAD/index/worktree or parent/commit bytes, never current-file substitutes for historical content.
- The Files panel combines Workspace, Changes and Commits in one compact switch, initially on Workspace. Its lazy worktree tree preserves expanded folders while switching modes; tree styles live in `styles/panels/workspace-tree.css`, Git navigation in `styles/panels/git-history.css`, row actions in `styles/panels/file-row-actions.css`. Workspace secondary actions are folder-specific (open, terminal, copy path) and file-specific (open, reveal, copy path). Changes rows carry explicit stage/unstage actions and drag between staged/unstaged drop zones. Large Changes inventories stay cheap: an identical status refresh publishes nothing and changed ones reuse unchanged item objects (`reuseUnchanged`), each section renders `GIT_CHANGE_ROW_LIMIT` rows plus sticky current/previewed/bulk-selected rows (kept until the worktree changes or the file leaves the loaded inventory; a hidden-mode discard keeps them; focus never pins) with an in-place Show more (`git-change-window.ts`), a focused row that unmounts hands focus only to its replacement, the nearest surviving row/Show more or the section header (without scrolling), never the commit box or `<body>` (`git-change-row-focus.ts`), ranges span rendered rows only and row state uses `createSelector`. File/diff readers close with a trailing X; the unified/split switch shows the current layout with Columns/Rows iconography. All three modes are cache-first: directory listings, git status and commit history revalidate lazily on filesystem invalidation, mode activation or explicit refresh, never on every focus or expand. `components/files-preview-view.tsx` chooses the central editable Workspace reader or shared read-only diff reader above the composer. The Advanced "Hide whitespace-only changes" preference (`hideDiffWhitespaceChanges`, default on, set only in Advanced settings) mainly removes unstaged files that Git's own `diff --numstat -z --ignore-all-space` omits entirely (whitespace incl. CRLF, inner spacing and a removed/added final newline such as `"x\n"` → `"x"`) from the Changes list, its counts and every selection/bulk/drag action: the status route runs that single extra bounded worker query only when `?hideWhitespace=1` is requested, starts it after the ordinary unstaged numstat resolves, keys its singleflight by the option and fails open. Hide only paths absent from the `-w` output: any listed record, including `0 0` (worktree mode changes, unmerged paths, or every whitespace-only file on older Git), stays visible; skip entries whose staged side is unmerged regardless of record order. Never flag untracked, binary, added/deleted/renamed or staged changes: staged rows (including a staged chmod) are never filtered out; beyond the row bound they stay counted and revealable. Toggling refreshes the visible list and discards reads made under the other option. As a secondary effect, Changes and Commits diffs map it to Monaco's native `ignoreTrimWhitespace` (diff reads ignore the option; staging/commits keep exact content), and `file-viewer/diff-whitespace.ts` mirrors Monaco's model (BOM strip, line split, space/tab trim, empty-side whole-file change) in linear time so the reader is never silently blank: factual, setting-independent notes for whitespace-only files (never advice to change the setting: Monaco 0.52 never draws same-length trailing-whitespace swaps in either mode) and for line-ending/BOM-only files, which Monaco never draws either. Do not replicate Monaco's diff loops to predict what it draws. Worktree browsing never checks out a branch or moves a session. Historical reads use bounded worker Git commands behind existing worktree ownership checks. Workspace previews use the bounded directory-authorized preview route; Monaco tokenizers ship locally.
- A known non-repository (Git available, `isGitRepo: false`) keeps Changes/Commits reachable, without Git reads, showing an explicit unconfirmed "Initialize Git" button (`right-panel/useGitInit.ts`); in no-Git directory-only mode (unknown repository status) Changes/Commits keep their Git views, whose reads report `git_required`. `POST /api/workspaces/:id/git-init` accepts only the explicitly opened folder (realpath match), refuses directory-only mode and existing/ancestor repositories, holds its deletion fence, verifies native `location.get`'s project directory is that exact folder (never a parent), then sends one native `vcs.init` with provider `git` (`workspaces/git-init.ts`); 501 `VcsInitNotSupportedError` becomes `git_init_unsupported`. Never replay: success and any failure only invalidate/re-read the inventory, git status, filesystem caches, then project metadata before sessions (the native project ID changes, sessions follow it). The `codenomad.git-availability` advisory depends only on the Git executable. Validate with `server/routes/git-init.test.ts`, `workspaces/git-init.test.ts`, `tests/browser/git-init.test.ts` and the isolated `scripts/test-git-init-native.mjs`.
- Listed Workspace directories use bounded non-recursive host watches (`workspaces/file-watches.ts`), never a recursive project scan or a new native daemon dependency. `workspace.filesChanged` feeds the shared SSE stream with browsing-root/directory scope; preserve logical alias paths separately from physical containment so internal junctions retain every listing subscriber. `lib/filesystem-events.ts` coalesces passive cache invalidations (including native filesystem events) to at most one publication every five seconds during continuous activity; no timer runs without pending observations. Explicit mutations/recovery remain immediate. `useWorkspaceTree` rereads only stale visible directories in the selected root; hidden/collapsed and other-worktree snapshots wait for demand. A changed directory device/inode identity drops only its cached subtree and cancels old reads, reloading still-expanded paths; mtime changes never force a subtree scan. Preserve ownership, physical-path/inode and workspace-lifetime fences, and close watches on removal/shutdown.
