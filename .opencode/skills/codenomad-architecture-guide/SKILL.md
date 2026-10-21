---
name: codenomad-architecture-guide
description: |
  Architecture and native OpenCode V2 navigation guide for CodeNomad. Use for cross-package changes, OpenCode client calls, server routes, events, workspaces, Git, Yolo, UI, or desktop integration.
---

# CodeNomad Architecture Guide

## Start Here

- Area rules: before changing an area, read its document from the Area conventions index in `AGENTS.md`.
- UI: read `references/ui-conventions.md`; use i18n for visible text.
- Server: read `references/server-conventions.md` and `references/feature-traces.md`.
- OpenCode: read the three `sdk-*.md` references before changing client calls or service lifecycle.
- Desktop: read `references/desktop-conventions.md`.
- Desktop automation and browser previews: read `dev-docs/BROWSER_AUTOMATION.md`.

## Native OpenCode V2 Baseline

- Runtime requirements live in `opencode/runtime-support.ts`: OpenCode 2.1.2 is both the minimum and the recommendation, required by Code Mode's JavaScript job ordering (reproduced by `scripts/test-codemode-jobs-native.mjs`) and the `native`/`metadata.keepID` replay contract consumed by the pinned client reducer. Each blocking requirement needs demonstrated API/behavior evidence; distinguish technically incompatible, recommended/tested and unverified versions. Shared-daemon restart is explicit and uses the native-parent launch bridge. See `dev-docs/OPENCODE_COMPATIBILITY.md` for the version boundaries and `dev-docs/OPENCODE_RUNTIME_SETUP.md` for setup, installation and admission.

- Server and UI pin the official `@opencode/client@2.1.0` together; native plugins pin `@opencode/plugin@2.1.0` for authoring and use `packages/server/scripts/native-plugin-build.mjs` to keep Effect/public SDK modules external. The daemon supplies their runtime instances. The canonical server-info client is `server.info()`, adapted to the authenticated discovered route. Review official V2 docs, installed declarations, generated wire paths and native integration tests when upgrading. Never infer a minimum from the latest publication or dependency pin alone. Update `dev-docs/OPENCODE_COMPATIBILITY.md` in place and retain detailed evidence in PR/CI logs. The runtime CLI is managed independently.
- Do not use `@opencode-ai/sdk`, `@opencode-ai/sdk/v2/client`, or `createOpencodeClient()`; follow installed `@opencode/client` declarations.
- Never add general plugin extension points. The narrow native integrations are the bundled `codenomad.automation` plugin, project-local native session coordination (`codenomad.missions`) and the bundled session-pruning RPC; see `dev-docs/BROWSER_AUTOMATION.md`, `dev-docs/MISSIONS.md` and `dev-docs/SESSION_PRUNING_RPC.md`. All automation tools follow backend presence, sharing the authenticated native transport and execution-time session/window fences.
- The server uses the selected host or WSL CLI's official `service status`, `service start`, and `service get password` lifecycle to connect to one externally owned global OpenCode daemon. It owns no private port/database/registration/PID and never stops the daemon on backend shutdown. WSL requires Windows localhost forwarding and uses no cross-namespace PID operations.
- The UI uses generated Promise clients from `OpenCode.make()` through the CodeNomad proxy.
- OpenCode owns session APIs, native Forms, session Shell (`client.session.shell`), session instructions (`client.session.instructions.entry`), location-scoped background Shells, and interactive PTYs. Forms list through `client.form.list({ location })` and settle through `client.session.form.reply/cancel`; global Forms use the encoded directory header. The Status panel lists `client.shell.*` records, refreshes on Shell events/reconnect, displays native metadata, and supports ownership-checked removal. Interactive `client.pty.*` terminals remain separate.
- CodeNomad owns logical project records, directory authorization, Git status/diff/stage/unstage/commit, Yolo persistence/auto-replies, and `/api/events`. Closing a project tab deletes that occurrence's backend record; native sessions continue. CodeNomad never evicts native Locations. Whole-window close, quit and reload preserve restoration behavior.
- OpenCode owns the global daemon's standard state and database. Configured environment variables are passed to `service start` for a missing daemon; an existing daemon is unchanged. Before each session prompt/command/shell send, the authorized proxy also applies the profile's complete execution-host environment via `session.environment`. `OPENCODE_DB`/`XDG_STATE_HOME` ownership settings are ignored. See `dev-docs/SESSION_ENVIRONMENT.md` for scope and limitations.
- Native desktop identity is data profile plus config identity (`dev-docs/DESKTOP_DATA_PROFILES.md`): one singleton process/backend per scope and multiple UUID windows. A second launch opens another window by default; Advanced settings can restore MRU focus, while `--new-window` always requests another window. Each scope isolates native state; OpenCode sessions/messages are shared while tabs/drafts/views are per-window.
- Client-state V3 is a per-window envelope over the V2 content-addressed partition graph with atomic publication/migration, ownership-fenced writes, and conservative post-commit GC. Iframe preview fallbacks are sandboxed without same-origin access; native browser guests share one preview profile kept separate from the application renderer and get no application capabilities (frame policy in `dev-docs/architecture.md`).

## Package Map

External right-panel UI addons use `packages/server/src/panel-extensions/` and
`packages/ui/src/components/panel-extensions/`; see `dev-docs/PANEL_EXTENSIONS.md`.
They are sandboxed UI packages with their own consent and loading path. Never import
author code into the primary renderer, expose generic RPC or grant native commands.

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
- Desktop automation: `packages/server/src/opencode/automation-plugin.ts`, `packages/server/src/opencode/automation/desktop-plugin.ts`, `packages/server/src/server/routes/automation-plugin.ts`, `packages/server/src/developer-cdp.ts`, `packages/server/src/automation/page/`

## Rules

- Inspect installed declarations under `node_modules/@opencode/client/dist/promise/`; generated names are the source of truth.
- Public locations are directory-only `LocationPublicRef`; `location.get().project` owns project metadata. Never send the internal/event `LocationRef.workspaceID` as a request selector. Validate directory ownership at the server boundary.
- Send CodeNomad operations through `/api/*`; send OpenCode operations through `/workspaces/:id/instance/api/*`.
- Consume the multiplexed CodeNomad SSE stream at `/api/events`; do not create one OpenCode process or event stream per workspace. Native events are volatile, so reconnect must reconcile authoritative state.
- Treat the instance proxy allowlist as an integration boundary. Upstream routes are exposed only after review.
- Keep Git mutations and Yolo in CodeNomad: they are its policy/security boundaries.
- Check `packages/server/src/api-types.ts` and UI consumers together when changing CodeNomad events or responses.
- Desktop behavior must remain at strict Electron/Tauri parity in the same change; use the shared native abstraction and test both hosts.

## Anti-Patterns

| Avoid | Use |
|---|---|
| `@opencode-ai/sdk` or other published-example clients | Installed `@opencode/client` declarations and generated routes |
| One `opencode serve` per workspace | One externally owned global daemon through the official CLI lifecycle |
| Per-worktree clients/processes | Root proxy client plus native location/directory inputs |
| General server plugin or background-process extension points | Native OpenCode APIs; narrow reviewed automation/browser-preview, Missions and session-pruning integrations |
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
