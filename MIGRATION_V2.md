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

## Removed Legacy Components

- Remove the custom `packages/opencode-plugin` package.
- Remove V1 plugin communication channels and per-workspace runtime management.
- Replace interactive shell-mode requests with native V2 Shell and expose native V2 PTYs in the Status panel.
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

- Restrict proxied Shell and PTY working directories to workspace-owned roots and Git worktrees; PTY controls also verify the native PTY `cwd` before forwarding ID-scoped requests.
- Remove CodeNomad authentication cookies before forwarding requests to OpenCode.
- Prevent OpenCode `Set-Cookie` headers from being relayed to the browser.
- Avoid logging unredacted secret-bearing proxy request bodies.
- Expose only an explicit method/path allowlist through the OpenCode proxy. New upstream APIs require an intentional proxy and ownership review; future OpenCode functionality is not automatic.
- Share a consistent service registration location between Windows and WSL.
- Probe the selected `opencode2` CLI and discover/ensure only the exact version pinned by `packages/server/package.json`. Each dependency upgrade must review OpenCode release notes, current documentation, installed client declarations, and proxy/API parity.
- Wrap native `Service.ensure`/`Service.stop` with CodeNomad's ownership checks. A lifecycle lease records the registration, authenticated endpoint, daemon PID plus process-start identity and host/WSL namespace, and a hash of the launch command/environment. Proof can transfer between live CodeNomad processes through peer leases; the final host process calls `Service.stop` only after proving there are no live peers and every recorded identity still matches. WSL uses the authenticated native health stop endpoint and never allows the client's Windows `process.kill` fallback to target a Linux PID.
- Queue location eviction when its final logical owner is removed, then perform it only during proven final shared-service shutdown so another CodeNomad process cannot lose active upstream state.
- Force the V2 service database to `~/.local/share/opencode2/opencode.db`. V1 and V2 must never point at the same database because their schemas are incompatible.
- Isolate V2 restore state under `~/.codenomad/client-state/v2` and copy V1 state non-destructively on first launch, preserving downgrade history.

## Current Status

- Server, UI, and the selected `opencode2` CLI are exact-version-gated to `0.0.0-beta-17595`.
- The updater advertises and installs only that pinned startup-compatible version; both repository lockfiles resolve the same client, protocol, and schema release.
- Shared-service shutdown delegates host daemons to native `Service.stop` after CodeNomad proves ownership and excludes live peer leases; WSL uses native authenticated health stop.
- The UI uses native Forms instead of the removed Question API and `@opencode-ai/client/solid` `createData` for live message, tool, permission, and form reduction. Live projections merge into REST-loaded history instead of replacing it.
- Session inventory uses native project/subpath/parent/order cursor pagination across all descendant depths; later pages receive native active status, and internal OpenCode stream generations trigger authoritative UI reconciliation even when browser SSE remains connected.
- The proxy validates the decoded scope of native session cursors before forwarding them and supports native global Form reply/cancel routes without treating `global` as a session ID.
- Before deleting a worktree, the server inventories the complete native project, evacuates affected session families with verification and rollback, and fails closed for direct API callers. One canonical folder maps to one logical workspace instead of creating non-isolated duplicates.
- The current working tree retains the isolated V2 database, deferred location eviction, and proxy path/location ownership validation.
- Current installed client declarations provide native PTY list/get/create/title-or-size update/remove and lifecycle events, but no output/read/stream API and no separate stop API. Removing a running PTY is therefore the only native stop action, and PTY output is not displayed.
- Local validation passes server/UI/Electron typechecks, the CI UI partitions, Electron native tests, server tests (with three platform skips), standalone server lockfile dry-run installation, UI/server/Electron builds, Tauri `cargo check --locked`, and `git diff --check`.

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

CodeNomad V1 is the working environment and must remain open and untouched. V2 always uses `~/.local/share/opencode2/opencode.db`. Build into `codenomad-v2-slots/build-{A|B}/release`, copy the validated output into the corresponding `codenomad-v2-slots/{A|B}` deployment slot, and record its source, hash, slot, and deployment time in `deployment.json`.

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
6. Exercise one PTY create/list/remove cycle through the workspace proxy, then close only the V2 process after collecting its logs. PTY creation is not currently exposed in the visible UI.

Do not count direct HTTP/CDP calls as validation for workspace, session, prompt, response, or reload behavior. CDP may inspect the V2 DOM and operate visible controls, but it must follow the same controls and state transitions as a user. The PTY protocol check is the sole exception until the UI exposes creation.

## Review Notes

- The OpenCode V2 protocol client is experimental and may change. Review its release notes, current documentation, and installed declarations on every upgrade; public `@opencode-ai/sdk` examples are not authoritative for this build.
- Upgrade references: [OpenCode releases](https://github.com/anomalyco/opencode/releases), [OpenCode documentation](https://opencode.ai/docs/), and the installed `node_modules/@opencode-ai/client/dist/promise/` declarations.
- This branch intentionally provides no OpenCode V1 fallback.
- The branch should remain a Draft Pull Request until gatekeeper review, the validation matrix, and the real-service smoke test are complete.
