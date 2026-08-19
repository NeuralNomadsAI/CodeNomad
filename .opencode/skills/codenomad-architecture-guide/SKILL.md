---
name: codenomad-architecture-guide
description: |
  Architecture and native OpenCode V2 navigation guide for CodeNomad. Use for cross-package changes, OpenCode client calls, server routes, events, workspaces, Git, Yolo, UI, or desktop integration. Permission is required before loading.
---

# CodeNomad Architecture Guide

## Start Here

- UI: read `references/ui-conventions.md`; use i18n for visible text.
- Server: read `references/server-conventions.md` and `references/feature-traces.md`.
- OpenCode: read the three `sdk-*.md` references before changing client calls or service lifecycle.
- Desktop: read `references/desktop-conventions.md`.

## Native OpenCode V2 Baseline

- The only OpenCode client dependency is the experimental `@opencode-ai/client` protocol. Server, UI, and the selected runtime CLI must stay on the exact version pinned by the server package. Current public `@opencode-ai/sdk` docs describe a different contract.
- Do not use `@opencode-ai/sdk`, `@opencode-ai/sdk/v2/client`, or `createOpencodeClient()`; follow installed `@opencode-ai/client` declarations.
- There is no `packages/opencode-plugin/`. Do not restore plugin tools, plugin routes, or plugin packaging.
- The server owns one shared OpenCode service through `OpenCodeSharedService` and its lease-locked discovery, launcher, process-proof, and authenticated-stop lifecycle. Proven host shutdown delegates to native `Service.stop`; WSL uses native authenticated health stop to avoid the client's cross-namespace PID fallback. Workspaces are native OpenCode `Location`/directory scopes, not separate OpenCode processes.
- The UI uses generated Promise clients from `OpenCode.make()` through the CodeNomad proxy.
- OpenCode owns session APIs, native Shell (`client.session.shell`), session instructions (`client.session.instructions.entry`), and location-scoped native PTYs. Shell remains separate. The Status panel lists PTYs, refreshes on PTY events/reconnect, displays native metadata, and supports title updates and ownership-checked removal. Current installed declarations have no PTY output/read/stream or separate stop API, so output and distinct stop are unavailable; removal is the native stop action for a running PTY.
- CodeNomad owns workspace lifecycle, directory authorization, Git status/diff/stage/unstage/commit, Yolo persistence/auto-replies, and `/api/events`.
- V2 service startup forces `OPENCODE_DB` to `~/.local/share/opencode2/opencode.db`; never share the V1 database with V2.

## Package Map

- `packages/server/`: Fastify control API, shared OpenCode service, locations, auth, filesystem, Git, Yolo, speech.
- `packages/ui/`: SolidJS application, generated client adapters, stores, components, i18n.
- `packages/electron-app/`: Electron host.
- `packages/tauri-app/`: Tauri host.
- `packages/cloudflare/`: edge deployment.

## Integration Paths

- Shared service: `packages/server/src/workspaces/opencode-service.ts`
- Location ownership: `packages/server/src/workspaces/manager.ts`
- OpenCode proxy: `packages/server/src/server/http-server.ts`
- CodeNomad API client/events: `packages/ui/src/lib/api-client.ts`
- OpenCode client cache: `packages/ui/src/lib/sdk-manager.ts`
- Root client authority: `packages/ui/src/stores/opencode-client.ts`
- Native session calls: `packages/ui/src/stores/session-api.ts`, `session-actions.ts`
- Git mutations: `packages/server/src/workspaces/git-mutations.ts`
- Yolo: `packages/server/src/permissions/`, `packages/server/src/server/routes/yolo.ts`

## Rules

- Inspect installed declarations under `node_modules/@opencode-ai/client/dist/promise/`; generated names are the source of truth.
- Preserve `LocationRef` and explicit directory routing. Never infer workspace ownership from a client-provided path.
- Send CodeNomad operations through `/api/*`; send OpenCode operations through `/workspaces/:id/instance/api/*`.
- Consume the multiplexed CodeNomad SSE stream at `/api/events`; do not create one OpenCode process or event stream per workspace. Native events are volatile, so reconnect must reconcile authoritative state.
- Treat the instance proxy allowlist as an integration boundary. Upstream routes are not exposed automatically.
- Keep Git mutations and Yolo in CodeNomad. They are policy/security boundaries, not upstream client features.
- Check `packages/server/src/api-types.ts` and UI consumers together when changing CodeNomad events or responses.

## Anti-Patterns

| Avoid | Use |
|---|---|
| Public `@opencode-ai/sdk` examples | Installed experimental `@opencode-ai/client` declarations |
| One `opencode serve` per workspace | One CodeNomad-managed shared service |
| Per-worktree clients/processes | Root proxy client plus native location/directory inputs |
| Reintroducing `packages/opencode-plugin` or server plugin/background-process paths | Separate native Shell/instructions and native PTY management |
| OpenCode APIs for stage/commit/Yolo policy | CodeNomad routes and managers |
| Hardcoded UI strings | `t()` / `tGlobal()` and every locale |

## References

- `references/architecture-overview.md`
- `references/server-conventions.md`
- `references/sdk-api-reference.md`
- `references/sdk-integration-patterns.md`
- `references/sdk-critical-behaviors.md`
- `references/feature-traces.md`
- `references/ui-conventions.md`
- `references/desktop-conventions.md`
