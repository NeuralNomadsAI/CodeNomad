# Technical Implementation

## OpenCode Dependency

Server and UI pin the experimental `@opencode-ai/client` protocol exactly to `0.0.0-next-17353`. Import the generated Promise client from `@opencode-ai/client`. This differs from the current public `@opencode-ai/sdk` documentation; verify signatures in the installed package.

Do not add `@opencode-ai/sdk`, old `{ data, error }` SDK wrappers, `createOpencodeClient()`, or a `packages/opencode-plugin` package. Verify method signatures in `node_modules/@opencode-ai/client/dist/promise/`.

## Server Integration

`OpenCodeSharedService` is the sole service adapter. Production uses `Service.discover` and `Service.headers`, then a custom launcher and authenticated stop request; direct `Service.ensure` and `Service.stop` are not the production lifecycle.

Startup and shutdown are serialized by filesystem leases. Each CodeNomad process proves its own PID/start identity and launch signature; service proof contains the registration contents, endpoint credentials, daemon PID/start identity, and host/WSL namespace. On exit, an owner transfers that proof to an elected live peer and releases its lease; a replacement can also inherit matching proof from a stale peer under the lifecycle lock. The final process stops only after all peers are proven stale/absent and the registration, endpoint, process identity, and launch signature still match; uncertainty retains the lease and leaks safely rather than signaling a PID.

`OPENCODE_DB` must be supplied by the user through the server environment configuration or inherited process environment. It has no hardcoded default. V1 and V2 schemas must never share a database. The complete environment is part of the launch signature and takes effect on service start/restart, not on an already-running daemon.

Workspace creation passes a native location:

```ts
await client.location.get({ location: { directory } })
```

`WorkspaceManager` records the returned directory/workspace ID. After the final logical owner is removed, eviction is queued and is sent only during proven final shared-service shutdown, after cross-process peer and daemon identity checks.

## UI Integration

`packages/ui/src/lib/sdk-manager.ts` constructs clients with `OpenCode.make()` at `/workspaces/:id/instance/`. Use `getRootClient(instanceId)` from `packages/ui/src/stores/opencode-client.ts`; pass native `directory`/`location` inputs when required.

Session actions use native APIs directly:

```ts
await client.session.prompt({ sessionID, text, files })
await client.session.shell({ sessionID, command })
await client.session.instructions.entry.put({ sessionID, key, value })
```

Shell mode and conversation instructions are upstream features. They do not require a CodeNomad plugin. CodeNomad does not currently integrate PTY or background-process parity.

## Routing And Security

- CodeNomad operations: `packages/ui/src/lib/api-client.ts` -> `/api/*`.
- OpenCode operations: generated client -> `/workspaces/:id/instance/api/*`.
- Browser events: `GET /api/events`; heartbeat response: `POST /api/client-connections/pong`.
- The proxy exposes only an explicit method/path allowlist, checks client-provided directories and prompt files, defaults safe requests to the workspace location, and verifies session ownership before forwarding. New OpenCode routes are unavailable until reviewed and allowlisted.

Never trust a browser-supplied worktree path. Resolve workspace/worktree ownership server-side.

## CodeNomad-Owned Mutations

Git status/diff and mutations remain CodeNomad APIs. Stage, unstage and commit execute validated Git commands in `packages/server/src/workspaces/git-mutations.ts`; the UI calls `/api/workspaces/:id/worktrees/:slug/git-*`.

Yolo also remains CodeNomad-owned. `AutoAcceptManager` persists policy state, observes native permission events, replies with `client.permission.reply`, and publishes `yolo.stateChanged`/`yolo.autoAccepted` over `/api/events`.

## Events

`InstanceEventBridge` consumes the one shared `client.event.subscribe()` iterable. It maps location-scoped events to workspace IDs and publishes `instance.event` through the CodeNomad `EventBus`. This stream is volatile: reconnection does not replay a guaranteed history, so UI stores refetch sessions and pending requests and other consumers must re-read authoritative file/config state.

Use current protocol names. Session events include `session.created`, `session.renamed`, `session.moved`, `session.status`, `session.idle`, `session.execution.*`, `session.compaction.*`, `session.text.*`, `session.reasoning.*`, and `session.tool.*`; file and config invalidations are `filesystem.changed` and `config.updated`.

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
```

Deleted plugin, background-process, and per-workspace runtime files are not architectural extension points.

## Validation

- Run root typecheck or the relevant server/UI workspace typecheck.
- Run focused tests for service lifecycle, instance proxy, event bridge, Git mutations, or Yolo when changing those boundaries.
- Update server API types and UI consumers together.
