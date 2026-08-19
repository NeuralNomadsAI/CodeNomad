# Native OpenCode V2 Critical Behaviors

## Contract

- Keep server and UI on the same reviewed experimental `@opencode-ai/client` release. Update the runtime CLI independently and validate service health and API compatibility instead of enforcing the client's exact version string. Review OpenCode release notes, current documentation, installed declarations, and proxy/API parity on every upgrade.
- The package root is the generated zero-Effect Promise client. Use installed declarations, not current public `@opencode-ai/sdk` examples.
- Native routes are `/api/*`; CodeNomad exposes them only through the authorized `/workspaces/:id/instance` proxy.
- That proxy is an explicit method/path allowlist. Future upstream APIs are not exposed automatically.

## Location Is Authority

- A CodeNomad workspace must validate through `client.location.get` before becoming ready.
- Directory-bearing proxy input is untrusted and must resolve to the workspace root or one of its Git worktrees.
- Session ID alone is insufficient: the proxy fetches the session and verifies `session.location.directory`.
- Queue eviction after the final logical owner is deleted; flush it only during proven final shared-service shutdown.

## Shared Lifecycle

- There is one shared service, client and upstream event subscription. CodeNomad keeps lease and process-identity proof around lifecycle operations, delegates proven host shutdown to native `Service.stop`, and uses native authenticated health stop for WSL.
- A workspace stop removes location ownership; it does not stop a dedicated OpenCode process.
- Transferable proof records registration/credentials, daemon PID and process-start identity, host/WSL namespace, and launch signature. Shutdown stops only after no live peer remains and the proof still identifies the exact daemon.
- V2 forces `OPENCODE_DB` to `~/.local/share/opencode2/opencode.db`; V1/V2 schemas must not share a database.
- The native event stream is volatile. Reconnect must reconcile authoritative state; use current `session.*`, `filesystem.changed`, and `config.updated` names rather than obsolete event aliases.

## Ownership Matrix

| Concern | Owner |
|---|---|
| Session/message/Shell/instructions | OpenCode native API; session Shell remains separate from background Shell and PTY management |
| Background Shell list/metadata/output/remove | Location-scoped OpenCode native API through CodeNomad ownership checks; Status UI refreshes on Shell events/reconnect |
| Interactive PTYs | Separate native `pty.*` API |
| Service discovery/start/stop | CodeNomad hardened adapter using selected OpenCode primitives |
| Workspace and directory authorization | CodeNomad |
| Git status/diff and mutations | CodeNomad |
| Yolo policy/persistence/auto-reply | CodeNomad |
| Browser event multiplexing | CodeNomad `/api/events` |

Background Shell output uses native cursor pagination; interactive PTYs remain separate. Do not restore `@opencode-ai/sdk`, per-workspace processes, `packages/opencode-plugin`, server plugin/background-process tools, or deleted plugin/runtime file paths.
