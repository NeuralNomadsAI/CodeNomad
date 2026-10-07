# Technical Implementation

## OpenCode Dependency

Dependency pins live in the [server manifest](../packages/server/package.json), [UI manifest](../packages/ui/package.json) and [bundled pruning manifest](../packages/server/src/opencode/session-pruning/package.json), not this document. Upgrade the client/plugin pins and lockfile together. Import the generated Promise client from `@opencode/client`; review installed declarations and proxy/API parity when its contract changes. The independently managed runtime follows [runtime support](../packages/server/src/opencode/runtime-support.ts) and [compatibility policy](OPENCODE_V2_COMPATIBILITY.md).

Do not add `@opencode-ai/sdk`, old `{ data, error }` SDK wrappers, `createOpencodeClient()`, or a `packages/opencode-plugin` package. Verify method signatures in `node_modules/@opencode/client/dist/promise/`.

## Native API Examples

The [architecture](architecture.md) is the canonical reference for service, window, routing and security ownership. Workspace creation passes a directory-only native location; `WorkspaceManager` records the returned directory and reads project metadata from `location.get().project`:

```ts
await client.location.get({ location: { directory } })
```

The UI uses `getRootClient(instanceId)` from `packages/ui/src/stores/opencode-client.ts`; pass native `directory`/`location` inputs when required. Session actions use native APIs directly:

```ts
await client.session.prompt({ sessionID, text, files })
await client.session.shell({ sessionID, command })
await client.session.instructions.entry.put({ sessionID, key, value })
```

## CodeNomad-Owned Mutations

Git status/diff and mutations remain CodeNomad APIs. Stage, unstage and commit execute validated Git commands in `packages/server/src/workspaces/git-mutations.ts`; the UI calls `/api/workspaces/:id/worktrees/:slug/git-*`.

Yolo also remains CodeNomad-owned. `AutoAcceptManager` persists policy state, observes native permission events, replies with `client.permission.reply`, and publishes `yolo.stateChanged`/`yolo.autoAccepted` over `/api/events`.

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

## Validation

- Run root typecheck or the relevant server/UI workspace typecheck.
- Run focused tests for service lifecycle, instance proxy, event bridge, Git mutations, or Yolo when changing those boundaries.
- Update server API types and UI consumers together.
