# Native OpenCode V2 Critical Behaviors

## Contract

- Keep server and UI on the latest experimental `@opencode-ai/client@beta` contract. Let the runtime CLI independently follow its latest beta without enforcing the client's exact version string. Review current documentation, installed declarations, and proxy/API parity whenever the beta contract changes.
- The package root is the generated zero-Effect Promise client. Use installed declarations, not current public `@opencode-ai/sdk` examples.
- Native routes are `/api/*`; CodeNomad exposes them only through the authorized `/workspaces/:id/instance` proxy.
- That proxy is an explicit method/path allowlist. Future upstream APIs are not exposed automatically.

## Location Is Authority

- A CodeNomad workspace must validate through `client.location.get` before becoming ready.
- Directory-bearing proxy input is untrusted and must resolve to the workspace root or one of its Git worktrees.
- Session ID alone is insufficient: the proxy fetches the session and verifies `session.location.directory`.
- Explicit Stop Workspace evicts the native location/resources and removes CodeNomad's logical workspace. Ordinary tab/window close only detaches local UI and never evicts.

## Shared Lifecycle

- There is one externally owned global service, one server client and one upstream event subscription. CodeNomad uses official host/WSL CLI status/start/password commands, owns no private service state or PID, and never stops the daemon on backend shutdown.
- WSL requires Windows localhost forwarding, executes lifecycle commands inside Linux, and never uses cross-namespace PID operations.
- A workspace stop evicts its location; it does not stop a dedicated process or the global daemon.
- OpenCode owns standard state/database. Allowed configured environment variables apply only when starting a missing daemon; existing daemons are unchanged, and `OPENCODE_DB`/`XDG_STATE_HOME` are ignored.
- The native event stream is volatile. Reconnect must reconcile authoritative state; use current `session.*`, `filesystem.changed`, and `config.updated` names rather than obsolete event aliases.

## Ownership Matrix

| Concern | Owner |
|---|---|
| Session/message/Shell/instructions | OpenCode native API; session Shell remains separate from background Shell and PTY management |
| Background Shell list/metadata/output/remove | Location-scoped OpenCode native API through CodeNomad ownership checks; Status UI refreshes on Shell events/reconnect |
| Interactive PTYs | Separate native `pty.*` API |
| Service status/start/password | CodeNomad adapter using the selected host or WSL CLI; daemon stop remains external |
| Workspace and directory authorization | CodeNomad |
| Git status/diff and mutations | CodeNomad |
| Yolo policy/persistence/auto-reply | CodeNomad |
| Browser event multiplexing | CodeNomad `/api/events` |

Background Shell output uses native cursor pagination; interactive PTYs remain separate. Do not restore `@opencode-ai/sdk`, per-workspace processes, `packages/opencode-plugin`, server plugin/background-process tools, or deleted plugin/runtime file paths.
