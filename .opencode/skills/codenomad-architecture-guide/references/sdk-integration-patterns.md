# Native OpenCode V2 Integration Patterns

## Shared Service

`WorkspaceManager` owns one `OpenCodeSharedService`. Its first workspace calls upstream `Service.ensure`; later workspaces reuse/discover the same endpoint. The wrapper creates one server-side Promise client, performs health checks, owns shutdown only when CodeNomad started the endpoint, and invalidates failed connections.

`Service.ensure` has no environment option. The wrapper temporarily overlays the configured environment only around the single launch call; do not create per-workspace services to avoid that limitation.

## Locations And Directories

Workspace creation calls `client.location.get({ location: { directory } })` and records the returned directory/workspace ID. Deletion calls `client.debug.location.evict` only after the final CodeNomad owner is gone.

The instance proxy rejects unowned `directory`, `location.directory`, and `location[directory]` values. It also resolves session IDs and verifies the session location before forwarding. Keep this check at the server trust boundary.

## UI Client

```ts
const client = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
```

Use `getRootClient(instanceId)` from `packages/ui/src/stores/opencode-client.ts`. Native location/directory inputs replace the old per-worktree-client pattern. Destroy cached clients when an instance is removed.

## Native Shell And Instructions

- Shell mode calls `client.session.shell({ sessionID, command })`.
- Conversation mode adds/removes `client.session.instructions.entry` before `client.session.prompt`.
- Do not recreate plugin-backed shell, voice instructions, or background-process routes.

## Event Flow

1. The server subscribes once with `client.event.subscribe()`.
2. `InstanceEventBridge` maps location-scoped OpenCode events to CodeNomad `instance.event` records.
3. `EventBus` also carries CodeNomad events such as workspace and Yolo changes.
4. `/api/events` multiplexes those records to the UI; `packages/ui/src/lib/sse-manager.ts` reconnects and dispatches them.

Optimistic UI updates must still reconcile with native events or a refetch after reconnect.

## CodeNomad Policy Boundaries

- Git mutations run validated `git` commands in `packages/server/src/workspaces/git-mutations.ts` through `/api/workspaces/:id/worktrees/:slug/git-*`.
- Yolo is server-owned. `AutoAcceptManager` persists CodeNomad metadata and replies through the shared native client, then emits `yolo.stateChanged`/`yolo.autoAccepted`.
- Never move these operations into a browser-only client or an OpenCode plugin.
