# Pruning safety boundary

Pruning relies on OpenCode's internal storage contract described here. Runtime
version labels never enable or disable pruning: actual storage, identity and
claim checks decide each request. Custom Core patches and arbitrary direct SQL
writers are unsupported.

## Native ownership

- `session/execution.ts`: `Execution.Started` commits `store.claim` before the runner.
  Success/failure/deliberate interruption releases on terminal commit. Shutdown keeps
  the claim for recovery. The plugin never impersonates these lifecycle events.
- `session/run-coordinator.ts`: the started hook completes before the first drain;
  queued/steered successor drains stay within the same busy period. The coordinator
  is process-local, so the plugin never relies on its in-memory `isActive` value.
- `session/store.ts`: the durable claim is `session_v2.time_suspended`. Under our
  SQLite write lock either the native claim committed first (refuse) or its write
  waits until we finish (the runner subsequently reads the pruned history).
- `session/history.ts` / `runner/index.ts`: runner history is loaded from SQL, so
  a subsequent primary request and a restart both see pruned content (native
  smoke test).
- `session/projector.ts` / `bus.ts`: native projections run transactionally. The
  plugin changes only an already-completed assistant row's content, with exact-data
  CAS; it never manufactures sequence values or emits replacement events.

Rather than relying on move/revert controls, the plugin rechecks
directory/project/workspace identity and staged-revert/compaction state *inside*
the transaction.
Other native writes serialize on SQLite; the plugin preserves snapshots, metadata,
IDs and ordering. A concurrently staged revert may apply after the prune, just as
it can apply after another committed operation. It must not restore deleted payloads.

`session/generate.ts` previews history and issues a read-only auxiliary request
without claiming or mutating the session. Readers that captured a pre-commit
snapshot, including HTTP readers and auxiliary generations, may finish with that
old snapshot, and requests already assembled or sent keep their content; only
fresh reads observe the committed history. Titles and already-written summaries
keep their text.

## Identity, transaction and replay

1. Require an explicit pruning request and compatible storage, an absolute existing local
   DB path, native session ownership matching the plugin location, and a fresh random
   `ctx.storage` challenge, visible through the candidate connection in the same
   DB's `kv` table (so a same-session backup copy fails).
2. Use synchronous `node:sqlite`, `busy_timeout=0`, then `BEGIN IMMEDIATE`. Do not
   await anything while holding the write lock. This avoids blocking a native async
   transaction that needs the same JS event loop to complete.
3. Recheck identity and claim. Reject unknown schema/query failures, attachments,
   triggers, remote event ownership or retained event rows for the aggregate.
   Never rewrite/replay events to repair them or mutate V1 tables.
4. Bound/read the row, check assistant completion, completed/error tool state,
   known content kinds, selected technical indices and canonical SHA-256 revision.
   Update only `$.content`, with CAS against the exact stored row data.
5. Insert a content-free receipt in the same transaction; commit or roll back both.
   Identical requests cannot accidentally delete the next block after indices shift.
   Receipts are retained indefinitely.
6. Emit the custom event after commit. A failed notification cannot undo the write.
   The caller re-reads via the native API; reconnect reconciles authoritative data.

Coordination covers the native writers of the single shared daemon only. Use that
daemon (other clients may connect to it normally); arbitrary tools writing
`opencode.db` directly, other unsafe plugins and several Core servers sharing one
DB are unsupported.

## Meaning of deletion

- **UI**: re-read stored history. The SDK projection is invalidated too, so a later
  native delta cannot resurrect deleted parts from its old cache.
- **Model context**: future primary reads omit deleted technical blocks when that
  history is in the context window. Copied summaries, native checkpoints and forks
  keep their content. Provider-specific state continuation and budget estimates
  need their own validation.
- **Persistence**: only selected V2 content arrays change. Usage/cost record past
  execution and stay unchanged.
- **Physical storage**: freed SQLite pages become reusable. The DB file shrinks
  only through separately consented maintenance such as VACUUM; this plugin never
  runs such maintenance or restores backups.

SQLite integrity, application replay, UI cache state and provider payload correctness
are distinct checks. Never point a real daemon at an offline-pruned database copy.
