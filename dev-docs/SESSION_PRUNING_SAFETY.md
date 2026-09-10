# Pruning safety boundary

This is a pinned implementation contract, not a public OpenCode lock API. The
source audit used upstream `f91c6d8b25`; the executable tests independently target
the published `0.0.0-beta-19419`. Version strings alone do not certify a modified
binary. We do not support custom Core patches or arbitrary direct SQL writers.

## Native ownership

- `session/execution.ts`: `Execution.Started` commits `store.claim` before the runner.
  Success/failure/deliberate interruption releases on terminal commit. Shutdown keeps
  the claim for recovery. The plugin never impersonates these lifecycle events.
- `session/run-coordinator.ts`: the started hook completes before the first drain;
  queued/steered successor drains stay within the same busy period. The coordinator
  is process-local, so the plugin does not rely on its in-memory `isActive` value.
- `session/store.ts`: the durable claim is `session_v2.time_suspended`. Under our
  SQLite write lock either the native claim committed first (refuse) or its write
  waits until we finish (the runner subsequently reads the pruned history).
- `session/history.ts` / `runner/index.ts`: runner history is loaded from SQL, not
  a permanent cached copy of completed assistant messages. The native smoke test
  proves this for a subsequent primary request and after restart.
- `session/projector.ts` / `bus.ts`: native projections run transactionally. The
  plugin changes only an already-completed assistant row's content, with exact-data
  CAS; it does not manufacture sequence values or use a removed replacement event.

Move/revert controls do not constitute a plugin lock. Directory/project/workspace
identity and staged-revert/compaction state are rechecked *inside* the transaction.
Other native writes serialize on SQLite; the plugin preserves snapshots, metadata,
IDs and ordering. A concurrently staged revert may apply after the prune, just as
it can apply after another committed operation. It must not restore deleted payloads.

`session/generate.ts` is deliberately different: it previews history and issues a
read-only auxiliary request without claiming or mutating the session. Readers that
captured a pre-commit snapshot, including HTTP readers and auxiliary generations,
may finish with that old snapshot. Pruning is not retroactive cancellation or a
confidentiality barrier for requests already assembled/sent. Future fresh reads
observe the committed history. Titles and already-written summaries are not scrubbed.

## Identity, transaction and replay

1. Require explicit prune mode and exact audited runtime, an absolute existing local
   DB path, native session ownership matching the plugin location, and a fresh random
   `ctx.storage` challenge. A same-session backup is not enough: the challenge must
   be visible through the candidate connection in the same DB's `kv` table.
2. Use synchronous `node:sqlite`, `busy_timeout=0`, then `BEGIN IMMEDIATE`. Do not
   await anything while holding the write lock. This avoids blocking a native async
   transaction that needs the same JS event loop to complete.
3. Recheck identity and claim. Reject unknown schema/query failures, attachments,
   triggers, remote event ownership or retained event rows for the aggregate.
   There is no event rewrite/replay repair and no V1 table mutation.
4. Bound/read the row, check assistant completion, completed/error tool state,
   known content kinds, selected technical indices and canonical SHA-256 revision.
   Update only `$.content`, with CAS against the exact stored row data.
5. Insert a content-free receipt in the same transaction; commit or roll back both.
   Identical requests cannot accidentally delete the next block after indices shift.
   Receipt retention is intentional; automatic GC/expiry is not part of this patch.
6. Emit the custom event after commit. A failed notification cannot undo the write.
   The caller re-reads via the native API; reconnect reconciles authoritative data.

This does not globally coordinate arbitrary tools that directly modify `opencode.db`,
other unsafe plugins, or multiple independent Core servers sharing the same DB.
Use the supported single shared daemon; other clients may connect to it normally.

## Meaning of deletion

- **UI**: re-read stored history; not a hide flag. The SDK projection is invalidated
  too, so a later native delta cannot resurrect deleted parts from its old cache.
- **Model context**: future primary reads omit deleted technical blocks when that
  history is in the context window. A copied summary/native checkpoint or fork is a
  separate representation and is not recursively purged. Provider-specific state
  continuation and budget estimates need their own validation.
- **Persistence**: only selected V2 content arrays change. Usage/cost record past
  execution, not an estimate of the next prompt; they are intentionally preserved.
- **Physical storage**: freed SQLite pages become reusable. The DB file need not
  shrink until separately consented maintenance such as VACUUM. No such maintenance
  or automatic backup restore is performed by this plugin.

SQLite integrity, application replay, UI cache state and provider payload correctness
are distinct checks. Do not swap the earlier `pruned.db` experiment into a real daemon.
