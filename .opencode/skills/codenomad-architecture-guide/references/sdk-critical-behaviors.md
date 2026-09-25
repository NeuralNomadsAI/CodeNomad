# Native OpenCode V2 Critical Behaviors

## Contract

- Server and UI pin `@opencode/client@2.0.16`. Manage the runtime CLI independently: startup checks authenticated loopback `/api/status`, then `/api/health`, then `/api/info`, advancing only on HTTP 404. All probes share the endpoint, credentials, 64 KiB response bound and absolute deadline; authentication, transport and malformed response failures do not trigger fallback. The shared transport maps canonical `server.info()` to the discovered route. Older services do not provide `paths.tmp`; never infer that path from the backend host. Discovery alone does not prove client/API compatibility. Review documentation, installed declarations and proxy/API parity whenever the client contract changes.
- The package root is the generated zero-Effect Promise client. Use installed declarations, not current public `@opencode-ai/sdk` examples.
- Native routes are `/api/*`; CodeNomad exposes them only through the authorized `/workspaces/:id/instance` proxy.
- That proxy is an explicit method/path allowlist. Future upstream APIs are not exposed automatically.
- Proxy authorization and forwarding share one acquired connection. A stale generation must be rejected at actual HTTP dispatch, including after asynchronous body preparation; late streams cannot invalidate a replacement connection.
- The technical minimum is 2.0.7: native `session.step.started.data.started` is consumed directly after removing its older fallback. Recommendation/qualification 2.0.16 is independent. Unknown version labels, prereleases and future majors require bounded authenticated API recognition, including session environment support; they are not rejected solely by label. Legacy HTTP inbox and event conversions are retired. Native `session.inbox.enqueued` still has a distinct shape: its timestamp belongs to event metadata, not an HTTP inbox record.
- Never retry a write using another contract after a 400/404/transport failure. Keep the setup/recovery path distinct from functional transport and never replay prompts.

## Location Is Authority

- A CodeNomad workspace must validate through `client.location.get` before becoming ready.
- Directory-bearing proxy input is untrusted and must resolve to the workspace root or one of its Git worktrees.
- Session ID alone is insufficient: the proxy fetches the session and verifies `session.location.directory`.
- Explicit Stop Workspace evicts the native location/resources and removes CodeNomad's logical workspace. Ordinary tab/window close only detaches local UI and never evicts.

## Shared Lifecycle

- There is one externally owned global service, one server client and one upstream event subscription. CodeNomad uses official host/WSL CLI status/start/password commands, owns no private service state or PID, and never stops the daemon on backend shutdown.
- WSL requires Windows localhost forwarding, executes lifecycle commands inside Linux, and never uses cross-namespace PID operations.
- A workspace stop evicts its location; it does not stop a dedicated process or the global daemon.
- The worktree deletion fence covers OpenCode proxy writes plus CodeNomad file and Git mutations for the same canonical worktree identity.
- OpenCode owns standard state/database. Allowed configured environment variables are passed when starting a missing daemon; existing daemons are unchanged, and `OPENCODE_DB`/`XDG_STATE_HOME` are ignored. Independently, before each session prompt/command/shell send, the authorized proxy awaits `session.environment` with the profile's complete execution-host snapshot. A failure blocks the send; it is never silently skipped or retried.
- The native event stream is volatile. Reconnect must reconcile authoritative state; use current `session.*`, `filesystem.changed`, and `config.updated` names rather than obsolete event aliases.

## Ownership Matrix

| Concern | Owner |
|---|---|
| Session/message/Shell/instructions | OpenCode native API; session Shell remains separate from background Shell and PTY management |
| Background Shell list/metadata/output/remove | Location-scoped OpenCode native API through CodeNomad ownership checks; Status UI refreshes on Shell events/reconnect |
| Interactive PTYs | Separate native `pty.*` API |
| Service status/start/password | CodeNomad adapter using the selected host or WSL CLI; only the explicit setup restart may stop/start the shared daemon |
| Workspace and directory authorization | CodeNomad |
| Git status/diff and mutations | CodeNomad |
| Yolo policy/persistence/auto-reply | CodeNomad |
| Browser event multiplexing | CodeNomad `/api/events` |

Background Shell output uses native cursor pagination; interactive PTYs remain separate. Do not restore `@opencode-ai/sdk`, per-workspace processes, `packages/opencode-plugin`, server plugin/background-process tools, or deleted plugin/runtime file paths.
