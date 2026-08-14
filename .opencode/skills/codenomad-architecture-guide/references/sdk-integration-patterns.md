# Native OpenCode V2 Integration Patterns

## Shared Service

`WorkspaceManager` owns one `OpenCodeSharedService`. Production discovers an existing endpoint or launches one with CodeNomad's own detached launcher; it does not call direct `Service.ensure`/`Service.stop`. The wrapper creates one server-side Promise client, performs health checks, and invalidates failed connections.

Lifecycle leases serialize processes and carry transferable proof: registration and endpoint credentials, daemon PID/process-start identity, host/WSL namespace, and launch signature. A peer can inherit proof, but only the final verified process may send the authenticated stop and wait for that daemon to exit.

V2 requires a user-configured `OPENCODE_DB`; CodeNomad has no default. Never point V1 and V2 at the same database. The configured/inherited environment is part of the launch signature and applies when the service starts/restarts.

## Locations And Directories

Workspace creation calls `client.location.get({ location: { directory } })` and records the returned directory/workspace ID. Final-owner deletion queues `client.debug.location.evict`; proven final shared-service shutdown flushes it after excluding live peers.

The instance proxy is method/path allowlisted, rejects unowned paths, `directory`, `location.directory`, and `location[directory]` values, and verifies session location before forwarding. Keep this check at the server trust boundary; new upstream routes require explicit review.

## UI Client

```ts
const client = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
```

Use `getRootClient(instanceId)` from `packages/ui/src/stores/opencode-client.ts`. Native location/directory inputs replace the old per-worktree-client pattern. Destroy cached clients when an instance is removed.

## Native Shell, Instructions, And PTYs

- Shell mode calls `client.session.shell({ sessionID, command })`.
- Conversation mode adds/removes `client.session.instructions.entry` before `client.session.prompt`.
- Shell remains separate from native PTY management.
- PTYs are location-scoped and listed with `client.pty.list`; the Status panel refreshes on PTY lifecycle events and reconnect, displays native metadata, and supports title updates.
- PTY ID operations are ownership-checked against the native `cwd`. Removal is the native stop action for a running PTY.
- Exact `next-17353` has no PTY output/read/stream API or separate stop endpoint, so output display and a distinct stop action are unavailable.
- Keep `packages/opencode-plugin` and server plugin/background-process paths deleted.

## Event Flow

1. The server subscribes once with `client.event.subscribe()`.
2. `InstanceEventBridge` maps location-scoped OpenCode events to CodeNomad `instance.event` records.
3. `EventBus` also carries CodeNomad events such as workspace and Yolo changes.
4. `/api/events` multiplexes those records to the UI; `packages/ui/src/lib/sse-manager.ts` reconnects and dispatches them.

The native stream is volatile and does not guarantee replay. Reconnect must refetch authoritative sessions and pending requests; file/config consumers must also refresh after gaps. Current invalidations are `filesystem.changed` and `config.updated`, alongside native `session.*` lifecycle/output events.

## CodeNomad Policy Boundaries

- Git mutations run validated `git` commands in `packages/server/src/workspaces/git-mutations.ts` through `/api/workspaces/:id/worktrees/:slug/git-*`.
- Yolo is server-owned. `AutoAcceptManager` persists CodeNomad metadata and replies through the shared native client, then emits `yolo.stateChanged`/`yolo.autoAccepted`.
- Never move these operations into a browser-only client or an OpenCode plugin.
