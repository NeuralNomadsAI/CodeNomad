# Profile environment at send time

The profile's `server.environmentVariables` apply on each conversation's next
send through CodeNomad (prompt, command, shell; Electron, Tauri and web share the
server path), including resumed conversations and later-prompted forks: the
server awaits `session.environment({ sessionID, variables })` before forwarding.
No polling, per-session settings store, applied-version cache, plugin or daemon
restart.

## Implementation

- Both writes use the connection acquired after ownership and worktree-fence
  admission; a stale connection or disconnected request prevents forwarding.
- `WorkspaceManager.getSessionEnvironment` reads current settings for each send.
- Bundled Missions also applies this snapshot before its assignment prompts and
  report synthetics, through the authenticated desktop bridge's narrow mission
  admission handler. It revalidates the durable contract, native ownership,
  connection and worktree fence before writing; plugin-originated inputs do not
  bypass profile environment handling. See [MISSIONS.md](MISSIONS.md).
- `workspaces/session-environment.ts` builds the **complete** snapshot required by
  the native replacement API. On the host this is the backend process environment
  plus profile overrides, merging keys case-insensitively on Windows.
- With WSL, an asynchronous, bounded `wsl.exe --distribution <distro> --exec env -0`
  reads the execution environment for each send. Windows PATH/HOME are not copied
  into Linux. Configured paths must be meaningful inside the selected distro.
- Clearing an override restores the execution host's inherited value (or removes
  the key when absent there), rather than retaining the previous session value.
- Internal server authentication and OpenCode storage ownership variables are
  omitted. A failed or unsupported environment call fails the send with a
  localized error (never stale values or a retry); existing UI send-failure
  handling restores the draft.

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

Run the real native regression against an explicitly selected CLI:

```text
node scripts/test-session-environment-native.mjs <absolute-opencode-executable>
```

It creates isolated service configuration, state and database with its own port;
uses the real WorkspaceManager, proxy and native shells; checks two conversations,
settings changes/removal, read-only behavior and an unchanged daemon PID; and
stops only that isolated service. Windows also exercises Git Bash at its standard
installation path. No provider call or existing conversation is used.

## Agent conventions

- Profile environment variables are applied server-side before each native session prompt, custom command or session shell request, after ownership and worktree-mutation admission. Build a complete execution-host snapshot with `workspaces/session-environment.ts`; never send the profile environment through the browser or skip the per-send write using a cache. Reads and settings edits do not mutate native sessions. Keep native environment failures fail-closed and redact SDK request bodies.
