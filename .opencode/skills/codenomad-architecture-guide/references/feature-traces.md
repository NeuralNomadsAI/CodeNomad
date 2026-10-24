# Feature Traces

## Workspace And Location

1. UI posts a folder to `/api/workspaces`.
2. `WorkspaceManager` resolves the binary launch spec and calls the single `OpenCodeSharedService`.
3. The adapter runs the selected host or WSL CLI's official `service status`, `service start`, and `service get password` lifecycle and validates the authenticated loopback endpoint. WSL requires Windows localhost forwarding and stays inside the Linux namespace.
4. `client.location.get` validates the directory and returns its native project metadata and directory-only public location.
5. CodeNomad publishes workspace events on `/api/events` and exposes `/workspaces/:id/instance` as the authorized native API proxy.
6. Closing a project tab deletes that occurrence's logical workspace without evicting its native Location; sessions continue. Other windows displaying the same record close its tab via `workspace.stopped` and notify, unlike the initiating window. Separate occurrences are unaffected. Whole-window close, quit and reload preserve restoration behavior; backend shutdown only clears connection state. The daemon keeps running through close and shutdown.

## Prompt, Shell, Instructions, And PTYs

1. UI obtains `getRootClient(instanceId)`.
2. Conversation mode updates `client.session.instructions.entry` for the voice instruction.
3. A normal prompt calls `client.session.prompt`; `!` shell mode calls native `client.session.shell`. Native Shell remains separate from PTY management.
4. The Status panel lists native background Shells for the active location, displays their native metadata, and refreshes on Shell events and reconnect.
5. Removal uses native Shell APIs; the proxy verifies native `cwd` ownership before every ID-scoped operation and preserves output cursors.
6. Interactive PTYs use the separate `pty.*` APIs.
7. The proxy checks directory/session ownership, applies the profile's session environment before prompt/command/shell sends (`workspaces/session-environment.ts`) and forwards to the shared service's `/api/*` route.
8. One upstream event subscription feeds `InstanceEventBridge`, then CodeNomad `/api/events`, then UI stores.

## Permission And Yolo

1. OpenCode emits a location-scoped permission event.
2. `InstanceEventBridge` publishes it as `instance.event`.
3. `AutoAcceptManager` checks CodeNomad-owned Yolo state.
4. If enabled, `createOpencodePermissionReplier` calls native `client.permission.reply` and emits `yolo.autoAccepted`.
5. Otherwise the UI queues the permission and replies with the native client.
6. Yolo toggle/persistence remains in CodeNomad; `/api/events` distributes `yolo.stateChanged`.

## Git Changes

1. UI reads Git status/diff from `/api/workspaces/:id/worktrees/:slug/git-status|git-diff`.
2. Stage, unstage and commit post to corresponding `git-stage`, `git-unstage` and `git-commit` routes.
3. The server resolves the owned worktree directory, validates relative paths/messages, and runs Git in `packages/server/src/workspaces/git-mutations.ts`.

Never replace mutation routes with OpenCode file/status calls; CodeNomad owns this write boundary.

## Events

- OpenCode events: shared `client.event.subscribe()` -> `InstanceEventBridge` -> `EventBus`.
- CodeNomad events: workspace/Git-adjacent policy/Yolo producers -> `EventBus`.
- Browser transport: `GET /api/events` with heartbeat/pong via `/api/client-connections/pong`.
- The native stream is volatile. On reconnect, refetch authoritative session/pending-request/file/config state.
- Invalidations use `filesystem.changed` and `config.updated`; session lifecycle/output uses `session.created`, `session.renamed`, `session.moved`, `session.execution.*` (OpenCode never publishes the declared `session.status`/`session.idle`), `session.compaction.*`, `session.text.*`, `session.reasoning.*`, and `session.tool.*`.
