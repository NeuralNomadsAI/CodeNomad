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
- `database-path.ts`: daemon-side OpenCode data-directory/environment conventions, with an optional path override.
- `transaction.ts`: synchronous content-only CAS and atomic idempotency receipt.
- `claim-fence.ts`: native execution-claim and database-identity checks.
- `service.ts`: database connection and a fresh `ctx.storage` challenge.
- `isolated-store.ts`: in-memory-only test adapter; never a live write bypass.
- `plugin.ts`: native RPC registration and post-commit notifications.
- `desktop-plugin.ts` / `presence.ts`: register RPC while a CodeNomad backend is present; dispose on final close or lease expiry.
- `tui.ts` / `tui-reload.ts`: companion cache invalidation via the public TUI API.

`pruning-lifecycle.ts` and `pruning-installation.ts` beside that directory own
automatic provisioning and backend leases. The server build bundles the payload
and its dependencies under `dist/plugins/session-pruning/`, copied by both desktop hosts.
Provisioning and lease placement follow the `OPENCODE_COMPATIBILITY.md` Agent conventions.

The UI offers individual, per-message, group and session cleanup entry points. It
fetches the native message, resolves selected tools by ID and reasoning by a unique
content/time match, then sends indexes plus a canonical SHA-256 content revision.
Ambiguous reasoning or stale content fails closed. It never submits replacement text.
Selections allow up to 100,001 unique indices (0–100,000), within a 1 MiB broker
body and 16 MiB stored-message budget. Larger messages fail closed.

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
and server restart. Unit tests cover rollback and client projection/read races.
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
