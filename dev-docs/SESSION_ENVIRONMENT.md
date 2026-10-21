# Profile environment at send time

The profile's `server.environmentVariables` apply on each conversation's next
send through CodeNomad (prompt, command, shell; Electron, Tauri and web share the
server path), including resumed conversations and later-prompted forks: the
server awaits `session.environment({ sessionID, variables })` before forwarding.

## Implementation

- Both writes use the connection acquired after ownership and worktree-fence
  admission; a stale connection or disconnected request prevents forwarding.
- `WorkspaceManager.getSessionEnvironment` reads current settings for each send.
- Bundled Missions also applies this snapshot before its assignment prompts and
  report synthetics, through the authenticated desktop bridge's narrow mission
  admission handler. It revalidates the durable contract, native ownership,
  connection and worktree fence before writing, so plugin-originated inputs get
  the same profile environment. See [MISSIONS.md](MISSIONS.md).
- `workspaces/session-environment.ts` builds the **complete** snapshot required by
  the native replacement API. On the host this is the backend process environment
  plus profile overrides, merging keys case-insensitively on Windows.
- With WSL, an asynchronous, bounded `wsl.exe --distribution <distro> --exec env -0`
  reads the execution environment for each send, so the distro keeps its own
  PATH/HOME. Configured paths must be meaningful inside the selected distro.
- Clearing an override restores the execution host's inherited value (or removes
  the key when absent there).
- Internal server authentication and OpenCode storage ownership variables are
  omitted. A failed or unsupported environment call fails the send with a
  localized error (never stale values or a retry); existing UI send-failure
  handling restores the draft.

## Scope

This controls the targeted conversation's **local shell commands**. Providers,
MCP/LSP servers, independent PTYs, location-only shells and the daemon's own
temporary files keep the daemon's process environment. Allowed variables are
also passed when CodeNomad starts a stopped service.

The environment belongs to the native session; other clients can replace it. A
send while a session is already working can affect its subsequent command
launches; running processes keep their existing environment. Queued prompts run
with the session environment current when they execute.

OpenCode-created child sessions get the profile environment only when CodeNomad
sends to them; never claim automatic subagent inheritance.
Environment and prompt are two separate native requests, so another client can
replace the environment between them.

## Fresh profile reads at admission

`SettingsService.readEnvironmentForAdmission(signal)` reads only the profile's
resolved `ConfigLocation.configYamlPath`. `WorkspaceManager.getSessionEnvironment`
uses this read before calling the execution-host snapshot builder; ordinary settings
reads, UI caches, persistence and daemon startup use their own paths.

Each admission opens and reads the canonical file anew; never fall back to cached
settings, `state.yaml`, JSON settings files, backups, another profile or browser
storage. An absent canonical file has the normal empty-profile override default;
removing an override (or the file) rebuilds from the authority process environment.
A missing server/environment owner in a valid object document also means no overrides. Profile/host ownership remains
the caller's responsibility.

Reads are limited to 1 MiB, including growth after stat, and a 2-second I/O admission
deadline. Nonregular files, unreadable files, malformed UTF-8/YAML, duplicate keys,
parser warnings, excessive alias expansion, invalid document/owner/environment
shapes and invalid environment entries reject with
`PROFILE_ENVIRONMENT_UNAVAILABLE`, as do empty/null documents. Only startup migration
converts a `preferences` layout; the admission reader never migrates or writes it.
Cancellation rejects without carrying the caller's abort reason. A late I/O
completion closes its descriptor but cannot admit a native send. Parsing is
synchronous and bounded by the file/alias quotas; the deadline applies to I/O only.

The reader never logs and replaces underlying parser/I/O errors with a fixed
message, without paths, values or error causes. Failed reads return no snapshot,
so callers cannot apply `session.environment` or send prompt/synthetic input.
Native authority, connection and ownership fences apply around the awaits.

The snapshot built from it always excludes internal authentication and native storage variables; its base is
the authority process environment, which can change when the authority restarts.

Its regressions use isolated temporary files:

```text
node --import tsx --test packages/server/src/settings/admission-environment.test.ts packages/server/src/settings/service.test.ts packages/server/src/workspaces/session-environment.test.ts
npm run typecheck --workspace @neuralnomads/codenomad
```

## Validation

Run the real native regression against an explicitly selected CLI:

```text
node scripts/test-session-environment-native.mjs <absolute-opencode-executable>
```

It creates isolated service configuration, state and database with its own port;
uses the real WorkspaceManager, proxy and native shells; checks two conversations,
settings changes/removal, read-only behavior and an unchanged daemon PID; and
stops only that isolated service. Windows also exercises Git Bash at its standard
installation path. It never calls a provider or touches an existing conversation.

## Agent conventions

- Profile environment variables are applied server-side before each native session prompt, custom command or session shell request, after ownership and worktree-mutation admission. Build a complete execution-host snapshot with `workspaces/session-environment.ts`; never send the profile environment through the browser or skip the per-send write using a cache. Reads and settings edits must never mutate native sessions. Keep native environment failures fail-closed and redact SDK request bodies.
