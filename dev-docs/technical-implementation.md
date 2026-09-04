# Technical Implementation

## OpenCode Dependency

Server and UI follow `@opencode-ai/client@beta`. Import the generated Promise client from `@opencode-ai/client` and refresh the client lock before API audits or release validation. The runtime CLI is managed independently; startup validates its authenticated loopback endpoint and health response without requiring an exact version string. Review current documentation, installed declarations, and proxy/API parity whenever the client contract changes.

Do not add `@opencode-ai/sdk`, old `{ data, error }` SDK wrappers, `createOpencodeClient()`, or a `packages/opencode-plugin` package. Verify method signatures in `node_modules/@opencode-ai/client/dist/promise/`.

## Server Integration

`OpenCodeSharedService` is the sole service adapter. Host and WSL paths both execute the selected CLI's official `service status`, `service start`, and `service get password` commands, validate the authenticated loopback endpoint, pin its identity while active, and never stop the externally owned global daemon on backend shutdown.

OpenCode owns the daemon's standard state, database, and registration; CodeNomad has no private port, database, registration, or daemon PID. Allowed configured environment variables and the current `NODE_EXTRA_CA_CERTS` are passed only to `service start` for a missing daemon. Existing daemons are unchanged, and `OPENCODE_DB`/`XDG_STATE_HOME` are ignored. WSL requires Windows localhost forwarding and runs this lifecycle inside Linux without Windows PID operations.

Workspace creation passes a native location:

```ts
await client.location.get({ location: { directory } })
```

`WorkspaceManager` records the returned directory/workspace ID. Explicit **Stop Workspace** evicts that location/resources and removes the logical workspace without stopping the global daemon. Ordinary tab/window close only detaches local UI state and does not call the delete/eviction path.

## Native Windows And Restore State

Each channel/config profile has one native singleton process and one backend. A second launch opens another UUID window by default; Advanced settings can restore MRU focus, while `--new-window` always requests another window. Stable, dev, and non-default config profiles use isolated native/browser/client-state scopes.

OpenCode sessions/messages are shared service data. Each window separately persists tab membership, drafts, view state, and native bounds in the client-state V3 envelope. Snapshot V2 is a SHA-256 content-addressed partition graph. Electron and Tauri prepare immutable partitions, fence migration/root replacement on current ownership and renderer authority, atomically publish the envelope, then conservatively sweep partitions no window references.

## UI Integration

`packages/ui/src/lib/sdk-manager.ts` constructs clients with `OpenCode.make()` at `/workspaces/:id/instance/`. Use `getRootClient(instanceId)` from `packages/ui/src/stores/opencode-client.ts`; pass native `directory`/`location` inputs when required.

Session actions use native APIs directly:

```ts
await client.session.prompt({ sessionID, text, files })
await client.session.shell({ sessionID, command })
await client.session.instructions.entry.put({ sessionID, key, value })
```

Shell mode and conversation instructions are upstream features and remain separate from native background Shells and interactive V2 PTYs. None requires a CodeNomad plugin.

Native background Shells are location-scoped and listed in the Status panel. `packages/ui/src/stores/shell-store.ts` refreshes the list on native Shell events and reconnect, exposes native metadata, and supports removal. The proxy verifies Shell `cwd` ownership before ID-scoped operations and forwards native output cursors unchanged. Interactive `pty.*` terminals remain separate.

## Routing And Security

- CodeNomad operations: `packages/ui/src/lib/api-client.ts` -> `/api/*`.
- OpenCode operations: generated client -> `/workspaces/:id/instance/api/*`.
- Browser events: `GET /api/events`; heartbeat response: `POST /api/client-connections/pong`.
- The proxy exposes only an explicit method/path allowlist, checks client-provided directories and prompt files, defaults safe requests to the workspace location, and verifies session ownership before forwarding. New OpenCode routes are unavailable until reviewed and allowlisted.

Never trust a browser-supplied worktree path. Resolve workspace/worktree ownership server-side.

Native SideCar/browser preview iframes are sandboxed without `allow-same-origin`; DOM comment inspection is therefore web-only.

## CodeNomad-Owned Mutations

Git status/diff and mutations remain CodeNomad APIs. Stage, unstage and commit execute validated Git commands in `packages/server/src/workspaces/git-mutations.ts`; the UI calls `/api/workspaces/:id/worktrees/:slug/git-*`.

Yolo also remains CodeNomad-owned. `AutoAcceptManager` persists policy state, observes native permission events, replies with `client.permission.reply`, and publishes `yolo.stateChanged`/`yolo.autoAccepted` over `/api/events`.

## Events

`InstanceEventBridge` consumes the one shared `client.event.subscribe()` iterable. It maps location-scoped events to workspace IDs and publishes `instance.event` through the CodeNomad `EventBus`. This stream is volatile: reconnection does not replay a guaranteed history, so UI stores refetch sessions and pending requests and other consumers must re-read authoritative file/config state.

Use current protocol names. Session events include `session.created`, `session.renamed`, `session.moved`, `session.status`, `session.idle`, `session.execution.*`, `session.compaction.*`, `session.text.*`, `session.reasoning.*`, and `session.tool.*`; background-process refresh events include `shell.created`, `shell.exited`, and `shell.deleted`; file and config invalidations are `filesystem.changed` and `config.updated`.

## Current Structure

```text
packages/server/src/
  server/routes/            CodeNomad /api routes
  workspaces/manager.ts     workspace/location ownership
  workspaces/opencode-service.ts
  workspaces/instance-events.ts
  workspaces/git-status.ts
  workspaces/git-mutations.ts
  permissions/              Yolo and permission policy

packages/ui/src/
  lib/api-client.ts         CodeNomad API and /api/events
  lib/sdk-manager.ts        native OpenCode Promise clients
  stores/opencode-client.ts root client authority
  stores/session-api.ts     session queries/lifecycle
  stores/session-actions.ts prompt, Shell, instructions
  stores/shell-store.ts     location-scoped native background Shell state/actions
```

Deleted `packages/opencode-plugin`, server plugin/background-process, and per-workspace runtime files are not architectural extension points and must not be restored.

## Validation

- Run root typecheck or the relevant server/UI workspace typecheck.
- Run focused tests for service lifecycle, instance proxy, event bridge, Git mutations, or Yolo when changing those boundaries.
- Update server API types and UI consumers together.
