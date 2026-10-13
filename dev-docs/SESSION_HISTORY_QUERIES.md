# Full-history queries and technical cleanup

## Entry points

The existing non-modal transcript search window (Ctrl/Cmd+F or the header toggle)
can query the entire session or workspace. It displays paginated excerpts and
page-local progress from that search alone. The command palette's existing remove-tools-and-
reasoning command plans against the same stored history.

Both paths use the bundled `codenomad-session-pruning` plugin's authenticated RPC,
with two fixed CodeNomad routes:

- `POST /api/workspaces/:id/session-history/query` → `history`
- `POST /api/workspaces/:id/session-history/prune` → `pruneBatch`

No generic RPC, caller-supplied SQL, database filename, replacement content or
caller-selected directory is exposed. The normal daemon and plugin provisioning
lifecycle remains in charge. The plugin performs a fresh `ctx.storage` challenge
to bind a read-only SQLite connection to this daemon. That challenge changes
temporary plugin KV state, not session content.

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
after roughly 40 ms of processing. JSON is materialized one message at a time,
limited to 16 MiB. This is not a strict SQL execution
deadline: a SQLite statement/JSON parse cannot be interrupted at that granularity.
Oversized or unsupported content is counted as skipped and reported to the UI.
There is no new index, trigger, FTS table or persistent transcript copy.

Cursors bind scope and query; the broker also binds the authorized directory
inventory. A rowid horizon excludes new rows appended during each location scan.
The search window never starts a separate statistics traversal. Opening it with
an empty query performs no history scan. Progress uses the search responses:
visible results and messages scanned for the current result page, updated as
batches arrive and reset on pagination or a new search. These are explicitly
page-local counts, not workspace totals. The technical-content switch changes
the search only; it does not trigger a tools/reasoning count.
The separate stats RPC remains available for explicit callers; message-only
stats read metadata without decoding JSON.
A traversal is not one long database transaction: concurrent edits/deletes/moves
can affect later pages, and different locations start at different times.

Search is literal and case-insensitive, with one matching excerpt per message
(up to 320 characters), in stored row order. It searches text, reasoning, tool
names/arguments/text output/errors and readable native user/system/synthetic/
skill/shell/compaction text. Attachments and opaque continuation state are not
searched. With the technical-content switch off, SQLite projects only readable
text into JavaScript, retaining original part positions. It still reads/parses the
stored JSON, but does not materialize tool output, images or provider state in JS.
Search still reports oversized/malformed messages as skipped.
The UI combines scan batches until it has at least 32 results or reaches the end,
displaying partial results as they arrive. It retains one bounded result page
(at most 63 hits, to retain the final transport batch without losing its cursor).
The next-results action advances to the next page, not the next 32 scanned rows.
Ownership checks are shared by identical locations only within each broker request
and revalidated on subsequent requests. Closing the window,
changing query/scope or leaving the session cancels obsolete UI work. Current-session
results navigate to a bounded transcript window around the selected message.
Other-session results fetch only that native message into a separate preview.
Resident matches scroll to their existing row without a network read.

## Cleanup semantics

Planning returns compact message IDs, content hashes and technical-part counts;
it does not download transcripts. The existing confirmation reports eligible
tools/reasoning and explicitly reports skipped content. Execution sends at most
16 candidates per RPC. Each message independently uses the existing synchronous
write transaction, fresh DB challenge, durable native claim/ownership checks,
content revision comparison and atomic receipt. Part indexes are computed from
the authorized stored content inside that transaction.

Text and message/session metadata remain intact. A changed message is refused
rather than silently expanding what the user confirmed. Pre-compaction messages
are included; active/incomplete content is not pruned. Whole-session cleanup is
not all-or-nothing: a later conflict does not undo successful earlier messages.
Progress and cancellation are displayed above the transcript. Cancellation stops
future batches; an already dispatched batch may commit. Ambiguous acknowledgments
invalidate the active window; identical retries use the same durable receipts.
The ordinary custom pruning events coalesce native-window refreshes in other
clients. No command creates or resumes generation.

## Validation

SQLite/plugin and route regressions cover pagination beyond 200 messages, project/
directory/legacy identity isolation, cursor binding, scan horizon, unsupported
payload reporting, active claims, rollback and batch receipt validation. UI store
tests cover compact planning, changed-content refusal, cancellation and late pages.
The Chromium fixture exercises the real search window with HTTP responses and
asserts that searches/counts and selected previews never page the transcript.

`scripts/test-session-history-native.mjs` runs only inside the isolated pruning
fixture: 241 imported synthetic messages, counts, search, cleanup and exact batch
replays against a real daemon. A second session verifies all 242 text-only workspace
matches across both sessions. The updated fixture passed on Windows with OpenCode
2.0.22. The parent fixture also checks active-generation
refusal and pre-compaction discovery. Never point this fixture at a user's DB or
shared daemon. Native Windows, browser rendering and other platforms are separate
validation claims; none implies the others.

`node scripts/benchmark-session-history.mjs [baseline-ref]` compares the working
tree with a Git revision (HEAD by default), using only a synthetic in-memory
database. Against `9597853e` on Windows, 128 tool-heavy messages
showed message-only counts around 145 → 1 ms and text search around 140 → 128 ms;
JSON materialized by text search dropped from 144,660,480 bytes to 9,600 bytes.
These are local scan measurements, excluding broker/RPC overhead, not an end-to-end
latency claim. Larger metadata/search batches additionally reduce RPC round trips.

## Navigation extension

The global timeline and current-session search now use direct bounded anchor
windows. See [SESSION_HISTORY_NAVIGATION.md](SESSION_HISTORY_NAVIGATION.md) for
the read contract, navigation/restore fences and scrollbar geometry.
