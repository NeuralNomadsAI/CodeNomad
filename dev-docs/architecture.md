# CodeNomad Architecture

## Overview

CodeNomad is a SolidJS UI and Fastify server hosted by Electron or Tauri. The official `@opencode/client` dependency pins live in the [server](../packages/server/package.json) and [UI](../packages/ui/package.json) manifests; the runtime CLI is independently managed.

```text
Desktop host -> CodeNomad server -> one shared OpenCode service
                    ^    |
                    |    +-> CodeNomad /api/* and /api/events
                    +------ UI clients through /workspaces/:id/instance/api/*
```

CodeNomad's bundled native plugins (automation, see [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md); session pruning; Missions) load through native V2 discovery; none owns the daemon.

## Shared Service And Locations

`packages/server/src/workspaces/opencode-service.ts` runs the selected host or WSL CLI's official `service status`, `service start`, and `service get password` lifecycle, validates the authenticated loopback endpoint, and pins that identity while active. It connects to one externally owned global daemon and never stops it on backend shutdown. An acquisition more than 30 seconds after the last check repeats discovery: a different discovered daemon (URL, PID, version or credentials) replaces the connection, while a discovery that fails or finds no service keeps it until the next interval. Failed location validation, proxy transport or authentication failures and upstream event-stream EOF/errors retire the connection.

OpenCode owns the daemon's standard state and database. Configured allowed environment variables and `NODE_EXTRA_CA_CERTS` apply only if CodeNomad starts a missing daemon; a running daemon keeps its environment. `OPENCODE_DB` and `XDG_STATE_HOME` never reach the daemon or session environments (`workspaces/host-opencode-service.ts`, `workspaces/session-environment.ts`). WSL support requires Windows localhost forwarding and executes the Linux CLI lifecycle inside the selected distribution without cross-namespace PID operations.

`packages/server/src/workspaces/manager.ts` treats selected folders as native OpenCode locations:

1. Validate the directory with `client.location.get`.
2. Store the returned `LocationRef` and publish the logical workspace.
3. Reuse the shared service for every additional directory.
4. Closing a project tab deletes that occurrence's logical workspace record (`DELETE /api/workspaces/:id`; see [PROJECTS.md](PROJECTS.md)).

## Native Profiles, Windows, And Client State

Electron and Tauri run one native singleton process and one CodeNomad backend per data profile/config pair ([DESKTOP_DATA_PROFILES.md](DESKTOP_DATA_PROFILES.md)), isolating singleton identity, backend/browser storage and client state. A second launch opens another UUID-backed window by default; Advanced settings can restore most-recent-window focus, while `--new-window` always creates another window.

OpenCode sessions and messages are shared through the global daemon. Window membership, tabs, drafts, view state, and native bounds are local to each UUID window. Client-state V3 is a per-window envelope over the V2 SHA-256 content-addressed partition graph: immutable partitions are prepared before atomic root publication, writes and migrations are fenced by current ownership and renderer authority, and garbage collection runs after publication while retaining every partition referenced by any window.

Previews use unguessable capabilities for HTTP and WebSocket traffic. Electron and Windows Tauri local windows open HTTP(S) pages in hardened native child webviews sharing one preview profile kept separate from the app; other clients use the capability-scoped iframe proxy. Browser preview iframes are opaque-origin sandboxes without `allow-same-origin`; preview element comments use a source-checked message bridge instead of parent DOM access. SideCar iframes add `allow-same-origin` by design: a SideCar is a trusted extension of CodeNomad, and its scripts run with the application's origin and access. `/sidecars/*` authenticates with the `SameSite=Lax` session cookie and rejects `Origin: null`, which an opaque frame cannot satisfy.

## API Boundaries

CodeNomad control APIs live under `/api/*`. Important routes include:

- `/api/workspaces` and `/api/workspaces/:id/worktrees/*`
- `/api/workspaces/:id/worktrees/:slug/git-status|git-diff|git-stage|git-unstage|git-commit`
- `/api/events` and `/api/client-connections/pong`
- `/api/storage`, `/api/settings`, `/api/filesystem`, `/api/speech`
- `/api/opencode-plugin/automation`, authenticated by a per-process loopback token and restricted to CodeNomad-owned locations
- `/api/remote-control/*`, managed from the host only; `POST /api/remote-control/pair` and `/remote-pair` answer only through Remote Control ([REMOTE_CONTROL.md](REMOTE_CONTROL.md))

Authentication and Remote Control admission judge `routedPath()` (`server/routed-path.ts`), the path Fastify's router matches (`/%61pi/x` routes as `/api/x`), and refuse targets it would reinterpret. Never base an access decision on the raw request target.

Native OpenCode requests use `/workspaces/:id/instance/api/*`. The Fastify proxy exposes an explicit method/path allowlist, adds shared-service authorization, validates prompt files, defaults safe requests to the workspace location, and rejects locations/directories outside the selected workspace or its worktrees. Session routes also verify `session.location.directory`. Never trust a browser-supplied worktree path: resolve ownership server-side. Upstream additions are exposed only after an explicit proxy review.

Yolo state endpoints live at `/workspaces/:id/yolo/sessions/:sessionId`; Yolo notifications use `/api/events`.

## Client And Events

`packages/ui/src/lib/sdk-manager.ts` uses `OpenCode.make()` and caches generated Promise clients by instance proxy path. `packages/ui/src/stores/opencode-client.ts` is the root-client authority; native directory/location fields select the worktree.

The server holds one `client.event.subscribe()` stream. `InstanceEventBridge` maps native location events to CodeNomad `instance.event` records, and `/api/events` multiplexes them with workspace and Yolo events for the browser; heartbeats use `POST /api/client-connections/pong`. The stream is volatile and has no replay guarantee: reconnect must reconcile sessions and pending requests and reread authoritative file/config state. Pending recovery uses the loaded-only broker, never worktree-wide ordinary lists; see [compatibility](OPENCODE_COMPATIBILITY.md), whose Agent conventions also specify relay ordering and ownership fences.

Native events include session lifecycle/output events (`session.created`, `session.renamed`, `session.moved`, `session.execution.*`, `session.retry.scheduled`, `session.step.*`, `session.compaction.*`, `session.text.*`, `session.reasoning.*`, `session.tool.*`), background Shell refresh via `shell.created`, `shell.exited`, `shell.deleted`, file invalidation via `filesystem.changed`, and configuration invalidation via `config.updated`. Each busy period settles with exactly one `session.execution.succeeded`/`failed`/`interrupted`; derive session activity from these events, never from the declared but unpublished `session.status`/`session.idle`.

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
| Desktop inspection, CDP feedback and browser previews | CodeNomad desktop host/browser controllers and the bundled automation plugin |
| Remote Control transport, pairing and admission | OpenTunnel SDK route plus `packages/server/src/remote-control/` ([REMOTE_CONTROL.md](REMOTE_CONTROL.md)) |

Session Shell and conversation instructions are native features. Session Shell is separate from background Shell and PTY management. The Status panel lists location-scoped native background Shells, refreshes on Shell events/reconnect, displays native metadata, and allows removal. The proxy verifies Shell `cwd` ownership before ID-scoped operations and preserves native output cursor pagination.

## Persistence

CodeNomad configuration resolves through `packages/server/src/config/location.ts`: `config.yaml`, `state.yaml`, `remote-control-devices.json`, and `instances/` under `~/.config/codenomad/`. `config.json` is read only as migration input.

## Implementation Map

Server entrypoints are `packages/server/src/index.ts` and `server/http-server.ts`; shared-service authority lives in `workspaces/opencode-service.ts` and `workspaces/manager.ts`, event routing in `workspaces/instance-events.ts`, and bundled automation provisioning in `opencode/automation-plugin.ts`. UI native calls use `stores/opencode-client.ts`, `session-api.ts` and `session-actions.ts`; CodeNomad routes use `lib/api-client.ts`. Current integration conventions are in [AGENTS.md](../AGENTS.md) and the area documents it indexes.

## Agent conventions

- SideCar proxy cookies use `sidecars/proxy-cookies.ts`: authenticate locally first, then remove the actual auth cookie, the `codenomad_session` desktop namespace and paired-device cookie upstream; filter the same names from HTTP and WebSocket response cookies, preserving service cookies. Handshakes go through Node's bounded HTTP parser in `server/proxy-websocket.ts`, including non-101 responses and coalesced binary data. Same-origin SideCar scripts keep full application access: SideCars are trusted extensions by design.
