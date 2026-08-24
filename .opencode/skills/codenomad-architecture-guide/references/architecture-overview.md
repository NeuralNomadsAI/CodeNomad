# Architecture Overview

## Runtime Shape

```text
Electron/Tauri -> CodeNomad Fastify server -> one shared OpenCode service
                       |                         |
                       | /api/*                  | Location-scoped /api/*
                       v                         v
                  SolidJS UI <- /api/events <- event bridge
```

The server uses `packages/server/src/workspaces/opencode-service.ts` and the selected host or WSL CLI's official `service status`, `service start`, and `service get password` lifecycle to connect to one externally owned global daemon. It owns no private port/database/registration/PID and never stops the daemon on backend shutdown. WSL requires Windows localhost forwarding and performs no cross-namespace PID operations. `WorkspaceManager` validates each selected directory with `client.location.get()` and stores its `LocationRef`; explicit Stop Workspace evicts that location, while tab/window close only detaches local UI.

Native desktop identity is channel plus config profile: one singleton process/backend per profile, multiple UUID windows, MRU focus on second launch, and `--new-window` for another window. Stable/dev/non-default profiles isolate native/browser/client state. OpenCode sessions/messages remain shared; tabs, drafts, views, and restore membership are per-window.

Client-state V3 is a per-window envelope over the V2 content-addressed partition graph. Electron and Tauri prepare immutable partitions before atomically publishing the root, fence migration and writes on current ownership, and collect only unreferenced partitions after publication. Native SideCar/browser previews omit same-origin sandbox permission, making DOM comment inspection web-only.

## Boundaries

| Owner | Responsibilities | Main paths |
|---|---|---|
| OpenCode V2 | Sessions, messages, permissions, Forms, files, session Shell/instructions, background Shells, interactive PTYs | reviewed experimental `@opencode-ai/client` beta build pinned across server and UI |
| CodeNomad server | Shared service lifecycle, locations, proxy authorization, Git mutations, Yolo, auth, storage, speech, SSE multiplexing | `packages/server/src/` |
| CodeNomad UI | Generated Promise clients, state reconciliation, interaction and rendering | `packages/ui/src/` |
| Desktop hosts | Start CodeNomad and provide native OS integration | `packages/electron-app/`, `packages/tauri-app/` |

Session Shell remains separate from background Shell and PTY management. The Status panel lists location-scoped `shell.*` records, refreshes on Shell events/reconnect, displays native metadata, and supports ownership-checked removal. Output preserves native cursor pagination; interactive `pty.*` terminals remain separate. `packages/opencode-plugin/` and the server plugin/background-process integration remain deleted and must not be restored or used as extension points.

Native Forms are the interruption API. Allowlisted Question request/reply/reject routes are compatibility-only; do not build new Question queue architecture.

## HTTP And Events

- CodeNomad control endpoints live under `/api/*`, including `/api/workspaces`, Git routes and `/api/events`.
- OpenCode requests use `/workspaces/:id/instance/api/*`. The explicit method/path allowlist injects service auth, validates supplied paths and `location`/`directory` values, checks session ownership, and defaults safe requests to the workspace directory. New upstream routes require review and are not exposed automatically.
- Yolo state endpoints currently use `/workspaces/:id/yolo/sessions/:sessionId`; state changes and auto-accept confirmations travel over `/api/events`.
- `InstanceEventBridge` subscribes once to the volatile shared OpenCode event stream and publishes typed `instance.event` records on CodeNomad's event bus. Reconnect must refetch authoritative state because missed events are not replayed reliably.

## Persistence

`packages/server/src/config/location.ts` resolves CodeNomad data under `~/.config/codenomad/`: canonical `config.yaml`, `state.yaml`, and `instances/`, with `config.json` retained only as migration input.

OpenCode location/workspace identity is upstream state. CodeNomad persists only its own preferences and policy metadata, including Yolo state.

OpenCode owns the global daemon's standard state and database. Allowed configured environment variables apply only when CodeNomad starts a missing daemon; an existing daemon is unchanged, and legacy `OPENCODE_DB`/`XDG_STATE_HOME` ownership variables are ignored.

## Entry Points

- Server: `packages/server/src/index.ts`
- HTTP/proxy: `packages/server/src/server/http-server.ts`
- Workspace/location manager: `packages/server/src/workspaces/manager.ts`
- UI: `packages/ui/src/main.tsx`
- OpenCode UI client: `packages/ui/src/lib/sdk-manager.ts`
- Electron: `packages/electron-app/electron/main/main.ts`
- Tauri: `packages/tauri-app/src-tauri/src/main.rs`
