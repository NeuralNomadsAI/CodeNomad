# Session content pruning through a V2 plugin

## Status and safety boundary

A native local plugin entry registers `preview` and `prune` without forking
OpenCode. Unsupported or absent plugins produce a localized failure, never a
legacy API fallback or optimistic deletion. Version labels never gate it; see
[the audited boundary](SESSION_PRUNING_SAFETY.md).

## Integration

Pruning edits stored messages through this plugin's own SQLite access and RPC
methods, the integration OpenCode's maintainers recommend for plugins
([guidance](https://github.com/anomalyco/opencode/issues/44984#issuecomment-5602099543)).

## Modules and request flow

`packages/server/src/opencode/session-pruning/`:

- `contract.ts`: bounded, strict RPC schemas, no SQL/path/replacement-content inputs.
- `revision.ts`: browser-safe canonical content hashing.
- `planner.ts`: completed-assistant checks and technical-part-only selection.
- `preview-store.ts`: explicit read-only database access, including history before compaction.
- `media-blob.ts`: the native read form of rows stored with OpenCode's optional media storage (`experimental.media_blob`: `media:<sha256>` refs into `blob`, owned through `blob_ref`). Preview, pruning, prune candidates, navigation windows and assets inline refs, or give the native unavailable placeholder, exactly as native reads do, within the same byte budgets measured on that form. Rows naming no ref pass through untouched; ref-backed rows whose blob tables are missing or unrecognized fail closed as `unsupported_storage`.
- `database-path.ts`: daemon-side OpenCode data-directory/environment conventions, with an optional path override.
- `transaction.ts`: synchronous content-only CAS and atomic idempotency receipt.
- `claim-fence.ts`: native execution-claim and database-identity checks.
- `service.ts`: database connection and a fresh `ctx.storage` challenge.
- `isolated-store.ts`: in-memory-only test adapter; never a live write bypass.
- `plugin.ts`: native RPC registration and post-commit notifications.
- `assets-store.ts`, `assets-gallery*.ts`, `assets-conversation.ts`: tool-file assets, the [image gallery](#image-gallery) and the [Images conversation](#images-conversation).
- `history-ranked-service.ts`: the presence-owned Code Mode `codenomad.session_search` tool and versioned ranked-history RPC; ranking, scope and bounds are specified in [full-history queries](SESSION_HISTORY_QUERIES.md).
- `desktop-plugin.ts` / `presence.ts`: register RPC while a CodeNomad backend is present; dispose on final close or lease expiry. At load, before following presence, the entry also registers the Design agent and skills that backend leases request (`../design/register.ts`, contract in [OpenCode compatibility](OPENCODE_COMPATIBILITY.md#agent-conventions)).
- `tui.ts` / `tui-reload.ts`: companion cache invalidation via the public TUI API.

`pruning-lifecycle.ts` and `pruning-installation.ts` beside that directory own
automatic provisioning and backend leases. The server build bundles the payload
and its dependencies under `dist/plugins/session-pruning/`, copied by both desktop hosts.
Provisioning and lease placement follow the `OPENCODE_COMPATIBILITY.md` Agent conventions.

The UI offers individual, per-message, group and session cleanup entry points. It
fetches the native message, resolves selected tools by ID and reasoning by a unique
content/time match, then sends indexes plus a canonical SHA-256 content revision.
Ambiguous reasoning or stale content fails closed. It never submits replacement text.
The plugin compares that revision with the native read form (`media-blob.ts`), writes
surviving parts in their stored form, and in the same transaction releases the
`blob_ref` rows of refs the removed parts alone named, deleting blobs no ref keeps,
as native content updates do.
Selections allow up to 100,001 unique indices (0-100,000), within a 1 MiB broker
body. Each message must fit the 16 MiB stored and serialized native-read budgets,
with or without media refs; larger messages fail closed.

`POST /api/workspaces/:id/session-pruning/{preview,prune}` validates workspace
ownership from the native session location and participates in the worktree deletion
fence. It pins `codenomad.session-pruning`, the method and runtime location; the
instance proxy blocks arbitrary RPC. Server authentication middleware protects
these routes.

After commit the caller re-reads native history, never a synthesized remainder.
`rpc.codenomad.session-pruning.pruned` contains session/message IDs and the content
revision. The UI invalidates both message-load authority and its native SDK transcript,
including pending rotations, then coalesces active-session reloads. Late reads cannot
overwrite a newer pruning invalidation. Reconnect uses authoritative reconciliation.
The optional TUI companion invalidates/synchronizes its public message cache and
reconciles loaded sessions on reconnect. Third-party clients may display cached
history until they reload.

The receipt and content change commit together; an identical retry returns the same
receipt and re-emits the event. Receipts contain no deleted content. Event delivery
is best-effort: failure cannot roll back a committed prune. A timed-out caller must
re-read or retry the **same** request, never assume no mutation occurred.

## Image gallery

Fixed methods recompute every answer from one session's transcript inside a
`BEGIN … ROLLBACK` read, through `withHistoryDatabase` and `ownedSession`: no cache,
index, copy, file access or `kv` lookup beyond the storage challenge. Every query
stops before the revert boundary (`id < revert.messageID`).

- `images({ sessionID, cursor?, prompts? })` lists, newest first, one `image` entry
  per image file (`image/png|jpeg|gif|webp|avif`) of a `read` tool part and one
  `generation` entry per `image_generate` part, in part and file order. A page holds
  at most 32 assistant messages, 32 MiB of stored JSON (each row size-checked
  before it loads; a row over 16 MiB gives `blocked: limit`), 64 entries and 1 MiB
  serialized. Every admitted row is emitted before the cursor advances: a row the
  byte budget refuses becomes the cursor at offset 0; a full page points at the next
  entry. Cursors bind the scope and boundary (`blocked: conflict` otherwise) and
  carry `through`, the highest assistant or synthetic `seq` of the first page.
  Media refs list from blob sizes only, as `assets` does.
- `imageRead({ sessionID, target })` is `assetRead`'s byte read behind a membership
  check in the same bounded read: anything but an image file of a `read` part gives
  `blocked: not-gallery`; a row over 16 MiB gives `blocked: limit`. Decode bounds
  belong to the caller's channel.
- `imageReference({ sessionID, target })` takes an image target or a generation
  target `{ messageID, part, digest: SHA-256(part id, NUL, jobID) }` and returns
  `{ path }` relative to the location, or `refused` with `unverifiable`, `outside`,
  `changed`, `not-gallery` or `missing`. A target is never substituted.

Generation annotations (`generationKey`, `parentKeys`, `otherRefs`) appear only on
proven images; other images are `origin: "unverifiable"` and keep their pixels.
The proof covers the window rows, up to 32 older assistant rows within 32 MiB, and
one scan of at most 4,096 synthetic rows from the lowest covered `seq` to `through`,
decoded by SQLite only for rows of at most 64 KiB. A read of file `F` over
`[time.ran, time.completed]` is proven when the notice scan is complete, no
undecoded row is dated at or before the read's end, the scan covers the item's whole
range (its message and the 31 before it, within 32 MiB, unless the session starts
sooner; a range an oversized row or the scan budget cuts proves nothing), exactly one
`image_generate` call that may write `F` in that range started before that end, it
completed with a `jobID` before the read began, its single
decoded notice names `F` between the call's start and the read's start, and no
other completed notice names `F` from then until the read's end. Parents of a proven
call follow the same rule over the generation's own interval. Only a `completed`
`image_generate` part with `metadata.path` names the file it writes (that stem);
every other `image_generate` part (streaming, running, errored or completed without
`metadata.path`) may write any file, so it leaves every proof and reference it could
affect unverifiable. Relative read names and parent references resolve lexically against the session directory in the daemon's
path style (Windows without case); one outside the location has no label and no
reference. Generation states are the native part status and, when established, the
outcome of its unique decoded notice (`completed`, `error`, `cancelled`), else
`unknown`. `prompts: true` adds `prompt` (8 KiB of UTF-8, then `promptTruncated`)
and `model` to generations and proven images only in a root session marked
`codenomad.companion: images`; the host grants it. Entries never carry paths,
directories, job, notification or call IDs, or notice and error text.

References also require no later write: the newest 32 assistant rows within 32 MiB
must reach the item, with a complete notice scan, no undecoded row dated from the
read's start (a generation's notice time), no call that may write any file started
from then (`unverifiable`), and no call to the same stem started from then or other
notice naming the file after it (`changed`). A generation target is also refused as
`unverifiable` when the scan cuts its range, or while another call that may write
its file, started before its notice (or at an unknown time) in the item's range or
later, lacks a completion time or a decoded notice of its own.

Consumed contracts: `read` tool `state.content` files, `image_generate` parts
(`state.status`, `state.input.prompt|images`, `state.metadata.path` as the stem, `jobID`, `model`,
`time.ran|completed`) and its synthetic notices (`metadata.source|jobID|state|path`,
text `Saved image: <file> (`). A change leaves generations `unknown` and images
unverifiable.

## Images conversation

`imagesConversation({ mode, title?, agent?, model? })` runs for the calling location.
The lookup reads `session_v2` with `ownedSession`'s location predicate, root and
unarchived sessions whose `metadata."codenomad.companion"` is `images`, newest by
`time_created DESC, id DESC`, over at most 20,000 roots: `found`, `absent` only after
a complete scan, else `unknown`. Every mode also answers `unknown` when the database
or its storage challenge cannot be read or fails, and creates nothing; cancellation
still rejects. `open` repeats the lookup under a process-wide lock
(global symbol, keyed by database file, project, storage directory and workspace)
and creates through `ctx.session.create` only when `absent`; `new` always creates.
The lock serializes the callers of one OpenCode process; two processes sharing a
database can each create one, and the lookup then picks the newest.

## Version and loading notes

`history` and `pruneBatch` extend this plugin; see
[full-history queries](SESSION_HISTORY_QUERIES.md).

- The broker uses the published low-level `rpc.call` transport. The plugin builds through `packages/server/scripts/native-plugin-build.mjs`, which bundles application dependencies and leaves `effect` and `@opencode/plugin` to the daemon (never embed them); startup installs nothing from npm, and discovery is never gated on an exact runtime version. The native test runs the stable client against an explicitly supplied isolated official runtime, including RPC, custom events and the guarded UI proxy.
- The plugin contract lacks `ctx.session.message` and `ctx.db`; the plugin opens its own SQLite connection.
- SQLite unit tests use Node's `node:sqlite`; the native test also exercises that
  driver **inside the official compiled runtime**.
- The module has a packable manifest with `index.ts` and `./tui` entrypoints.
  Local configuration must target the **directory**, never `plugin.ts`.
- An automatically provisioned entry in the global OpenCode `plugins` directory is
  discovered for all projects. Its small lifecycle module stays loaded; pruning
  RPCs exist only while CodeNomad is present. Pruning commands never upgrade or
  restart the daemon.

## Coordination and validation coverage

Locking and claim checks: [the audited boundary](SESSION_PRUNING_SAFETY.md).

The native fixture covers real preview/prune RPC, active-generation refusal, both
prompt/transaction orderings, retry receipts, two event subscribers, next primary
request payload, fork isolation, pre-compaction deletion without summary changes,
server restart, and a tool file result read through navigation, assets and pruning
in whichever form the runtime stores it (with `experimental.media_blob`, a blob ref
whose ref and blob the prune releases), the Images conversation (one creation for
concurrent opens from two clients, a newer marked child, deletion, another location,
restart) and gallery membership on that stored tool file. Unit tests cover rollback
and client projection/read races; the gallery tests replay their proof mutations on
copies of two OpenCode 2.2.1 Images transcripts, with and without media blobs
(`assets-gallery-fixture.json`).
The mock's usage numbers are synthetic; never cite them as provider token savings.

Unvalidated: native WSL runs, interactive TUI, two desktop windows/scroll,
provider-specific continuation state and budgets, and interactive bulk
progress/cancel. Never describe these as passed on the strength of HTTP or
mocked cache tests.

## Checks

```powershell
node --import tsx --test packages/server/src/opencode/session-pruning/*.test.ts packages/server/src/server/routes/session-pruning.test.ts packages/server/src/server/__tests__/instance-proxy.test.ts
node --import tsx --conditions=browser --test --test-force-exit packages/ui/src/stores/session-actions.test.ts packages/ui/src/stores/session-pruning-events.test.ts packages/ui/src/stores/session-pruning-projection.test.ts packages/ui/src/stores/opencode-data.test.ts
node scripts/test-session-pruning-native.mjs C:/isolated-install/opencode2.exe
npm run typecheck --workspace @neuralnomads/codenomad
npm run typecheck --workspace @codenomad/ui
npm run build --workspace @codenomad/ui
```

UI store tests retain application timers; `--test-force-exit` terminates those after
the assertions finish. The separate native test creates its own DB/config/home,
starts `serve --port 0` directly (never service discovery), supplies a local provider,
and terminates only its own child. It retains its synthetic fixture/logs for inspection.
An optional third argument tests an independently installed plugin package directory.

## Agent conventions

- Session pruning is a narrow V2 plugin/RPC exception under `packages/server/src/opencode/session-pruning/`. Bundle it with the shared server for both desktop hosts and provision through normal native plugin discovery. RPC registrations follow backend presence; clean shutdown removes that backend's lease and crashes expire. Loading never deletes content. Deletion occurs only on an explicit pruning request, never behind an enable-write switch or version gate. Keep generic RPC proxy access closed. Writes validate actual storage, a fresh daemon-storage identity challenge and the native durable execution claim inside a synchronous SQLite transaction. Run isolated native concurrency/payload and client-cache regressions; tests must never target the shared daemon or a user's database.
