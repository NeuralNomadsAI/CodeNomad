# Server Conventions

## Fastify API

- Register CodeNomad control routes in `packages/server/src/server/routes/` under `/api/*`.
- Keep route dependencies explicit through `RouteDeps`.
- Define shared response/event types in `packages/server/src/api-types.ts` and check UI consumers.
- `/workspaces/:id/instance/*` is a guarded OpenCode proxy, not a CodeNomad control route.

## OpenCode Service

- Use `OpenCodeSharedService` in `packages/server/src/workspaces/opencode-service.ts`.
- Keep one CodeNomad-managed shared-service lifecycle and one event subscription for all workspaces. Production lifecycle is custom and process-proofed; do not replace it with direct `Service.ensure`/`Service.stop`.
- Model workspaces with native `LocationRef`/directories in `packages/server/src/workspaces/manager.ts`.
- Never spawn or stop OpenCode per workspace and never add plugin installation/packaging.
- Require user-supplied `OPENCODE_DB` for V2 startup, never share it with V1, and remember environment changes apply only at service start/restart.

## Trust Boundaries

- Validate every client-supplied directory before proxying.
- Verify session location ownership for session routes.
- Keep the OpenCode proxy method/path allowlist explicit; upstream functionality is not inherited automatically.
- Resolve worktree slugs server-side before filesystem or Git operations.
- Keep Git path traversal checks and commit validation in CodeNomad.
- Keep Yolo persistence and automatic permission replies server-side.

## Configuration

- Resolution: `packages/server/src/config/location.ts`
- Settings: `packages/server/src/settings/service.ts`
- Canonical files: `~/.config/codenomad/config.yaml` and `state.yaml`
- Legacy migration input only: `~/.config/codenomad/config.json`

## Current Paths

- Workspace/location manager: `packages/server/src/workspaces/manager.ts`
- Shared service: `packages/server/src/workspaces/opencode-service.ts`
- Launch adapter: `packages/server/src/workspaces/spawn.ts`
- OpenCode event bridge: `packages/server/src/workspaces/instance-events.ts`
- Instance proxy: `packages/server/src/server/http-server.ts`
- CodeNomad SSE: `packages/server/src/server/routes/events.ts`
- Git reads/mutations: `packages/server/src/workspaces/git-status.ts`, `git-mutations.ts`
- Yolo: `packages/server/src/permissions/`, `packages/server/src/server/routes/yolo.ts`

Deleted paths such as `packages/server/src/workspaces/runtime.ts`, `packages/server/src/background-processes/`, `packages/server/src/plugins/`, and `packages/opencode-plugin/` are not valid extension points.
