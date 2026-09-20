# Native OpenCode V2 Integration Patterns

## Shared Service

`WorkspaceManager` owns one `OpenCodeSharedService`. Production runs the selected host or WSL CLI's official `service status`, `service start`, and `service get password` lifecycle, validates the authenticated loopback endpoint, creates one Promise client, and invalidates failed connections. It owns no private port/database/registration/PID and never stops the daemon on backend shutdown. WSL requires Windows localhost forwarding and performs no cross-namespace PID operations.

OpenCode owns standard state/database. Allowed configured environment variables are passed to `service start` for a missing daemon; existing daemons are unchanged, and `OPENCODE_DB`/`XDG_STATE_HOME` ownership variables are ignored. The guarded proxy also applies a complete profile environment through `session.environment` before every session prompt/command/shell send. Reads do not mutate it. See `dev-docs/SESSION_ENVIRONMENT.md`.

## Locations And Directories

Workspace creation calls `client.location.get({ location: { directory } })` and records the returned directory. Its `project` field supplies project metadata. Public locations have no workspace selector. Explicit Stop Workspace calls `client.debug.location.evict` before removing the logical workspace. Ordinary tab/window close only detaches local UI and never evicts.

The technical minimum is 2.0.7 for the native step-start timestamp, with 2.0.11 independently recommended/tested; old request/response/event and live location translations are retired. Preserve historical `workspaceID` validation internally: obsolete public selectors must be rejected rather than erased from imports, cursors, pending Forms or move rollback. Native 2.0.3→2.0.7/2.0.11 migration collapses workspace selectors to local directory scope while preserving session IDs. See `dev-docs/OPENCODE_V2_POST_BETA.md`.

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
