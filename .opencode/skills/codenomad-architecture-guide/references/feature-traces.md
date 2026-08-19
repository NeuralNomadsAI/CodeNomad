# Feature Traces

## Workspace And Location

1. UI posts a folder to `/api/workspaces`.
2. `WorkspaceManager` resolves the binary launch spec and calls the single `OpenCodeSharedService`.
3. The CodeNomad adapter discovers or launches one shared `opencode serve --service` endpoint under a lifecycle lock and records transferable registration, endpoint, launch-signature, PID, process-start, and namespace proof.
4. `client.location.get` validates the directory and returns native location/workspace identity.
5. CodeNomad publishes workspace events on `/api/events` and exposes `/workspaces/:id/instance` as the authorized native API proxy.
6. Final-owner deletion queues location eviction. Proven final shared-service shutdown flushes queued evictions and sends an authenticated stop only if no live CodeNomad peer remains and the exact daemon identity still matches.

## Prompt, Shell, Instructions, And PTYs

1. UI obtains `getRootClient(instanceId)`.
2. Conversation mode updates `client.session.instructions.entry` for the voice instruction.
3. A normal prompt calls `client.session.prompt`; `!` shell mode calls native `client.session.shell`. Native Shell remains separate from PTY management.
4. The Status panel lists native background Shells for the active location, displays their native metadata, and refreshes on Shell events and reconnect.
5. Removal uses native Shell APIs; the proxy verifies native `cwd` ownership before every ID-scoped operation and preserves output cursors.
6. Interactive PTYs use separate `pty.*` APIs and are not background-process records.
7. The proxy checks directory/session ownership and forwards to the shared service's `/api/*` route.
8. One upstream event subscription feeds `InstanceEventBridge`, then CodeNomad `/api/events`, then UI stores.

No CodeNomad OpenCode plugin participates in this flow. `packages/opencode-plugin` and server plugin/background-process paths remain deleted and must not be restored.

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

Do not replace mutation routes with OpenCode file/status calls; CodeNomad owns this write boundary.

## Events

- OpenCode events: shared `client.event.subscribe()` -> `InstanceEventBridge` -> `EventBus`.
- CodeNomad events: workspace/Git-adjacent policy/Yolo producers -> `EventBus`.
- Browser transport: `GET /api/events` with heartbeat/pong via `/api/client-connections/pong`.
- The native stream is volatile. On reconnect, refetch authoritative session/pending-request/file/config state rather than expecting replay.
- Current invalidations use `filesystem.changed` and `config.updated`; session lifecycle/output uses `session.created`, `session.renamed`, `session.moved`, `session.status`, `session.idle`, `session.execution.*`, `session.compaction.*`, `session.text.*`, `session.reasoning.*`, and `session.tool.*`.
