# Session content pruning through a V2 plugin (DRAFT)

## Status and safety boundary

This is a replacement-in-progress for CodeNomad's two `session.messageUpdate`
call sites, **not a release-ready restoration of deletion**. On this branch,
cleanup uses the CodeNomad RPC broker and reports a localized failure while the
plugin is absent or live mutation is blocked. There is no legacy API fallback.

The default plugin always refuses mutations. It can preview completed assistant
content using an explicitly configured SQLite filename, opened read-only.
No runtime flag enables writes. The SQL pruning engine only accepts an isolated
in-memory database without attachments, triggers, or retained events for the target
session. This restriction must not be relaxed just because an idle check succeeds.

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
- `isolated-store.ts`: transactional SQL experiment with content revision checks.
- `plugin.ts`: native `Plugin.define` / `Rpc.define` registration, read-only preview,
  unconditional live-write gate, registration disposal.

The UI keeps individual, per-message, group and session cleanup entry points. It
fetches the native message, resolves selected tools by ID and reasoning by a unique
content/time match, then sends indexes plus a canonical SHA-256 content revision.
Ambiguous reasoning or stale content fails closed. It never submits replacement text.
Selections are bounded to 4,096 parts per request; larger per-message selections
currently fail rather than silently truncating or partially applying.

`POST /api/workspaces/:id/session-pruning/{preview,prune}` validates workspace
ownership from the native session location and participates in the worktree deletion
fence. It pins `codenomad.session-pruning`, the method and runtime location; arbitrary
RPC remains blocked by the instance proxy. The removed PATCH route is also blocked.
The existing server authentication middleware protects these new routes.

After a future successful commit, the caller re-reads native history rather than
projecting a synthesized response. The contract reserves `rpc.codenomad.session-pruning.pruned`
with session/message IDs and revision. The UI recognizes that exact event, invalidates
the session load and coalesces active-session reloads. Existing instance-event routing
and reconnect reconciliation are retained. **No mutation events are emitted by the
default plugin yet**, because it cannot commit. The TUI does not automatically know
this custom event; cross-client behavior remains a release gate.

## Version and loading notes

- UI/server client lock refreshed to the last `@opencode-ai/client@beta` publication,
  `beta-19271`. The published low-level `rpc.call` transport is used by the broker.
- Plugin definition typechecked/tested against `@opencode/plugin@0.0.0-beta-19398`,
  a development-only dependency; no plugin payload is auto-installed or added as
  a production dependency. Migration of the rest of CodeNomad to `@opencode/client`
  is separate work. Cross-version RPC interoperability needs native verification.
- In that plugin contract, `ctx.session.message` and `ctx.db` do not exist.
- SQLite adapter tests use Node 25.2.1's `node:sqlite`; driver availability must be
  validated inside supported OpenCode runtime distributions, including WSL.
- For a future **explicitly approved test location**, use a local TS entry importing
  `packages/server/src/opencode/session-pruning/plugin.ts` from this checkout, with
  its development dependencies installed. Configure `options.databasePath` to an
  absolute test-copy filename. Never use the measurement's pruned DB as a live DB.
- Standalone plugin packaging, installation UX and location activation are not
  implemented. Do not add an auto-loaded entry to this worktree's `.opencode/plugins`.

## Required before leaving draft

- [ ] Establish an OpenCode-coordinated execution/mutation boundary (not a plugin mutex,
  a UI idle flag, or `BEGIN IMMEDIATE` alone). Cover prompt, queue, tools, compaction,
  move, revert, background execution and other clients.
- [ ] Version/schema gates, exact session ownership inside that boundary, backup and
  recovery strategy, compare-and-swap/retry semantics, and idempotent acknowledgement.
- [ ] Connect the validated storage adapter to the plugin's prune handler and emit
  invalidations only after commit; notification failure must not hide committed writes.
- [ ] Establish handling for retained durable events and replay. Do not copy the
  offline measurement's event deletion into production. V1 tables are separate maintenance.
- [ ] Test subsequent model payloads, tool/result pairing, provider state, token
  budgeting and compaction. Stored summaries are not retroactively scrubbed.
- [ ] Test two CodeNomad windows, disconnected clients, native projection caches and
  the official TUI, including stale-read races and selection/scroll stability.
- [ ] Resolve large single-message selection limits and bulk progress/cancellation.
- [ ] Native plugin RPC smoke test against the target published beta on host and WSL.
- [ ] Explicit opt-in deployment and capability UI with Electron/Tauri parity.
- [ ] Keep physical VACUUM separate, consented and coordinated with all DB users.

## Checks

```powershell
node --import tsx --test packages/server/src/opencode/session-pruning/pruning.test.ts packages/server/src/server/routes/session-pruning.test.ts packages/server/src/server/__tests__/instance-proxy.test.ts
node --import tsx --conditions=browser --test --test-force-exit packages/ui/src/stores/session-actions.test.ts
npm run typecheck --workspace @neuralnomads/codenomad
npm run typecheck --workspace @codenomad/ui
npm run build --workspace @codenomad/ui
```

UI store tests retain application timers; `--test-force-exit` terminates those after
the assertions finish. This is not a live mutation, model-context or native GUI test.
