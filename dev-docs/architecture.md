# CodeNomad Architecture

## Overview

CodeNomad is a SolidJS UI and Fastify server hosted by Electron or Tauri. It integrates directly with native OpenCode V2 through exact dependency `@opencode-ai/client@0.0.0-next-17353`.

```text
Desktop host -> CodeNomad server -> one shared OpenCode service
                    ^    |
                    |    +-> CodeNomad /api/* and /api/events
                    +------ UI clients through /workspaces/:id/instance/api/*
```

There is no `@opencode-ai/sdk` integration and no `packages/opencode-plugin` package.

## Shared Service And Locations

`packages/server/src/workspaces/opencode-service.ts` wraps native `Service.discover`, `Service.ensure`, `Service.headers` and `Service.stop`. The first workspace ensures one `opencode serve --service`; all workspaces share that endpoint, client and event stream.

`packages/server/src/workspaces/manager.ts` treats selected folders as native OpenCode locations:

1. Validate the directory with `client.location.get`.
2. Store the returned `LocationRef` and publish the logical workspace.
3. Reuse the shared service for every additional directory.
4. Evict a location only after its final CodeNomad owner is deleted.
5. Stop the shared service at CodeNomad shutdown only if CodeNomad started it.

Workspaces are not OpenCode processes and do not own ports or PIDs.

## API Boundaries

CodeNomad control APIs live under `/api/*`. Important routes include:

- `/api/workspaces` and `/api/workspaces/:id/worktrees/*`
- `/api/workspaces/:id/worktrees/:slug/git-status|git-diff|git-stage|git-unstage|git-commit`
- `/api/events` and `/api/client-connections/pong`
- `/api/storage`, `/api/settings`, `/api/filesystem`, `/api/speech`

Native OpenCode requests use `/workspaces/:id/instance/api/*`. The Fastify proxy adds shared-service authorization and rejects locations/directories outside the selected workspace or its worktrees. Session routes also verify `session.location.directory`.

Yolo state endpoints currently live at `/workspaces/:id/yolo/sessions/:sessionId`; Yolo notifications use `/api/events`.

## Client And Events

`packages/ui/src/lib/sdk-manager.ts` uses `OpenCode.make()` and caches generated Promise clients by instance proxy path. `packages/ui/src/stores/opencode-client.ts` is the root-client authority; native directory/location fields replace old per-worktree SDK clients.

The server holds one `client.event.subscribe()` stream. `InstanceEventBridge` maps native location events to CodeNomad `instance.event` records, and `/api/events` multiplexes them with workspace and Yolo events for the browser.

## Feature Ownership

| Feature | Owner |
|---|---|
| Sessions, messages, permission/question APIs | OpenCode V2 |
| Shell mode | `client.session.shell` |
| Conversation instructions | `client.session.instructions.entry` |
| Workspace lifecycle and directory authorization | CodeNomad |
| Git status/diff/stage/unstage/commit | CodeNomad server |
| Yolo state, persistence and auto-accept | CodeNomad server |
| Browser SSE multiplexing | CodeNomad server |

Native Shell and session instructions replace the deleted plugin-backed integrations. Do not restore plugin background-process, voice-mode, channel or packaging paths.

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
- `packages/ui/src/lib/sdk-manager.ts`
- `packages/ui/src/lib/api-client.ts`
- `packages/ui/src/stores/session-api.ts`
- `packages/ui/src/stores/session-actions.ts`
