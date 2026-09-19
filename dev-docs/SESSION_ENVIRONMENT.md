# Profile environment at send time

The profile's existing `server.environmentVariables` setting is applied before
every native `session.prompt`, `session.command`, and `session.shell` request
sent through CodeNomad. The server awaits `session.environment({ sessionID,
variables })` before forwarding the original request. Electron, Tauri and web
clients use the same server path.

Opening, reading or creating a conversation does not set its environment. Saving
settings does not walk existing sessions. Every conversation receives the current
profile settings on its next send, including resumed conversations and forks
that the user subsequently prompts. There is no polling, per-session settings
store, applied-version cache, plugin or daemon restart.

## Implementation

- The guarded instance proxy applies the environment only after ownership checks
  and acquisition of the worktree mutation fence. Both writes use the acquired
  connection; a stale connection or disconnected request prevents forwarding.
- `WorkspaceManager.getSessionEnvironment` reads current settings for each send.
- `workspaces/session-environment.ts` builds the **complete** snapshot required by
  the native replacement API. On the host this is the backend process environment
  plus profile overrides, merging keys case-insensitively on Windows.
- With WSL, an asynchronous, bounded `wsl.exe --distribution <distro> --exec env -0`
  reads the execution environment for each send. Windows PATH/HOME are not copied
  into Linux. Configured paths must be meaningful inside the selected distro.
- Clearing an override restores the execution host's inherited value (or removes
  the key when absent there), rather than retaining the previous session value.
- Internal server authentication variables and OpenCode storage ownership
  variables are omitted. Full snapshots never pass through the browser. Native
  request errors are not logged or reflected, since they can include these values.
- A failed or unsupported environment call fails the send with a localized error;
  it does not silently send using stale values or retry the mutation. Existing UI
  send failure/draft handling remains responsible for restoring the user's input.

For host execution the additional work is an in-memory merge and one local API
request per send. WSL additionally launches the environment reader. No performance
claim is made without measurement.

## Scope

This controls the targeted conversation's **local shell commands**. It does not
reconfigure providers, MCP/LSP servers, independent PTYs, location-only shells,
or the daemon's own temporary files. Existing startup-variable behavior remains:
allowed variables are also passed when CodeNomad starts a stopped service.

The environment belongs to the native session, not the client or the individual
prompt. Other clients can replace it. A send while a session is already working
can affect its subsequent command launches; running processes keep their existing
environment. Queued prompts do not capture separate environment snapshots.

OpenCode-created child sessions that execute without a CodeNomad send are outside
this interception point. Do not claim automatic subagent inheritance. The native
API is not an atomic environment-plus-prompt transaction; no global cross-client
isolation is added by this change.

## Validation

Unit/HTTP integration tests cover full snapshots, Windows key casing, WSL host
selection, credential exclusion, per-send updates/removal, prompt/command/shell
ordering, read-only behavior, denied sessions, failure redaction, stale connection
fencing, worktree deletion and disconnect cancellation.

Run the real native regression against an explicitly selected CLI:

```text
node scripts/test-session-environment-native.mjs <absolute-opencode-executable>
```

It creates isolated service configuration, state and database with its own port;
uses the real WorkspaceManager, proxy and native shells; checks two conversations,
settings changes/removal, read-only behavior and an unchanged daemon PID; and
stops only that isolated service. Windows also exercises Git Bash at its standard
installation path. No provider call or existing conversation is used.
