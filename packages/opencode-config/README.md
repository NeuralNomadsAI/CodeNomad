# opencode-config

## TLDR
Template config + plugins injected into every OpenCode instance that CodeNomad launches. It provides a CodeNomad bridge plugin for local event exchange between the CLI server and opencode.

## What it is
A packaged config directory that CodeNomad copies into `~/.config/codenomad/opencode-config` for production builds or uses directly in dev. OpenCode autoloads any `plugin/*.ts` or `plugin/*.js` from this directory.

## How it works
- CodeNomad sets `OPENCODE_CONFIG_DIR` when spawning each opencode instance (`packages/server/src/workspaces/manager.ts`).
- This template is synced from `packages/opencode-config` (`packages/server/src/opencode-config.ts`, `packages/server/scripts/copy-opencode-config.mjs`).
- OpenCode autoloads plugins from `plugin/` (`packages/opencode-config/plugin/codenomad.ts`).
- The `CodeNomadPlugin` reads `CODENOMAD_INSTANCE_ID` + `CODENOMAD_BASE_URL`, connects to `GET /workspaces/:id/plugin/events`, and posts to `POST /workspaces/:id/plugin/event` (`packages/opencode-config/plugin/lib/client.ts`).
- The server exposes the plugin routes and maps events into the UI SSE pipeline (`packages/server/src/server/routes/plugin.ts`, `packages/server/src/plugins/handlers.ts`).

## Expectations
- Local-only bridge (no auth/token yet).
- Plugin must fail startup if it cannot connect after 3 retries.
- Keep plugin entrypoints thin; put shared logic under `plugin/lib/` to avoid autoloaded helpers.
- Keep event shapes small and explicit; use `type` + `properties` only.

## Ideas
- Add feature modules under `plugin/lib/features/` (tool lifecycle, permission prompts, custom commands).
- Expand `/workspaces/:id/plugin/*` with dedicated endpoints as needed.
- Promote stable event shapes and version tags once the protocol settles.

## Pointers
- Plugin entry: `packages/opencode-config/plugin/codenomad.ts`
- Plugin client: `packages/opencode-config/plugin/lib/client.ts`
- Plugin server routes: `packages/server/src/server/routes/plugin.ts`
- Plugin event handling: `packages/server/src/plugins/handlers.ts`
- Workspace env injection: `packages/server/src/workspaces/manager.ts`
