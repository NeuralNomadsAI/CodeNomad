# Full-history queries and technical cleanup

## Entry points

The non-modal transcript search window (Ctrl/Cmd+F or the header toggle) can
query the entire session or workspace. It displays paginated excerpts and
page-local progress from that search alone. The command palette's
remove-tools-and-reasoning command plans against the same stored history. Navigation:
[SESSION_HISTORY_NAVIGATION.md](SESSION_HISTORY_NAVIGATION.md).

Both paths use the bundled `codenomad-session-pruning` plugin's authenticated RPC,
with two fixed CodeNomad routes:

- `POST /api/workspaces/:id/session-history/query` → `history`
- `POST /api/workspaces/:id/session-history/prune` → `pruneBatch`

Never expose generic RPC, caller-supplied SQL, a database filename, replacement
content or a caller-selected directory. The normal daemon and plugin provisioning
lifecycle governs the plugin. The plugin performs a fresh `ctx.storage` challenge
to bind a read-only SQLite connection to this daemon; that challenge writes only
temporary plugin KV state.

## Scope and resource limits

Session queries validate the session's current full native location and project.
Workspace queries enumerate the validated local worktree inventory, preserving
execution-host paths, and scan directory descendants without duplicate nested
worktree scans. A directory boundary and native workspace identity are always
required. Workspace scans include the current native project and migrated
`global` history in that directory tree, excluding other projects/independent
clones. Session-specific queries retain the session's actual project identity.
Each native page carries broker-only per-session location/count provenance. Before
publishing counts or excerpts the broker validates every contributing location
against the local repository/worktree ownership rules, including independent
clones that share a native project ID. This provenance is stripped from HTTP output.

Content counts and pruning pages examine at most 32 rows. Search and message-only
counts examine up to 1024 rows, stopping at 32 matching messages or 32 contributing
sessions. All scans yield to the native event loop between rows and end the page
after roughly 40 ms of processing; a running SQLite statement or JSON parse
finishes first. JSON is materialized one message at a time, limited to 16 MiB.
Oversized or unsupported content is counted as skipped and reported to the UI.
Never add an index, trigger, FTS table or persistent transcript copy.

Cursors bind scope and query; the broker also binds the authorized directory
inventory. A rowid horizon excludes new rows appended during each location scan.
The search window never starts a separate statistics traversal, and an empty
query scans nothing. Its progress (visible results and messages scanned for the
current page) updates as batches arrive and resets on pagination or a new search.
The technical-content switch changes only the search, never triggering a
tools/reasoning count.
The separate stats RPC serves explicit callers; message-only stats read metadata
without decoding JSON. A traversal spans many reads: concurrent
edits/deletes/moves can affect later pages, and different locations start at
different times.

Search is literal and case-insensitive, with one matching excerpt per message
(up to 320 characters), in stored row order. It searches text, reasoning, tool
names/arguments/text output/errors and readable native user/system/synthetic/
skill/shell/compaction text, skipping attachments and opaque continuation state.
With the technical-content switch off, SQLite reads/parses the stored JSON
but projects only readable text into JavaScript, retaining original part positions.
The UI combines scan batches until it has at least 32 results or reaches the end,
displaying partial results as they arrive. It retains one bounded result page
(at most 63 hits, to retain the final transport batch without losing its cursor).
The next-results action advances by result page, independently of scanned rows.
Ownership checks are shared by identical locations only within each broker request
and revalidated on subsequent requests. Closing the window,
changing query/scope or leaving the session cancels obsolete UI work. Resident matches scroll to their existing row without a network read.

Workspace results group consecutive hits by session. Each group names its
conversation and the worktree (label, normally its branch) that currently holds
the session's native location; never label hits with a commit (messages have
none). Titles and locations come from the session store, or from one
`session.get` per distinct unloaded session (older catalog pages, collapsed
subsessions), at most four in flight. These display reads never add sessions
to the list. Queued reads follow the visible results: a new query or page drops
sessions it no longer shows, session scope and closing abort them, and a
reconnect discards resolved labels. Only a not-found session is labelled
unavailable; other read failures retry on the next result update. The
preview's "Open in session" hydrates only that session and its parents, stores
the hit as its transcript anchor, selects it and returns its central surface to
chat, so the destination restores the bounded window around the message
through its normal anchor path.

## Cleanup semantics

Planning returns compact message IDs, content hashes and technical-part counts;
it never downloads transcripts. The confirmation reports eligible
tools/reasoning and explicitly reports skipped content. Execution sends at most
16 candidates per RPC. Each message independently uses the synchronous
write transaction, fresh DB challenge, durable native claim/ownership checks,
content revision comparison and atomic receipt. Part indexes are computed from
the authorized stored content inside that transaction.

Text and message/session metadata remain intact. A changed message is refused
rather than silently expanding what the user confirmed. Pre-compaction messages
are included; active/incomplete content is skipped. Whole-session cleanup commits
per message: a later conflict leaves earlier successful messages pruned.
Progress and cancellation are displayed above the transcript. Cancellation stops
future batches; an already dispatched batch may commit. Ambiguous acknowledgments
invalidate the active window; identical retries use the same durable receipts.
The ordinary custom pruning events coalesce native-window refreshes in other
clients. Cleanup never creates or resumes generation.

## Validation

SQLite/plugin and route regressions cover pagination beyond 200 messages, project/
directory/legacy identity isolation, cursor binding, scan horizon, unsupported
payload reporting, active claims, rollback and batch receipt validation. UI store
tests cover compact planning, changed-content refusal, cancellation and late pages.
The Chromium fixture exercises the real search window with HTTP responses and
asserts that searches/counts and selected previews never page the transcript.

`scripts/test-session-history-native.mjs` runs only inside the isolated pruning
fixture: 241 imported synthetic messages, counts, search, cleanup and exact batch
replays against a real daemon; a second session verifies all 242 text-only
workspace matches. The parent fixture also checks active-generation refusal and
pre-compaction discovery. Never point it at a user's DB or shared daemon; report
native Windows, browser rendering and other platforms as separate validation claims.

`node scripts/benchmark-session-history.mjs [baseline-ref]` compares local scan
cost (synthetic in-memory database, excluding broker/RPC) with a Git revision,
HEAD by default.

## Agent conventions

- Full-history search/counts use the bundled pruning plugin's bounded queries, outside the transcript store. Current-session results and the global timeline navigate through bounded anchor windows; other-session previews fetch one native message only. Search/results/progress styles live in `styles/components/history-search.css`. Workspace results group by session with its title and current worktree badge via `components/history-search-results.tsx`; unloaded labels and "Open in session" live in `stores/history-search-sessions.ts` (bounded display reads, targeted hydration, transcript anchor). Never show raw native IDs in results.
