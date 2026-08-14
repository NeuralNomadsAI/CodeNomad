# Native OpenCode V2 Critical Behaviors

## Contract

- The experimental protocol version is pinned to `@opencode-ai/client@0.0.0-next-17353`; update server, UI, and the required `opencode2` CLI together.
- The package root is the generated zero-Effect Promise client. Use installed declarations, not current public `@opencode-ai/sdk` examples.
- Native routes are `/api/*`; CodeNomad exposes them only through the authorized `/workspaces/:id/instance` proxy.
- That proxy is an explicit method/path allowlist. Future upstream APIs are not exposed automatically.

## Location Is Authority

- A CodeNomad workspace must validate through `client.location.get` before becoming ready.
- Directory-bearing proxy input is untrusted and must resolve to the workspace root or one of its Git worktrees.
- Session ID alone is insufficient: the proxy fetches the session and verifies `session.location.directory`.
- Queue eviction after the final logical owner is deleted; flush it only during proven final shared-service shutdown.

## Shared Lifecycle

- There is one shared service, client and upstream event subscription. Production uses CodeNomad's custom lease-locked launcher and authenticated stop, not direct `Service.ensure`/`Service.stop`.
- A workspace stop removes location ownership; it does not stop a dedicated OpenCode process.
- Transferable proof records registration/credentials, daemon PID and process-start identity, host/WSL namespace, and launch signature. Shutdown stops only after no live peer remains and the proof still identifies the exact daemon.
- A user-configured `OPENCODE_DB` is required at service startup. There is no default, V1/V2 schemas must not share a database, and environment changes apply on service start/restart.
- The native event stream is volatile. Reconnect must reconcile authoritative state; use current `session.*`, `filesystem.changed`, and `config.updated` names rather than obsolete event aliases.

## Ownership Matrix

| Concern | Owner |
|---|---|
| Session/message/Shell/instructions | OpenCode native API; Shell remains separate from PTY management |
| PTY list/metadata/title/remove | Location-scoped OpenCode native API through CodeNomad ownership checks; Status UI refreshes on PTY events/reconnect |
| PTY output/distinct stop | Unavailable in exact `next-17353`; removal is the native stop action for a running PTY |
| Service discovery/start/stop | CodeNomad hardened adapter using selected OpenCode primitives |
| Workspace and directory authorization | CodeNomad |
| Git status/diff and mutations | CodeNomad |
| Yolo policy/persistence/auto-reply | CodeNomad |
| Browser event multiplexing | CodeNomad `/api/events` |

Exact `next-17353` has no PTY output/read/stream API or separate stop endpoint, so the UI cannot display PTY output or offer a distinct stop action. Do not restore `@opencode-ai/sdk`, per-workspace processes, `packages/opencode-plugin`, server plugin/background-process tools, or deleted plugin/runtime file paths.
