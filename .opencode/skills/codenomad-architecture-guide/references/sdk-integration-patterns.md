# Native OpenCode V2 Integration Patterns

## Shared Service

`WorkspaceManager` owns one `OpenCodeSharedService`. Production discovers an existing endpoint or launches one with CodeNomad's detached launcher. The wrapper creates one server-side Promise client, performs health checks, invalidates failed connections, and calls native `Service.stop` for a proven host daemon. WSL uses native authenticated health stop so no Windows PID fallback can run.

Lifecycle leases serialize processes and carry transferable proof: registration and endpoint credentials, daemon PID/process-start identity, host/WSL namespace, and launch signature. A peer can inherit proof, but only the final verified process may send the authenticated stop and wait for that daemon to exit.

V2 forces `OPENCODE_DB` to `~/.local/share/opencode2/opencode.db`. Never point V1 and V2 at the same database. The configured/inherited environment is part of the launch signature and applies when the service starts/restarts.

## Locations And Directories

Workspace creation calls `client.location.get({ location: { directory } })` and records the returned directory/workspace ID. Final-owner deletion queues `client.debug.location.evict`; proven final shared-service shutdown flushes it after excluding live peers.

The instance proxy is method/path allowlisted, rejects unowned paths, `directory`, `location.directory`, and `location[directory]` values, and verifies session location before forwarding. Keep this check at the server trust boundary; new upstream routes require explicit review.

## UI Client

```ts
const client = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
```

Use `getRootClient(instanceId)` from `packages/ui/src/stores/opencode-client.ts`. Native location/directory inputs replace the old per-worktree-client pattern. Destroy cached clients when an instance is removed.

## Session Shell, Background Shells, And PTYs

- Shell mode calls `client.session.shell({ sessionID, command })`.
- Conversation mode adds/removes `client.session.instructions.entry` before `client.session.prompt`.
- Session Shell remains separate from background Shell and native PTY management.
- Background Shells are location-scoped and listed with `client.shell.list`; the Status panel refreshes on Shell lifecycle events and reconnect and displays native metadata.
- Shell ID operations are ownership-checked against the native `cwd`; output preserves the native cursor and removal uses `client.shell.remove`.
- Interactive terminals use separate `client.pty.*` APIs.
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
