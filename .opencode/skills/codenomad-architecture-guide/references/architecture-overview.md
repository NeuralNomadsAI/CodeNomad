# Architecture Overview

## Runtime Shape

```text
Electron/Tauri -> CodeNomad Fastify server -> one shared OpenCode service
                       |                         |
                       | /api/*                  | Location-scoped /api/*
                       v                         v
                  SolidJS UI <- /api/events <- event bridge
```

The server calls `Service.ensure` once through `packages/server/src/workspaces/opencode-service.ts`. `WorkspaceManager` validates each selected directory with `client.location.get()` and stores its `LocationRef`; a workspace is a logical location owner, not an OpenCode child process.

## Boundaries

| Owner | Responsibilities | Main paths |
|---|---|---|
| OpenCode V2 | Sessions, messages, permissions/questions, files, native Shell and instructions | `@opencode-ai/client@0.0.0-next-17288` |
| CodeNomad server | Shared service lifecycle, locations, proxy authorization, Git mutations, Yolo, auth, storage, speech, SSE multiplexing | `packages/server/src/` |
| CodeNomad UI | Generated Promise clients, state reconciliation, interaction and rendering | `packages/ui/src/` |
| Desktop hosts | Start CodeNomad and provide native OS integration | `packages/electron-app/`, `packages/tauri-app/` |

`packages/opencode-plugin/` and the server plugin/background-process integration were deleted. Do not use those paths as extension points.

## HTTP And Events

- CodeNomad control endpoints live under `/api/*`, including `/api/workspaces`, Git routes and `/api/events`.
- OpenCode requests use `/workspaces/:id/instance/api/*`. The proxy injects service auth, validates supplied `location`/`directory` values, checks session ownership, and defaults safe requests to the workspace directory.
- Yolo state endpoints currently use `/workspaces/:id/yolo/sessions/:sessionId`; state changes and auto-accept confirmations travel over `/api/events`.
- `InstanceEventBridge` subscribes once to the shared OpenCode event stream and publishes typed `instance.event` records on CodeNomad's event bus.

## Persistence

`packages/server/src/config/location.ts` resolves CodeNomad data under `~/.config/codenomad/`: canonical `config.yaml`, `state.yaml`, and `instances/`, with `config.json` retained only as migration input.

OpenCode location/workspace identity is upstream state. CodeNomad persists only its own preferences and policy metadata, including Yolo state.

## Entry Points

- Server: `packages/server/src/index.ts`
- HTTP/proxy: `packages/server/src/server/http-server.ts`
- Workspace/location manager: `packages/server/src/workspaces/manager.ts`
- UI: `packages/ui/src/main.tsx`
- OpenCode UI client: `packages/ui/src/lib/sdk-manager.ts`
- Electron: `packages/electron-app/electron/main/main.ts`
- Tauri: `packages/tauri-app/src-tauri/src/main.rs`
