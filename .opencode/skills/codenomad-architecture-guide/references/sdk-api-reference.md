# Native OpenCode V2 Client Reference

## Package

CodeNomad server and UI pin `@opencode/client@2.0.11`. The runtime CLI is managed independently; startup validates authenticated loopback `/api/status`, then `/api/health`, then `/api/info`, advancing only on HTTP 404 with the same endpoint, credentials and deadline. Each response has its own validated schema and a 64 KiB bound. The shared transport maps canonical `server.info()` to the discovered route. Discovery does not prove compatibility for other APIs. Review official V2 docs, installed declarations, generated routes and native regression tests together when upgrading.

Cross-runtime adaptation lives in `packages/server/src/opencode/compatibility/`. The shared connection binds authenticated runtime identity, the canonical client and forwarding transport. Known published contracts select their serializer directly; unknown versions require authenticated bounded OpenAPI recognition before calls. Never add operation-specific retry fallbacks in UI stores or Yolo. See `dev-docs/OPENCODE_V2_COMPATIBILITY.md` for the evidence matrix and maintained issue register.

- Promise client: `import { OpenCode } from "@opencode/client"`
- Service authentication headers: `import { Service } from "@opencode/client/service"`
- Client construction: `OpenCode.make({ baseUrl, headers?, fetch? })`
- Declarations: `node_modules/@opencode/client/dist/promise/`

Do not replace the shared network service with `@opencode-ai/sdk` unless CodeNomad intentionally changes to an embedded, process-owned host.

## Used Native APIs

| Area | Calls | CodeNomad caller |
|---|---|---|
| Service | CLI `service status/start/get password`; authenticated `/api/status`, `/api/health`, `/api/info` in order, advancing only on 404; `Service.headers` for probes and API calls | `packages/server/src/workspaces/opencode-service.ts`, `packages/server/src/workspaces/opencode-cli-service.ts`, `packages/server/src/workspaces/host-opencode-service.ts`, `packages/server/src/workspaces/wsl-opencode-service.ts` |
| Location | `client.location.get`, `client.debug.location.evict` | shared service wrapper |
| Events | `client.event.subscribe()` | `packages/server/src/workspaces/instance-events.ts` |
| Sessions | `list/get/create/fork/remove/update/prompt/command/shell/interrupt` | UI session stores |
| Session environment | `client.session.environment({ sessionID, variables })` replaces a complete snapshot before prompt/command/shell admission | guarded server proxy; `workspaces/session-environment.ts` builds host/WSL values |
| Instructions | `client.session.instructions.entry.put/remove` | conversation-mode prompt setup |
| Permissions | `permission.request.list`, `permission.reply` | UI and server Yolo replier |
| Forms | `client.form.list`, `client.session.form.reply`, `client.session.form.cancel` | `packages/ui/src/stores/instances.ts`, `forms.ts` |

Native methods return decoded Promise values. Follow the installed declarations and existing callers; do not wrap calls in stale SDK response-unwrapping helpers.

Native Forms own pending interruption state. Global Forms use `sessionID: "global"` and `x-opencode-directory: encodeURIComponent(directory)`; ordinary session Forms derive location from the session. Question tool output rendering is independent of pending Forms.

Earlier V2 location identity must survive modern generated-client field selection. Use `locationRequestOptions` (server) / `requestLocationOptions` (UI) for the explicit private context channel; the proxy authorizes the complete pair, translates its directory, and the selected transport serializes the appropriate legacy slots. Modern public APIs still reject workspace selectors. Session move/rollback uses `moveSessionToLocation`, not a cast adding fields to the modern method input.

Stable mutations use `permission.reply({ decision })`, `session.command({ name })`, `session.interrupt({ resume })`, `session.fork({ before? })`, `session.inbox.update({ delivery })` and `session.message.get(...)`. Credential removal is global and takes only `credentialID`. There is no plugin activation-wait endpoint; catalog reads and `plugin.updated` supply native state.

Wait, instructions, import/export, stats and log use `/api/experimental/session/...` paths. Cancellation is `DELETE /api/session/:sessionID/form/:formID`. Preserve generated response envelopes in the proxy: `session.active` consumes `{ data }`, while `project.list` consumes an array. Native `cursor.next` remains the sole continuation authority.

## Routing

The UI client base is `/workspaces/:id/instance/`. Generated methods append native `/api/*` endpoints. `packages/ui/src/lib/sdk-manager.ts` caches clients by instance/proxy path and supplies a fetch adapter with cookies.

Location-sensitive list/create calls include `directory` or `location`. Session-specific calls rely on the session's native location, while the CodeNomad proxy verifies that location belongs to the selected workspace.

## CodeNomad-Owned APIs

Do not look for these in the OpenCode client:

- Workspace create/delete and worktree workflow routes (native OpenCode owns worktree discovery/create/remove; CodeNomad supplies directory/branch policy and verified session-family moves)
- Git status/diff/stage/unstage/commit
- Yolo toggle, persistence and auto-accept policy
- Authentication, storage, speech, sidecars and previews
- Multiplexed browser SSE at `/api/events`

These use `packages/ui/src/lib/api-client.ts` and server routes.

The instance proxy is method/path allowlisted. Adding an upstream client method does not make its route available through CodeNomad.
