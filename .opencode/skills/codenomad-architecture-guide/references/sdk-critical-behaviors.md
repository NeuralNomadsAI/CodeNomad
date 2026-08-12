# Native OpenCode V2 Critical Behaviors

## Contract

- Version is pinned to `@opencode-ai/client@0.0.0-next-17288`; update server and UI together.
- The package root is the generated zero-Effect Promise client. Use installed declarations, not old SDK examples.
- Native routes are `/api/*`; CodeNomad exposes them only through the authorized `/workspaces/:id/instance` proxy.

## Location Is Authority

- A CodeNomad workspace must validate through `client.location.get` before becoming ready.
- Directory-bearing proxy input is untrusted and must resolve to the workspace root or one of its Git worktrees.
- Session ID alone is insufficient: the proxy fetches the session and verifies `session.location.directory`.
- Evict an upstream location only after its final logical owner is deleted.

## Shared Lifecycle

- There is one shared `Service.ensure`, client and upstream event subscription.
- A workspace stop removes location ownership; it does not stop a dedicated OpenCode process.
- Shutdown stops the service only when CodeNomad started and still owns the discovered endpoint.

## Ownership Matrix

| Concern | Owner |
|---|---|
| Session/message/Shell/instructions | OpenCode native API |
| Service discovery/start/stop | OpenCode `Service`, wrapped by CodeNomad |
| Workspace and directory authorization | CodeNomad |
| Git status/diff and mutations | CodeNomad |
| Yolo policy/persistence/auto-reply | CodeNomad |
| Browser event multiplexing | CodeNomad `/api/events` |

Do not restore `@opencode-ai/sdk`, per-workspace processes, `packages/opencode-plugin`, plugin background-process tools, or deleted plugin/runtime file paths.
