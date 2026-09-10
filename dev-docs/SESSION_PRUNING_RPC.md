# Session content pruning through a V2 plugin

## Status and safety boundary

This replaces CodeNomad's two removed `session.messageUpdate` call sites without
forking OpenCode. The explicitly installed plugin defaults to read-only preview.
`options.mode: "prune"` enables the version-gated mutation path; it does **not**
bypass the storage/execution/ownership checks. Unsupported or absent plugins
produce a localized failure, never a legacy API fallback or optimistic deletion.

The experimental write path currently accepts **only `0.0.0-beta-19419`**.
It was exercised locally with the official Windows x64 executable, generated sessions,
two HTTP clients and a local mock provider. The independently installed package also
passed native CI on Windows, Linux and macOS in run `34424614579`. This is not a
compatibility promise for future betas, every provider, WSL, arbitrary DB schemas
or third-party writers.
The native desktop and interactive TUI release checks listed below remain separate.

No plugin was installed on the user's shared daemon. No real database was changed.
The existing desktop executable/profile and primary checkout remain untouched.

## Why this exists

- OpenCode issue [44984](https://github.com/anomalyco/opencode/issues/44984)
  originally tracked V1 part deletion parity.
- PR [48043](https://github.com/anomalyco/opencode/pull/48043) removed the replacement
  API, first published in `0.0.0-beta-19365`.
- [Maintainer guidance](https://github.com/anomalyco/opencode/issues/44984#issuecomment-5602099543)
  proposes plugin-owned SQLite access and RPC events; `ctx.db` is only a possibility.
- Follow-up: [48090](https://github.com/anomalyco/opencode/issues/48090).

An offline snapshot measured 23.12 GB initially, 18.67 GB after VACUUM alone, and
4.92 GB after pruning V2 content, legacy V1 parts and legacy technical-part events,
then vacuuming. Those figures include overlapping V1/V2 histories. That experiment
included incomplete messages and is **not** the production algorithm or a replay
compatibility proof. This prototype rejects incomplete messages.

## Modules and request flow

`packages/server/src/opencode/session-pruning/`:

- `contract.ts`: bounded, strict RPC schemas, no SQL/path/replacement-content inputs.
- `revision.ts`: browser-safe canonical content hashing.
- `planner.ts`: completed-assistant checks and technical-part-only selection.
- `preview-store.ts`: explicit read-only database access, including history before compaction.
- `transaction.ts`: synchronous content-only CAS and atomic idempotency receipt.
- `claim-fence.ts`: pinned native execution-claim and database-identity checks.
- `service.ts`: explicitly configured connection and a fresh `ctx.storage` challenge.
- `isolated-store.ts`: in-memory-only test adapter; never a live write bypass.
- `plugin.ts`: native RPC registration, opt-in gate and post-commit notifications.
- `tui.ts` / `tui-reload.ts`: companion cache invalidation via the public TUI API.

The UI keeps individual, per-message, group and session cleanup entry points. It
fetches the native message, resolves selected tools by ID and reasoning by a unique
content/time match, then sends indexes plus a canonical SHA-256 content revision.
Ambiguous reasoning or stale content fails closed. It never submits replacement text.
Selections allow up to 100,001 unique indices (0–100,000), within a 1 MiB broker
body and 16 MiB stored-message budget. Larger messages fail closed. A 5,000-part
regression test covers the previous 4,096 limit. Bulk cleanup remains a sequence
of per-message transactions, **not** an all-session transaction; existing UI failure
counts report partial completion. There is no bulk progress/cancel UI in this PR.

`POST /api/workspaces/:id/session-pruning/{preview,prune}` validates workspace
ownership from the native session location and participates in the worktree deletion
fence. It pins `codenomad.session-pruning`, the method and runtime location; arbitrary
RPC remains blocked by the instance proxy. The removed PATCH route is also blocked.
The existing server authentication middleware protects these new routes.

After commit the caller re-reads native history, never a synthesized remainder.
`rpc.codenomad.session-pruning.pruned` contains session/message IDs and the content
revision. The UI invalidates both message-load authority and its native SDK transcript,
including pending rotations, then coalesces active-session reloads. Late reads cannot
overwrite a newer pruning invalidation. Reconnect uses authoritative reconciliation.
The optional TUI companion invalidates/synchronizes its public message cache and
reconciles loaded sessions on reconnect. Unmodified third-party clients do not know
this event and may display cached history until they reload.

The receipt and content change commit together; an identical retry returns the same
receipt and re-emits the event. Receipts contain no deleted content. Event delivery
is best-effort: failure cannot roll back a committed prune. A timed-out caller must
re-read or retry the **same** request, not assume no mutation occurred.

## Version and loading notes

- UI/server client lock refreshed to the last `@opencode-ai/client@beta` publication,
  `beta-19271`. The published low-level `rpc.call` transport is used by the broker.
- Plugin definition typechecked/tested against `@opencode/plugin@0.0.0-beta-19419`,
  a development-only dependency; no plugin payload is auto-installed or added as
  a production dependency. Migration of the rest of CodeNomad to `@opencode/client`
  is separate work. The native integration test uses the actual `beta-19271` client
  against the official `beta-19419` runtime, including RPC and custom events.
- In that plugin contract, `ctx.session.message` and `ctx.db` do not exist.
- SQLite unit tests use Node's `node:sqlite`; the native test also exercises that
  driver **inside the official compiled runtime**, not an embedded SDK substitute.
  The 30 plugin/SQLite/TUI-companion unit tests also pass on Node 22.
- The module has a packable manifest with `index.ts` and `./tui` entrypoints.
  Local configuration must target the **directory**, not `plugin.ts`.
- Installation is manual and opt-in. Do not put an auto-loaded entry in this
  worktree's `.opencode/plugins`, restart the shared service, or update the runtime
  as a side effect of installation. See [deployment](SESSION_PRUNING_DEPLOYMENT.md).

## Coordination and remaining validation

See [the audited boundary](SESSION_PRUNING_SAFETY.md). `BEGIN IMMEDIATE` alone
is not sufficient: the native runner commits `time_suspended` **before** reading
history, and clears it only at terminal settlement. We check that marker under
the acquired write lock; we never set or release it ourselves. A busy connection
returns immediately rather than deadlocking native async transactions on the same
event loop. Moved ownership, staged revert/compaction, retained aggregate events,
remote event ownership, attachments and triggers fail closed.

Verified: real preview/prune RPC, active-generation refusal, both prompt/transaction
orderings, retry receipts, two event subscribers, next primary request payload,
fork isolation, pre-compaction deletion without summary changes, and server restart.
Unit tests cover rollback and client projection/read races. No actual provider
token savings are claimed: the mock's usage numbers are synthetic.

Still required before general availability: native WSL runs, interactive
TUI and two desktop-window/scroll verification, provider-specific continuation-state
and budget coverage, dedicated bulk progress/cancel UI and installation/capability UI.
Do not describe these as passed on the strength of HTTP or mocked cache tests.
Physical VACUUM, V1 cleanup and repair are separate maintenance work.

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
