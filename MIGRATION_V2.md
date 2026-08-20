# OpenCode V2 Migration

## Summary

This branch migrates CodeNomad from the OpenCode V1 SDK and custom plugin architecture to the native OpenCode V2 client and shared service model.

The migration removes the V1 compatibility layer rather than maintaining both integrations. It substantially reduces custom runtime code and aligns CodeNomad with OpenCode's supported V2 APIs.

## Main Changes

- Replace `@opencode-ai/sdk` with the experimental `@opencode-ai/client` protocol. Server and UI track the latest reviewed `next` release together; this contract is distinct from the current public `@opencode-ai/sdk` documentation.
- Use one shared OpenCode V2 service instead of one runtime per workspace.
- Represent CodeNomad workspaces as logical instances associated with absolute directories.
- Use native `Location` and `SessionInfo.location` data to associate sessions, files, events, and Git worktrees.
- Migrate sessions, messages, streaming events, permissions, questions, files, VCS, commands, MCP, providers, models, and agents to native V2 APIs.
- Handle native session lifecycle and output events, including `session.created`, `session.renamed`, `session.moved`, `session.status`, `session.idle`, `session.execution.*`, `session.compaction.*`, `session.text.*`, `session.reasoning.*`, and `session.tool.*`.
- Use browser `EventSource` as the single desktop and web event transport; the duplicate Rust-native Tauri transport was removed.
- Treat the native event stream as volatile. Reconnect has no replay guarantee, so clients must reconcile authoritative session and pending-request state after reconnect; file/config consumers must also refetch rather than assume every `filesystem.changed` or `config.updated` event was observed.
- Route events from owned Git worktrees to their corresponding logical CodeNomad workspace.
- Query native sessions by validated project scope, then traverse every descendant depth with native cursors.
- Resolve locationless session events through native session ownership so prompt status and output reach the correct logical workspace.
- Run one native process and one CodeNomad backend per channel/config profile. The native singleton focuses the most-recent window on a second launch unless `--new-window` is supplied; each process may host multiple UUID-backed windows.
- Keep OpenCode sessions/messages in the shared global service while tabs, drafts, view state, and restore membership remain local to each window.
- Store desktop restore state in a V3 per-window envelope whose snapshots use the V2 content-addressed partition graph. Native hosts prepare immutable partitions before atomically publishing the root, fence writes and migrations on current ownership, and collect only unreferenced partitions after publication.

## Removed Legacy Components

- Remove the custom `packages/opencode-plugin` package.
- Remove V1 plugin communication channels and per-workspace runtime management.
- Replace shell-mode requests with native `session.shell` and expose native background `shell.*` processes in the Status panel; keep interactive `pty.*` terminals separate.
- Replace per-workspace OpenCode binary selection with one global `opencode2` binary.
- Migrate the persisted V1 default command `opencode` to `opencode2` during workspace launch.
- Remove message and part deletion controls because V2 currently has no equivalent API.
- Keep Git mutation operations on the CodeNomad server where V2 does not yet provide sufficient parity.

## Provider Authentication and Voice Mode

- Support native V2 API-key, OAuth, interactive form, and command-based provider authentication.
- Display required provider fields and submit answers in the native V2 format.
- Store voice-mode instructions through `session.instructions.entry`.
- Synchronize voice instructions before prompts, slash commands, and shell requests.

## Security and Service Lifecycle

- Restrict proxied Shell and PTY working directories to workspace-owned roots and Git worktrees; ID-scoped controls verify the native `cwd` before forwarding requests.
- Remove CodeNomad authentication cookies before forwarding requests to OpenCode.
- Prevent OpenCode `Set-Cookie` headers from being relayed to the browser.
- Avoid logging unredacted secret-bearing proxy request bodies.
- Expose only an explicit method/path allowlist through the OpenCode proxy. New upstream APIs require an intentional proxy and ownership review; future OpenCode functionality is not automatic.
- Connect to one externally owned global daemon using OpenCode's standard service registration, state, and database in the selected host or WSL environment; CodeNomad owns no private port, database, registration, or daemon PID.
- Keep server and UI on the same reviewed client release. The selected `opencode2` CLI is updated independently and validated through service health and API compatibility rather than an exact version gate.
- Use the selected host or WSL CLI's official `service status`, `service start`, and `service get password` commands, then require bounded authenticated loopback health validation.
- WSL support requires Windows localhost forwarding and uses the Linux CLI lifecycle inside the selected distribution; CodeNomad performs no cross-namespace PID operations.
- Explicit **Stop Workspace** evicts that location and its resources through the global service without stopping the daemon. Ordinary tab/window close only detaches local UI state and never evicts a location.
- Never stop the global service during CodeNomad backend shutdown; clear only in-memory connection state.
- Keep service registration, state, and database paths at OpenCode's platform defaults.
- A missing global daemon receives configured `server.environmentVariables` and the current `NODE_EXTRA_CA_CERTS` on `service start` only. An already-running daemon is unaffected; legacy `OPENCODE_DB` and `XDG_STATE_HOME` settings are ignored rather than taking storage ownership.
- Isolate V2 restore state under `~/.codenomad/client-state/v2` and copy V1 state non-destructively on first launch, preserving downgrade history.
- Sandbox native SideCar/browser previews without `allow-same-origin`; DOM comment inspection remains available only in the web client.

## Current Status

- Server and UI are pinned to `0.0.0-beta-17595`; the selected `opencode2` CLI is not exact-version-gated.
- The updater advertises and installs only that pinned startup-compatible version; both repository lockfiles resolve the same client, protocol, and schema release.
- Shared-service shutdown clears only local connection state and never stops host or WSL daemons.
- Stable, dev, and non-default config profiles have isolated native singleton, backend, browser storage, and client-state scopes. Each scope supports multiple UUID windows; OpenCode sessions/messages remain global while tabs, drafts, and views are per-window.
- Client-state V3 stores one record per window over the V2 content-addressed partition graph with atomic root publication, ownership fencing, migration guards, and post-commit conservative garbage collection.
- The UI uses native Forms instead of the removed Question API and `@opencode-ai/client/solid` `createData` for live message, tool, permission, and form reduction. Live projections merge into REST-loaded history instead of replacing it.
- Session inventory uses native project/subpath/parent/order cursor pagination across all descendant depths; later pages receive native active status, and internal OpenCode stream generations trigger authoritative UI reconciliation even when browser SSE remains connected.
- The proxy validates the decoded scope of native session cursors before forwarding them and supports native global Form reply/cancel routes without treating `global` as a session ID.
- Before deleting a worktree, the server inventories the complete native project, evacuates affected session families with verification and rollback, and fails closed for direct API callers. One canonical folder maps to one logical workspace instead of creating non-isolated duplicates.
- The current working tree retains proxy path/location ownership validation while leaving global service storage and lifecycle ownership to OpenCode.
- Current installed client declarations provide background Shell list/get/create/output/timeout/remove and lifecycle events. Shell output pagination keeps the native cursor authoritative. Interactive PTY APIs remain separate and are not used by the background-process panel.
- This documentation pass ran stale-architecture greps and `git diff --check`; it did not run or claim the pending build matrix or real-service smoke test.

## Remaining Work

- Run the complete test and build matrix after the fixes.
- Run the real-service smoke test before marking the PR ready for review.

## Validation

The final validation should include:

- Server and UI typechecks.
- Server and UI test suites.
- Server and UI production builds.
- Electron native tests and typecheck when its local dependencies are available.
- `git diff --check`.
- A real OpenCode V2 startup, session, event, Shell, and shutdown smoke test.

### Required Parallel UI Smoke

CodeNomad V1 is the working environment and must remain open and untouched. The OpenCode global daemon keeps its standard state and database; CodeNomad does not provide a private V2 database override. Build into `codenomad-v2-slots/build-{A|B}/release`, copy the validated output into the corresponding `codenomad-v2-slots/{A|B}` deployment slot, and record its source, hash, slot, and deployment time in `deployment.json`.

For a first V2 launch, start the deployed slot beside V1 from PowerShell with a dedicated CDP port, WebView profile, Rust backtraces, and Node source maps:

```powershell
$slot = "$env:TEMP\opencode\codenomad-v2-slots\A"
$environment = @{
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
    WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\opencode\codenomad-v2-debug"
    RUST_BACKTRACE = '1'
    NODE_OPTIONS = '--enable-source-maps'
}
Start-Process -FilePath "$slot\codenomad-tauri.exe" -WorkingDirectory $slot -Environment $environment
```

To replace an active V2 instance, write the target slot, validated fallback slot, top-level CodeNomad window PID, and a unique request ID to `$env:TEMP\opencode\codenomad-v2-handoff-request.json`. Run `$env:TEMP\opencode\codenomad-v2-handoff.ps1` through an interactive Windows scheduled task owned by the logged-in user. This gives the handoff an external lifetime and desktop access while it closes the active process, applies the environment above, and starts the target slot:

```powershell
$root = "$env:TEMP\opencode"
$targetSlot = Join-Path $root 'codenomad-v2-slots\A'
$fallbackSlot = Join-Path $root 'codenomad-v2-slots\B'
$requestPath = Join-Path $root 'codenomad-v2-handoff-request.json'
$handoffPath = Join-Path $root 'codenomad-v2-handoff.ps1'
$taskName = 'CodeNomad-V2-Handoff'
$windowProcess = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'codenomad-tauri.exe' -and
    $_.ExecutablePath -like "$root\codenomad-v2-slots\?\codenomad-tauri.exe" -and
    $_.CommandLine -notmatch 'internal-cli-launcher'
  } |
  Select-Object -First 1

@{
  mode = 'launch'
  requestId = [guid]::NewGuid().ToString('N')
  executable = Join-Path $targetSlot 'codenomad-tauri.exe'
  fallbackExecutable = Join-Path $fallbackSlot 'codenomad-tauri.exe'
  waitForPid = $windowProcess.ProcessId
  closeOldProcess = $true
  clientStateSeedPath = $null
  clientStateSeedSha256 = $null
} | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding utf8

$action = New-ScheduledTaskAction -Execute (Get-Command pwsh).Source -Argument (
  "-NoProfile -ExecutionPolicy Bypass -File `"$handoffPath`" -RequestPath `"$requestPath`""
)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)
$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
```

Read `$env:TEMP\opencode\codenomad-v2-handoff-result.json` after reconnection. A successful handoff has `status: "started"`; verify its PID runs from the requested slot and compare the executable hash with that slot's `deployment.json` before recording the smoke build as active. Remove the completed one-shot task with `Unregister-ScheduledTask -TaskName 'CodeNomad-V2-Handoff' -Confirm:$false`.

The smoke is complete only after all of these actions succeed in the visible V2 UI:

1. Confirm the selected `opencode2` binary reports the latest version reviewed for this branch.
2. Open `D:\CodeNomad` from Recent Folders or the folder picker.
3. Open an existing session from the session list; direct API session creation is not a substitute.
4. Send a prompt from the composer and receive its visible assistant response.
5. Reload the V2 window and confirm the workspace and session list recover. While V1 owns cross-host restore, reopen the existing V2 session from the list and confirm its messages and pending state recover correctly.
6. Exercise one background Shell create/list/output/remove cycle through the workspace proxy, then close only the V2 process after collecting its logs. Shell creation is not currently exposed in the visible UI.

Do not count direct HTTP/CDP calls as validation for workspace, session, prompt, response, or reload behavior. CDP may inspect the V2 DOM and operate visible controls, but it must follow the same controls and state transitions as a user. The background Shell protocol check is the sole exception until the UI exposes creation.

## Review Notes

- The OpenCode V2 protocol client is experimental and may change. Review its release notes, current documentation, and installed declarations on every upgrade; public `@opencode-ai/sdk` examples are not authoritative for this build.
- Upgrade references: [OpenCode releases](https://github.com/anomalyco/opencode/releases), [OpenCode documentation](https://opencode.ai/docs/), and the installed `node_modules/@opencode-ai/client/dist/promise/` declarations.
- This branch intentionally provides no OpenCode V1 fallback.
- The branch should remain a Draft Pull Request until gatekeeper review, the validation matrix, and the real-service smoke test are complete.
