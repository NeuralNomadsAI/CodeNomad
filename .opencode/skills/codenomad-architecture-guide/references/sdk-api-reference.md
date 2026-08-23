# Native OpenCode V2 Client Reference

## Package

CodeNomad keeps the experimental `@opencode-ai/client` protocol aligned on the latest published beta channel in `packages/server/package.json` and `packages/ui/package.json`. The runtime CLI is independently updated and startup validates service health and API compatibility. This is distinct from the current public `@opencode-ai/sdk` documentation.

- Promise client: `import { OpenCode } from "@opencode-ai/client"`
- Service authentication headers: `import { Service } from "@opencode-ai/client/service"`
- Client construction: `OpenCode.make({ baseUrl, headers?, fetch? })`
- Declarations: `node_modules/@opencode-ai/client/dist/promise/`

Do not import `@opencode-ai/sdk`; its wrapper shapes, `{ data, error }` conventions, and `createOpencodeClient()` do not apply to the experimental beta protocol.

## Used Native APIs

| Area | Calls | CodeNomad caller |
|---|---|---|
| Service | CLI `service status/start/get password`; `Service.headers` for authenticated health/API calls | `packages/server/src/workspaces/opencode-service.ts`, `packages/server/src/workspaces/opencode-cli-service.ts`, `packages/server/src/workspaces/host-opencode-service.ts`, `packages/server/src/workspaces/wsl-opencode-service.ts` |
| Location | `client.location.get`, `client.debug.location.evict` | shared service wrapper |
| Events | `client.event.subscribe()` | `packages/server/src/workspaces/instance-events.ts` |
| Sessions | `list/get/create/fork/remove/rename/prompt/command/shell/interrupt` | UI session stores |
| Instructions | `client.session.instructions.entry.put/remove` | conversation-mode prompt setup |
| Permissions | `permission.request.list`, `permission.reply` | UI and server Yolo replier |
| Forms | `client.form.request.list`, `client.form.reply`, `client.form.cancel` | `packages/ui/src/stores/instances.ts`, `forms.ts` |

Native methods return decoded Promise values. Follow the installed declarations and existing callers; do not wrap calls in stale SDK response-unwrapping helpers.

Native Forms own pending interruption state. The allowlisted Question request/reply/reject routes are compatibility-only. The Question tool renderer may display compatible output, but no Question queue/state architecture should return.

## Routing

The UI client base is `/workspaces/:id/instance/`. Generated methods append native `/api/*` endpoints. `packages/ui/src/lib/sdk-manager.ts` caches clients by instance/proxy path and supplies a fetch adapter with cookies.

Location-sensitive list/create calls include `directory` or `location`. Session-specific calls rely on the session's native location, while the CodeNomad proxy verifies that location belongs to the selected workspace.

## CodeNomad-Owned APIs

Do not look for these in the OpenCode client:

- Workspace create/delete and worktree management
- Git status/diff/stage/unstage/commit
- Yolo toggle, persistence and auto-accept policy
- Authentication, storage, speech, sidecars and previews
- Multiplexed browser SSE at `/api/events`

These use `packages/ui/src/lib/api-client.ts` and server routes.

The instance proxy is method/path allowlisted. Adding an upstream client method does not make its route available through CodeNomad.
