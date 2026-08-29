# CodeNomad Architecture

## Overview

CodeNomad is a SolidJS UI and Fastify server hosted by Electron or Tauri. It integrates with the latest experimental `@opencode-ai/client@beta` contract in both server and UI. The public `@opencode-ai/sdk` is an alternative embedded host; CodeNomad uses the network client.

```text
Desktop host -> CodeNomad server -> one shared OpenCode service
                    ^    |
                    |    +-> CodeNomad /api/* and /api/events
                    +------ UI clients through /workspaces/:id/instance/api/*
```

There is no `@opencode-ai/sdk` integration and no legacy `packages/opencode-plugin` package. The narrow project-local Developer Mode adapter is documented in [DEVELOPER_MODE.md](DEVELOPER_MODE.md); it does not own the OpenCode daemon or restore the V1 compatibility runtime.

## Shared Service And Locations

`packages/server/src/workspaces/opencode-service.ts` runs the selected host or WSL CLI's official `service status`, `service start`, and `service get password` lifecycle, validates the authenticated loopback endpoint, and pins that identity while active. It connects to one externally owned global daemon and never stops it on backend shutdown. CodeNomad owns no private daemon port, database, registration, or PID.

OpenCode owns the daemon's standard state and database. Configured allowed environment variables and `NODE_EXTRA_CA_CERTS` apply only if CodeNomad starts a missing daemon; an existing daemon is unchanged, and legacy `OPENCODE_DB`/`XDG_STATE_HOME` ownership settings are ignored. WSL support requires Windows localhost forwarding and executes the Linux CLI lifecycle inside the selected distribution without cross-namespace PID operations.

`packages/server/src/workspaces/manager.ts` treats selected folders as native OpenCode locations:

1. Validate the directory with `client.location.get`.
2. Store the returned `LocationRef` and publish the logical workspace.
3. Reuse the shared service for every additional directory.
4. On explicit **Stop Workspace**, evict the location and its resources from the global service, then remove CodeNomad's logical workspace.

Workspaces are not OpenCode processes and do not own ports or PIDs. Closing an ordinary tab or native window only detaches local UI state and never evicts the location.

## Native Profiles, Windows, And Client State

Electron and Tauri run one native singleton process and one CodeNomad backend per channel/config profile. A second launch opens another UUID-backed window by default; Advanced settings can restore most-recent-window focus, while `--new-window` always creates another window. Stable, dev, and non-default config profiles isolate singleton identity, backend/browser storage, and client state.

OpenCode sessions and messages remain shared through the global daemon. Window membership, tabs, drafts, view state, and native bounds are local to each UUID window. Client-state V3 is a per-window envelope over the V2 content-addressed partition graph: immutable partitions are prepared before atomic root publication, writes and migrations are fenced by current ownership, and garbage collection runs after publication while retaining every partition referenced by any window.

Previews use unguessable capabilities for HTTP and WebSocket traffic. Electron and Windows Tauri local windows open HTTP(S) pages in hardened native child webviews with isolated storage; other clients use the existing capability-scoped iframe proxy. SideCar/browser iframes remain opaque-origin sandboxes without `allow-same-origin`; preview element comments use a source-checked message bridge instead of parent DOM access.

## API Boundaries

CodeNomad control APIs live under `/api/*`. Important routes include:

- `/api/workspaces` and `/api/workspaces/:id/worktrees/*`
- `/api/workspaces/:id/worktrees/:slug/git-status|git-diff|git-stage|git-unstage|git-commit`
- `/api/events` and `/api/client-connections/pong`
- `/api/storage`, `/api/settings`, `/api/filesystem`, `/api/speech`
- `/api/opencode-plugin/automation`, authenticated by a per-process loopback token and restricted to CodeNomad-owned locations

Native OpenCode requests use `/workspaces/:id/instance/api/*`. The Fastify proxy exposes an explicit method/path allowlist, adds shared-service authorization, and rejects locations/directories outside the selected workspace or its worktrees. Session routes also verify `session.location.directory`. Upstream additions require an explicit proxy review and are not available automatically.

Yolo state endpoints currently live at `/workspaces/:id/yolo/sessions/:sessionId`; Yolo notifications use `/api/events`.

## Client And Events

`packages/ui/src/lib/sdk-manager.ts` uses `OpenCode.make()` and caches generated Promise clients by instance proxy path. `packages/ui/src/stores/opencode-client.ts` is the root-client authority; native directory/location fields replace old per-worktree SDK clients.

The server holds one `client.event.subscribe()` stream. `InstanceEventBridge` maps native location events to CodeNomad `instance.event` records, and `/api/events` multiplexes them with workspace and Yolo events for the browser. The stream is volatile and has no replay guarantee: reconnect must refetch authoritative state.

Current native events include session lifecycle/output events (`session.created`, `session.renamed`, `session.moved`, `session.status`, `session.idle`, `session.execution.*`, `session.compaction.*`, `session.text.*`, `session.reasoning.*`, `session.tool.*`), file invalidation via `filesystem.changed`, and configuration invalidation via `config.updated`.

## Feature Ownership

| Feature | Owner |
|---|---|
| Sessions, messages, permission/question APIs | OpenCode V2 |
| Shell mode | `client.session.shell` |
| Conversation instructions | `client.session.instructions.entry` |
| Background Shell management | Location-scoped OpenCode V2 `shell.*` API through the ownership-checking proxy; Status panel UI |
| Interactive PTY management | Separate OpenCode V2 `pty.*` API |
| Workspace lifecycle and directory authorization | CodeNomad |
| Git status/diff/stage/unstage/commit | CodeNomad server |
| Yolo state, persistence and auto-accept | CodeNomad server |
| Browser SSE multiplexing | CodeNomad server |
| Developer Mode and CDP feedback | Current CodeNomad desktop host and authenticated project-local adapter |
| Autonomous browser previews | CodeNomad desktop browser controllers and the same authenticated project-local adapter |

Session Shell remains separate from background Shell and PTY management. The Status panel lists location-scoped native background Shells, refreshes on Shell events/reconnect, displays native metadata, and allows ownership-checked removal. Output requests preserve native cursor pagination. Interactive PTYs remain separate. `packages/opencode-plugin` and the server plugin/background-process paths remain deleted and must not be restored; the narrow project-local adapter used by Developer Mode and browser previews is the only reviewed exception.

## Persistence

CodeNomad configuration resolves through `packages/server/src/config/location.ts`: `config.yaml`, `state.yaml`, and `instances/` under `~/.config/codenomad/`. `config.json` is migration input only.

## Key Files

- `packages/server/src/index.ts`
- `packages/server/src/server/http-server.ts`
- `packages/server/src/workspaces/opencode-service.ts`
- `packages/server/src/workspaces/manager.ts`
- `packages/server/src/workspaces/instance-events.ts`
- `packages/server/src/workspaces/git-mutations.ts`
- `packages/server/src/permissions/auto-accept-manager.ts`
- `packages/server/src/opencode/automation-plugin.ts`
- `packages/ui/src/lib/sdk-manager.ts`
- `packages/ui/src/lib/api-client.ts`
- `packages/ui/src/stores/session-api.ts`
- `packages/ui/src/stores/session-actions.ts`
