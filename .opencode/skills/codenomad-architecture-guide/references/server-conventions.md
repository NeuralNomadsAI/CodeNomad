# Server Conventions

## Fastify API

- Register CodeNomad control routes in `packages/server/src/server/routes/` under `/api/*`.
- Keep route dependencies explicit through `RouteDeps`.
- Define shared response/event types in `packages/server/src/api-types.ts` and check UI consumers.
- `/workspaces/:id/instance/*` is the guarded OpenCode proxy; never register CodeNomad control routes under it.

## OpenCode Service

- Use `OpenCodeSharedService` in `packages/server/src/workspaces/opencode-service.ts`.
- Keep one shared-service adapter and one event subscription for all workspaces. Use the selected host or WSL CLI's official status/start/password lifecycle, own no private service state/PID, and never stop the externally owned global daemon on backend shutdown.
- Model workspaces with native `LocationRef`/directories in `packages/server/src/workspaces/manager.ts`.
- Never spawn or stop OpenCode per workspace or add general plugin installation/packaging. The narrow integrations are the bundled `codenomad.automation` plugin, `codenomad.missions` and the bundled session-pruning RPC under `src/opencode/session-pruning/`. Bundled definitions follow backend presence through native V2 discovery; execution still validates the invoking session's current location. Tool availability never depends on the source checkout.
- Closing a project tab deletes only its logical backend workspace record, never its native Location; sessions continue in OpenCode. Whole-window close, quit and reload keep records for restoration. WSL requires localhost forwarding and no cross-namespace PID operations.
- Leave global service state/database ownership to OpenCode. Pass startup environment when starting a missing daemon; leave an existing daemon unchanged and ignore `OPENCODE_DB`/`XDG_STATE_HOME`. Apply the profile's complete execution-host environment via `session.environment` before each authorized session prompt/command/shell send; see `dev-docs/SESSION_ENVIRONMENT.md`.

## Trust Boundaries

- Validate every client-supplied directory before proxying.
- Verify session location ownership for session routes.
- Keep the OpenCode proxy method/path allowlist explicit; add upstream routes only after review.
- Resolve worktree slugs server-side before filesystem or Git operations.
- Keep Git path traversal checks and commit validation in CodeNomad.
- Keep Yolo persistence and automatic permission replies server-side.

## Configuration

- Resolution: `packages/server/src/config/location.ts`
- Settings: `packages/server/src/settings/service.ts`
- Canonical files: `~/.config/codenomad/config.yaml` and `state.yaml`
- Migration input only: `~/.config/codenomad/config.json`

## Current Paths

- Workspace/location manager: `packages/server/src/workspaces/manager.ts`
- Shared service: `packages/server/src/workspaces/opencode-service.ts`
- CLI lifecycle: `packages/server/src/workspaces/opencode-cli-service.ts`
- Host lifecycle: `packages/server/src/workspaces/host-opencode-service.ts`
- WSL lifecycle: `packages/server/src/workspaces/wsl-opencode-service.ts`
- Spawn/path helpers: `packages/server/src/workspaces/spawn.ts`
- OpenCode event bridge: `packages/server/src/workspaces/instance-events.ts`
- Instance proxy: `packages/server/src/server/http-server.ts`
- CodeNomad SSE: `packages/server/src/server/routes/events.ts`
- Git reads/mutations: `packages/server/src/workspaces/git-status.ts`, `git-mutations.ts`
- Yolo: `packages/server/src/permissions/`, `packages/server/src/server/routes/yolo.ts`
- Desktop automation: `packages/server/src/opencode/automation-plugin.ts`, `packages/server/src/opencode/automation/desktop-plugin.ts`, `packages/server/src/server/routes/automation-plugin.ts`, `packages/server/src/developer-cdp.ts`, `packages/server/src/automation/page/`
