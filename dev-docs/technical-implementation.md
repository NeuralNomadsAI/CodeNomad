# Technical Implementation

## OpenCode Dependency

Server and UI pin `@opencode-ai/client@0.0.0-next-17288`. Import the generated Promise client from `@opencode-ai/client` and service lifecycle APIs from `@opencode-ai/client/service`.

Do not add `@opencode-ai/sdk`, old `{ data, error }` SDK wrappers, `createOpencodeClient()`, or a `packages/opencode-plugin` package. Verify method signatures in `node_modules/@opencode-ai/client/dist/promise/`.

## Server Integration

`OpenCodeSharedService` is the sole service adapter:

```ts
const endpoint = await Service.ensure(options)
const client = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers(endpoint),
})
```

It caches one connection, checks discovery before reuse, invalidates failures, subscribes to one native event stream, and stops only an endpoint it started. `Service.ensure` has no environment option, so the adapter temporarily overlays configured variables only during the shared launch.

Workspace creation passes a native location:

```ts
await client.location.get({ location: { directory } })
```

`WorkspaceManager` records the returned directory/workspace ID and uses `client.debug.location.evict` after the final owner is removed.

## UI Integration

`packages/ui/src/lib/sdk-manager.ts` constructs clients with `OpenCode.make()` at `/workspaces/:id/instance/`. Use `getRootClient(instanceId)` from `packages/ui/src/stores/opencode-client.ts`; pass native `directory`/`location` inputs when required.

Session actions use native APIs directly:

```ts
await client.session.prompt({ sessionID, text, files })
await client.session.shell({ sessionID, command })
await client.session.instructions.entry.put({ sessionID, key, value })
```

Shell mode and conversation instructions are upstream features. They do not require a CodeNomad plugin.

## Routing And Security

- CodeNomad operations: `packages/ui/src/lib/api-client.ts` -> `/api/*`.
- OpenCode operations: generated client -> `/workspaces/:id/instance/api/*`.
- Browser events: `GET /api/events`; heartbeat response: `POST /api/client-connections/pong`.
- The proxy checks client-provided directories, defaults safe requests to the workspace location, and verifies session ownership before forwarding.

Never trust a browser-supplied worktree path. Resolve workspace/worktree ownership server-side.

## CodeNomad-Owned Mutations

Git status/diff and mutations remain CodeNomad APIs. Stage, unstage and commit execute validated Git commands in `packages/server/src/workspaces/git-mutations.ts`; the UI calls `/api/workspaces/:id/worktrees/:slug/git-*`.

Yolo also remains CodeNomad-owned. `AutoAcceptManager` persists policy state, observes native permission events, replies with `client.permission.reply`, and publishes `yolo.stateChanged`/`yolo.autoAccepted` over `/api/events`.

## Events

`InstanceEventBridge` consumes the one shared `client.event.subscribe()` iterable. It maps location-scoped events to workspace IDs and publishes `instance.event` through the CodeNomad `EventBus`. The UI's `sse-manager.ts` handles the multiplexed stream and reconnects; stores reconcile optimistic state with events or refetches.

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
