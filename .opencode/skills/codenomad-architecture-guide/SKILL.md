---
name: codenomad-architecture-guide
description: |
  Architecture and native OpenCode V2 navigation guide for CodeNomad. Use for cross-package changes, OpenCode client calls, server routes, events, workspaces, Git, Yolo, UI, or desktop integration.
---

# CodeNomad Architecture Guide

## Start Here

- UI: read `references/ui-conventions.md`; use i18n for visible text.
- Server: read `references/server-conventions.md` and `references/feature-traces.md`.
- OpenCode: read the three `sdk-*.md` references before changing client calls or service lifecycle.
- Desktop: read `references/desktop-conventions.md`.
- Developer Mode: read `../../../dev-docs/DEVELOPER_MODE.md`.
- Browser automation: read `../../../dev-docs/BROWSER_AUTOMATION.md`.

## Native OpenCode V2 Baseline

- The only OpenCode client dependency is the experimental `@opencode-ai/client@beta` protocol. Server and UI follow that dependency together; refresh the client lock before API audits or release validation. The runtime CLI is managed independently and startup has no exact version gate. The public `@opencode-ai/sdk` describes an alternative embedded host.
- Do not use `@opencode-ai/sdk`, `@opencode-ai/sdk/v2/client`, or `createOpencodeClient()`; follow installed `@opencode-ai/client` declarations.
- There is no legacy `packages/opencode-plugin/`. Do not restore the V1 compatibility runtime or add general plugin extension points. The reviewed project-local adapter shared by Developer Mode and native browser previews is the sole narrow exception; see `dev-docs/DEVELOPER_MODE.md` and `dev-docs/BROWSER_AUTOMATION.md`.
- The server uses the selected host or WSL CLI's official `service status`, `service start`, and `service get password` lifecycle to connect to one externally owned global OpenCode daemon. It owns no private port/database/registration/PID and never stops the daemon on backend shutdown. WSL requires Windows localhost forwarding and uses no cross-namespace PID operations.
- The UI uses generated Promise clients from `OpenCode.make()` through the CodeNomad proxy.
- OpenCode owns session APIs, native Forms, session Shell (`client.session.shell`), session instructions (`client.session.instructions.entry`), location-scoped background Shells, and interactive PTYs. Question request/reply/reject routes are compatibility-only; new interruption flows use `client.form.*`. The Status panel lists `client.shell.*` records, refreshes on Shell events/reconnect, displays native metadata, and supports ownership-checked removal. Interactive `client.pty.*` terminals remain separate.
- CodeNomad owns explicit Stop Workspace eviction, directory authorization, Git status/diff/stage/unstage/commit, Yolo persistence/auto-replies, and `/api/events`. Tab/window close only detaches local UI and never evicts.
- OpenCode owns the global daemon's standard state and database. Allowed configured environment variables apply only to `service start` for a missing daemon; an existing daemon is unchanged, and `OPENCODE_DB`/`XDG_STATE_HOME` ownership settings are ignored.
- Native desktop identity is channel plus config profile: one singleton process/backend per profile and multiple UUID windows. A second launch opens another window by default; Advanced settings can restore MRU focus, while `--new-window` always requests another window. Stable/dev/non-default profiles isolate native state; OpenCode sessions/messages are shared while tabs/drafts/views are per-window.
- Client-state V3 is a per-window envelope over the V2 content-addressed partition graph with atomic publication/migration, ownership-fenced writes, and conservative post-commit GC. Electron and Windows Tauri browser previews use hardened native child webviews; iframe previews remain sandboxed without same-origin access and DOM comment inspection is web-only.

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
- Desktop hosts: `packages/electron-app/electron/main/`, `packages/electron-app/electron/preload/index.cjs`, `packages/tauri-app/src-tauri/src/`
- Developer Mode: `.opencode/plugins/codenomad-automation.ts`, `packages/server/src/opencode/automation-plugin.ts`, `packages/server/src/developer-cdp.ts`
- Automation bridge: `packages/server/src/opencode/automation-plugin.ts`, `packages/server/src/server/routes/automation-plugin.ts`
- Native browser previews: `packages/electron-app/electron/main/browser-controller.ts`, `packages/tauri-app/src-tauri/src/browser_controller.rs`, `packages/ui/src/lib/native/browser.ts`

## Rules

- Inspect installed declarations under `node_modules/@opencode-ai/client/dist/promise/`; generated names are the source of truth.
- Preserve `LocationRef` and explicit directory routing. Never infer workspace ownership from a client-provided path.
- Send CodeNomad operations through `/api/*`; send OpenCode operations through `/workspaces/:id/instance/api/*`.
- Consume the multiplexed CodeNomad SSE stream at `/api/events`; do not create one OpenCode process or event stream per workspace. Native events are volatile, so reconnect must reconcile authoritative state.
- Treat the instance proxy allowlist as an integration boundary. Upstream routes are not exposed automatically.
- Keep Git mutations and Yolo in CodeNomad. They are policy/security boundaries, not upstream client features.
- Check `packages/server/src/api-types.ts` and UI consumers together when changing CodeNomad events or responses.
- Desktop behavior must remain at strict Electron/Tauri parity in the same change; use the shared native abstraction and test both hosts.

## Anti-Patterns

| Avoid | Use |
|---|---|
| Public `@opencode-ai/sdk` examples | Installed experimental `@opencode-ai/client` declarations |
| One `opencode serve` per workspace | One externally owned global daemon through the official CLI lifecycle |
| Per-worktree clients/processes | Root proxy client plus native location/directory inputs |
| Reintroducing the V1 `packages/opencode-plugin` or general server plugin/background-process paths | Native OpenCode APIs; the reviewed project-local adapter only for Developer Mode feedback and browser previews |
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
