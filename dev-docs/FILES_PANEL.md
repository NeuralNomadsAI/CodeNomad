# Files panel

The right panel has one Files entry with three compact modes:

- **Workspace** (initial default): lazy directory tree for the browsed worktree.
- **Changes**: indexed and working-tree changes, including new/deleted files.
- **Commits**: paginated history, commit message and changed-file list.

The last selected mode and existing diff/wrap preferences use client layout
storage. Migration merges the old Git and Files tab positions and visibility
once, retaining access when either entry was previously visible. Each mode
retains its mounted navigation while switching between them. Tree snapshots are
scoped to the physical worktree directory; collapsed folders revalidate on open.

## Central reader

`files-preview-view.tsx` selects the shared diff reader or the read-only workspace
reader (source, rendered Markdown, raster/vector image, or binary fallback).
The composer stays mounted below it. Selections are bound to the originating
project/session and cleared on session/worktree changes. Opening the browser
preview replaces the file reader; opening a file returns the browser to chat mode.
Cancelling or hiding a view fences pending reads. Workspace/local-diff readers
refresh on filesystem invalidation, while commit contents remain immutable.

Workspace source previews are intentionally read-only. The former sidebar file
editor and sidebar split viewer are retired. Monaco's tokenizers are packaged
locally for offline source highlighting.

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
  tree navigation. The design fixture remains available through
  `node scripts/preview-git-history.mjs` with synthetic data only.
