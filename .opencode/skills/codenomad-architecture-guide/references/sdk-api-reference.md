# Native OpenCode V2 Client Reference

## Package

CodeNomad pins `@opencode-ai/client@0.0.0-next-17353` exactly in both `packages/server/package.json` and `packages/ui/package.json`.

- Promise client: `import { OpenCode } from "@opencode-ai/client"`
- Service lifecycle: `import { Service } from "@opencode-ai/client/service"`
- Client construction: `OpenCode.make({ baseUrl, headers?, fetch? })`
- Declarations: `node_modules/@opencode-ai/client/dist/promise/`

Do not import `@opencode-ai/sdk`; its V1/V2 wrapper shapes, `{ data, error }` conventions, and `createOpencodeClient()` do not apply.

## Used Native APIs

| Area | Calls | CodeNomad caller |
|---|---|---|
| Service | `Service.discover/ensure/headers/stop` | `packages/server/src/workspaces/opencode-service.ts` |
| Location | `client.location.get`, `client.debug.location.evict` | shared service wrapper |
| Events | `client.event.subscribe()` | `packages/server/src/workspaces/instance-events.ts` |
| Sessions | `list/get/create/fork/remove/rename/prompt/command/shell/interrupt` | UI session stores |
| Instructions | `client.session.instructions.entry.put/remove` | conversation-mode prompt setup |
| Permissions | `permission.request.list`, `permission.reply` | UI and server Yolo replier |
| Questions | `question.request.list` and reply/reject APIs | UI interruption flow |

Native methods return decoded Promise values. Follow the installed declarations and existing callers; do not wrap calls in stale SDK response-unwrapping helpers.

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
