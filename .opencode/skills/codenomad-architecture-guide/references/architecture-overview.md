# Architecture Overview

## Runtime Shape

```text
Electron/Tauri -> CodeNomad Fastify server -> one shared OpenCode service
                       |                         |
                       | /api/*                  | Location-scoped /api/*
                       v                         v
                  SolidJS UI <- /api/events <- event bridge
```

The server uses `packages/server/src/workspaces/opencode-service.ts` for a custom lease-locked discovery, launcher, process-proof, and authenticated-stop lifecycle; production does not call `Service.ensure` or `Service.stop` directly. Transferable lease proof binds the registration and endpoint credentials to the daemon PID/process-start identity, host or WSL namespace, and launch signature. `WorkspaceManager` validates each selected directory with `client.location.get()` and stores its `LocationRef`; a workspace is a logical location owner, not an OpenCode child process.

## Boundaries

| Owner | Responsibilities | Main paths |
|---|---|---|
| OpenCode V2 | Sessions, messages, permissions/questions, files, native Shell and instructions | experimental `@opencode-ai/client@0.0.0-next-17353` protocol |
| CodeNomad server | Shared service lifecycle, locations, proxy authorization, Git mutations, Yolo, auth, storage, speech, SSE multiplexing | `packages/server/src/` |
| CodeNomad UI | Generated Promise clients, state reconciliation, interaction and rendering | `packages/ui/src/` |
| Desktop hosts | Start CodeNomad and provide native OS integration | `packages/electron-app/`, `packages/tauri-app/` |

`packages/opencode-plugin/` and the server plugin/background-process integration were deleted. Native Shell is integrated; PTY/background-process parity is not. Do not use deleted paths as extension points.

## HTTP And Events

- CodeNomad control endpoints live under `/api/*`, including `/api/workspaces`, Git routes and `/api/events`.
- OpenCode requests use `/workspaces/:id/instance/api/*`. The explicit method/path allowlist injects service auth, validates supplied paths and `location`/`directory` values, checks session ownership, and defaults safe requests to the workspace directory. New upstream routes require review and are not exposed automatically.
- Yolo state endpoints currently use `/workspaces/:id/yolo/sessions/:sessionId`; state changes and auto-accept confirmations travel over `/api/events`.
- `InstanceEventBridge` subscribes once to the volatile shared OpenCode event stream and publishes typed `instance.event` records on CodeNomad's event bus. Reconnect must refetch authoritative state because missed events are not replayed reliably.

## Persistence

`packages/server/src/config/location.ts` resolves CodeNomad data under `~/.config/codenomad/`: canonical `config.yaml`, `state.yaml`, and `instances/`, with `config.json` retained only as migration input.

OpenCode location/workspace identity is upstream state. CodeNomad persists only its own preferences and policy metadata, including Yolo state.

OpenCode V2 additionally requires a user-supplied `OPENCODE_DB`. CodeNomad supplies no path; V1 and V2 databases must remain separate, and environment changes apply when the shared service starts/restarts.

## Entry Points

- Server: `packages/server/src/index.ts`
- HTTP/proxy: `packages/server/src/server/http-server.ts`
- Workspace/location manager: `packages/server/src/workspaces/manager.ts`
- UI: `packages/ui/src/main.tsx`
- OpenCode UI client: `packages/ui/src/lib/sdk-manager.ts`
- Electron: `packages/electron-app/electron/main/main.ts`
- Tauri: `packages/tauri-app/src-tauri/src/main.rs`
