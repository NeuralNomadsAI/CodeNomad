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
- **Staged files stay visible.** Detection never runs for index vs HEAD: a
  commit (`git commit`, staged content only) therefore never includes a change
  the list does not show. A file staged with real content and re-indented
  afterwards shows only its staged row; a staged chmod (`git update-index
  --chmod`) likewise stays visible in the staged section.
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
- `useGitChanges.test.ts` / `git-changes-model.test.ts`: the option in the read,
  staged rows kept, bulk targets, live toggling and stale-option responses;
  `file-viewer/diff-whitespace.test.ts` (CRLF/CR/BOM, empty sides, linear time on
  long blank runs) and `settings/behavior-registry.test.ts` cover the in-diff
  classifier and the preference. The design fixture remains available through
  `node scripts/preview-git-history.mjs` with synthetic data only.
