# Files panel

The right panel has one Files entry with three compact modes:

- **Workspace** (initial default): lazy directory tree for the browsed worktree.
- **Changes**: indexed and working-tree changes, including new/deleted files.
- **Commits**: paginated history, commit message and changed-file list.

The last selected mode and existing diff/wrap preferences use client layout
storage. Migration merges the old Git and Files tab positions and visibility
once, retaining access when either entry was previously visible. Each mode
retains its mounted navigation while switching between them. Tree snapshots are
scoped to the physical worktree directory. All three modes are cache-first:
listings, git status and history serve cached data and revalidate lazily on
filesystem invalidation, mode activation (when absent or marked stale) or
explicit refresh. Reopening a folder re-reads its visible subtree only when the
filesystem changed since it was loaded; collapsed folders are never re-read on
expand. Workspace rows expose a hover/focus `…` menu (folder: open, terminal,
copy path; file: open, reveal, copy path). Changes rows carry an explicit
per-file stage/unstage button and accept drag-and-drop between the staged and
unstaged sections. File row clicks select without opening the reader. Workspace,
Changes and commit-file rows share `FileRowActions`: a pinned eye toggles the
central preview with the shared `icon-toggle` active state. Secondary actions
stay inline while the measured whole row fits, falling back to the shared menu
only on overflow; an open menu survives resizing until dismissal. Hover uses
`control-hover.css`'s shared surface overlay and selection covers the whole row.
Change counts are muted; additions use success green and deletions error red.

Changes retains two independently collapsible sections, initially expanded:
Staged Changes and Changes. Git actions and the compact commit-message field
live at the top of Staged Changes, before its file rows, without an additional
Actions Git disclosure at the bottom. Collapsing either section preserves the
commit draft and selection, causes no status read, and leaves its header as a
drop target for staging/unstaging even when the file list is hidden. Mode switches
and status refreshes preserve both sections' disclosure state.

### Large inventories

A checkout with thousands of changes once froze the renderer: every
`filesystem.changed` refresh (agents keep firing them, including from nested
worktrees) rebuilt every row object, so the keyed list destroyed and recreated
all ~60k row nodes, and each row scanned the selection. Three rules now bound
that cost:

- **Unchanged refreshes publish nothing.** `reuseUnchanged`
  (`git-changes-model.ts`) returns the previous status array when a read is
  structurally identical, so no memo recomputes and no row is touched. When the
  status changed, entries and list items whose fields all match (by path / by
  item id) keep their previous objects; only changed, added or removed rows reach
  the DOM. List items therefore hold primitive fields only. The request-version,
  worktree and whitespace-option stale fences are unchanged.
- **Bounded sections.** `git-change-window.ts` renders each section's first
  `GIT_CHANGE_ROW_LIMIT` (200) rows and closes it with an in-place "Show 200
  more" line stating how many files are not shown; header and file counts stay the
  full totals. Revealing moves keyboard focus to the first revealed row. Reveals
  survive refreshes and mode switches, and reset when the worktree changes. The
  current, previewed and bulk-selected rows always render: beyond the bound they
  follow the window in list order, so an auto-selected most-changed file or a
  preview moved by staging stays reachable without rendering every row before it.
  The row holding keyboard focus is pinned too, until focus leaves it, so closing
  its preview or deselecting it from inside keeps it in place. A focused row that
  unmounts anyway (staged/unstaged into the other section, changed or removed by a
  refresh) hands focus to its replacement, else to the row or Show more control now
  in its place, the previous row or the section header
  (`git-change-row-focus.ts`); focus never falls to the document.
  Shift ranges span the rendered rows only, so bulk actions never include files
  hidden beyond the bound (collapsed sections keep their existing behavior).
- **Per-row selection state** uses `createSelector`, so a selection change only
  updates the rows whose state changed.

The Changes body stays mounted (hidden) in Workspace/Commits modes to keep its
disclosure state; with the bound and the unchanged-refresh rule that costs at
most a few hundred idle rows.

## Folders without a repository

When Git is available but the opened folder is not a repository (for example a
temporary workspace or a plain folder), Changes and Commits stay selectable and
show "This folder is not a Git repository." with an **Initialize Git** button,
without issuing any Git read. The panel no longer forces such folders back to
Workspace. When the backend cannot run Git at all (directory-only degraded mode)
the repository status is unknown and nothing changes: initialization would be
impossible there.

The button acts immediately, without confirmation: like staging or committing,
initialization is non-destructive (it only creates `.git`), unlike worktree or
temporary-folder removal, which confirm. It sends a single request and never
replays it. Success and every failure (including uncertain transport errors)
re-read the worktree inventory, invalidate filesystem caches, reload the native
project metadata and then the session list, so Changes opens on the new
repository without reloading the window. A 501 from an OpenCode runtime whose
provider cannot initialize, an existing repository, a mismatched folder and
missing Git each show a localized message. Explicit refresh in that state
rechecks the inventory, noticing a repository created outside CodeNomad.

Native `vcs.init` initializes the location's *project directory* and refreshes
its services; for a markerless folder that is the folder itself, and the native
project ID changes (a repository without commits is `global`, sessions follow
it). This is why the UI reloads project metadata before sessions.

## Central reader

`files-preview-view.tsx` selects the shared diff reader or the editable workspace
reader (source, rendered Markdown, raster/vector image, or binary fallback).
The composer stays mounted below it. Selections are bound to the originating
project/session and cleared on session/worktree changes. Opening the browser
preview replaces the file reader; opening a file returns the browser to chat mode.
Cancelling or hiding a view fences pending reads. Workspace/local-diff readers
refresh on filesystem invalidation, while commit contents remain immutable.

### Hide whitespace-only changes

Settings → Advanced "Hide whitespace-only changes" (`hideDiffWhitespaceChanges`,
enabled by default and stored with the other UI settings) mainly keeps the
Changes list focused on real edits; diffs follow it as a secondary effect.

- **List (main effect).** The status read sends `?hideWhitespace=1`, and only
  then the server adds one bounded worker query, `git diff --numstat -z
  --ignore-all-space` (worktree vs index), with no per-file processes. It starts
  only after the ordinary unstaged numstat resolves, so a write between the two
  reads can only make the hidden state follow the newer content. An unstaged
  tracked `modified` text file with a non-zero ordinary numstat gets
  `unstagedWhitespaceOnly` only when it is **absent** from the `-w` output. Git
  omits a file there when its content differs only by whitespace and its mode is
  unchanged. Git's `-w` covers CR (CRLF-only edits), whitespace inside a line and
  a removed or added final newline (`"x\n"` → `"x"`).
- **Listed records stay visible.** Any `-w` record, including `0 0`, keeps the
  file visible: Git lists a worktree mode change combined with a whitespace-only
  edit, and an unmerged path (for example a conflict resolved with "ours" and
  re-indented but not added), as `0 0`. Entries whose staged side is `unmerged`
  are skipped regardless of record order. Older Git versions that print `0 0` for
  every whitespace-only file therefore simply never hide anything (fail-open), as
  does a failed detection read. Untracked, added/deleted/renamed and binary (`-`)
  changes are never flagged. The server singleflight key and the UI read include
  the option.
- **Staged files are never filtered out.** Detection never runs for index vs
  HEAD, so every staged file a commit (`git commit`, staged content only)
  includes keeps its row; beyond the row bound such rows stay counted and
  revealable (see Large inventories). A file staged with real content and
  re-indented afterwards shows only its staged row; a staged chmod (`git
  update-index --chmod`) likewise stays in the staged section.
- **Bulk actions.** `useGitChanges` exposes only the visible inventory, so the
  file count, section counts, row selection, range/bulk "stage selected" and
  drag-and-drop can never target a hidden file; hidden files stay unstaged.
  There is no separate "stage all" command.
- **Live toggle.** Switching the option refreshes a visible Changes list (a read
  made under the previous option is discarded) or drops the cached rows so the
  next activation reads again; turning it off shows flagged rows immediately.
  Filesystem invalidation and explicit refresh are unchanged.
- **Diffs (secondary effect).** Changes and Commits share the diff reader, which
  maps the option to Monaco's native `ignoreTrimWhitespace`: lines that differ
  only by indentation or trailing spaces/tabs compare equal, while whitespace
  inside a line remains visible. The diff content read is unchanged and image
  diffs ignore the setting. Staging and commits always act on exact content.

Monaco never draws line-ending (CRLF/LF/CR) or leading byte-order-mark
differences, whatever the setting; on Windows the Git LF blob often differs from
CRLF worktree bytes only this way. `file-viewer/diff-whitespace.ts` mirrors the
model's BOM stripping, line splitting, space/tab trimming and empty-side
whole-file change in linear time, so the reader is never silently blank: one
note reports line-ending/BOM-only files and another states that only whitespace
(indentation or trailing spaces) changed. Both are factual and shown whatever the
setting, never advice to change it, because Monaco 0.52's legacy diff has an
upstream limitation: in show mode it compares the original line with itself, so
same-length trailing-whitespace swaps (`"foo\t"` → `"foo "`, `"\t"` → `" "`) are
never drawn in either mode. The classifier deliberately does not replicate
Monaco's loops to predict exactly what is drawn. Monaco itself defaults to
ignoring trim whitespace; the viewer always passes the option explicitly, so
turning the setting off shows the other whitespace changes. With the option on,
these notes mostly concern Commits diffs and staged files, since unstaged
whitespace-only files are no longer listed.

Git image previews retain base64 bytes for the actual compared revisions:
HEAD/index for staged changes, index/worktree for unstaged changes, and the
parent/commit blobs for history. `git-image-preview.ts` uses bounded worker reads
and the existing bounded filesystem reader; no checkout occurs and historical
images never fall back to the current worktree. `GitImagePreview` shows before
and after images (including one-sided additions/deletions); other binary files
retain their unavailable-preview fallback.

Workspace source retains Monaco editing, Save and Ctrl/Cmd+S in the central view;
Markdown's source mode is editable too. Images, binary content and historical
diffs remain read-only. The former sidebar layout is retired, not file editing.
Dirty drafts are retained in renderer memory per instance/directory/path when
closing or changing readers, and filesystem invalidation never replaces them.
Saving rereads the bounded authoritative file and asks before overwriting external
changes; read/write errors preserve the draft. Explicit refresh asks before
discarding edits. Monaco's tokenizers are packaged locally for offline highlighting.

Clicked readers have a reserved one-request lane beside the two background scan
slots. Start the local Monaco load alongside the content read; preview Git work
uses the worker's foreground queue. Commit metadata and parent IDs share one Git
process. These changes preserve ownership checks and cancellation fencing.

`lib/monaco/theme.ts` resolves the selected palette's CSS tokens into Monaco hex
colors, including source tokens, editor surfaces and added/removed-line tints.
Its observer follows live appearance/custom-palette changes and is disposed with
the viewer. Read-only previews disable cross-model occurrence highlighting to
avoid Monaco 0.52's leaked cancellation on fast model changes; text selection and
insertion into the composer remain available.

## Backend boundaries

- `/api/workspaces/:id/files/preview` accepts a relative `path` and the browsed
  `directory`, validates it through the manager's existing worktree ownership,
  and uses the bounded filesystem content reader (5 MiB, base64). This also works
  for the explicitly opened directory in Git-degraded mode.
- `/api/workspaces/:id/worktrees/:slug/git-history` returns up to 50 commits plus
  a continuation flag. Later pages retain their original HEAD hash.
- `PUT /api/workspaces/:id/files/content` accepts the exact browsed `directory`
  alongside the relative path, checks current ownership and the deletion fence,
  and uses the existing filesystem writer. It never redirects a linked-worktree
  edit to the root checkout.
- `POST /api/workspaces/:id/git-init` accepts `{ directory }`, which must be the
  explicitly opened folder (same realpath), never a parent or linked worktree.
  It refuses directory-only mode (`git_required`) and folders already inside a
  repository, checks ownership and holds the deletion fence, verifies that native
  `location.get` resolves that exact folder as the project directory (translated
  through WSL when needed), and calls `vcs.init` with provider `git` once. After
  success the worktree inventory is invalidated and read fresh, publishing
  `workspace.worktreesChanged` to every window. The Git availability advisory is
  unaffected: it reflects the Git executable, not repository presence.
- `/git-history/:commit` returns the message and files; an optional `path` returns
  before/after text against the first parent (empty for a root commit).
- Commit IDs are full SHA-1/SHA-256 hashes. Files must belong to the commit's
  authoritative change list. Git commands run in the existing worker with a
  timeout and output bound. Renames use their original path; gitlinks show their
  object IDs rather than reading another repository. Binary diffs use a fallback.

## Validation

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
  focus on a pinned row across preview close, unstage, refresh change/removal and
  Ctrl-deselection. It logs DOM/time measurements for each refresh.
- `git-change-window.test.ts`, plus identity reuse in `git-changes-model.test.ts`
  and unchanged-refresh/window behavior in `useGitChanges.test.ts`.
- `useGitChanges.test.ts` / `git-changes-model.test.ts`: the option in the read,
  staged rows kept, bulk targets, live toggling and stale-option responses;
  `file-viewer/diff-whitespace.test.ts` (CRLF/CR/BOM, empty sides, linear time on
  long blank runs) and `settings/behavior-registry.test.ts` cover the in-diff
  classifier and the preference. The design fixture remains available through
  `node scripts/preview-git-history.mjs` with synthetic data only.
