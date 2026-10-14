# Troubleshooting

Recover by checking the owner of the failing operation first: browser, CodeNomad backend, OpenCode service or provider. A lost reply does not prove a mutation failed; reread current state before repeating it.

## Desktop launch problems {#desktop-launch}

### macOS quarantine {#macos-quarantine}

For a release you downloaded from the official repository and verified, macOS can report that the application is damaged because of quarantine/notarization checks.

1. Check the download's origin and the installed app path.
2. If the app is installed at the following path, remove its quarantine attribute:

```sh
xattr -dr com.apple.quarantine /Applications/CodeNomad.app
```

3. Launch again; on Intel Macs also check **System Settings → Privacy & Security** for the first-launch decision.

This changes the macOS quarantine attribute on that application. It does not repair a corrupted download or make an unknown binary trustworthy.

### Linux graphics and FUSE {#linux-graphics}

A Tauri AppImage that immediately exits on Wayland/NVIDIA can be affected by WebKitGTK's DMA-BUF/GBM renderer. Run the downloaded AppImage with the targeted environment override:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

Electron uses Chromium and is an alternative on the same host. If the AppImage instead cannot mount because FUSE is unavailable, use `--appimage-extract-and-run`; see [Linux installation](install.md#linux-install). These fixes do not require disabling the Electron sandbox.

## Git and workspace availability {#git-and-workspaces}

1. Check Git in the backend account's `PATH`, not only inside the agent's shell.
2. Install Git on that host/account if missing, then restart the CodeNomad backend so it inherits the updated environment.
3. Reopen/refresh the workspace and check repository status.

Directory-only conversations remain available without Git; worktree and Git controls do not. On Windows, Git installed only inside WSL is not enough for the Windows backend. A known folder without a repository can expose **Initialize Git**; a missing Git executable is a different condition and must be fixed first. See [requirements](install.md#requirements) and [Files](files.md).

If an owned worktree or conversation placement cannot be verified, open its physical folder explicitly rather than trying arbitrary paths or editing native storage. Refresh after an uncertain move/removal to see which placement actually exists. Force-removing a worktree can destroy uncommitted files; do not use it as a connection repair.

## OpenCode runtime and WSL {#opencode-runtime}

1. Open **Preferences → OpenCode** and check the selected executable, installed version and running service status.
2. Use the supported installation/update action when the required runtime is missing. Current minimum: **2.0.27**; recommended/qualified: **2.0.29**.
3. If the installed CLI differs from the running service, decide explicitly whether to restart the shared service.

**Restart OpenCode service** is available under **Troubleshooting** and requires confirmation. It interrupts active work in every connected client, but retains session history. Configuration reload is a separate action: it keeps the process but rebuilds loaded Locations and cancels pending questions/permissions. Neither is a harmless refresh.

For a WSL executable, confirm the intended distribution and Windows localhost forwarding. Service lifecycle runs inside Linux; CodeNomad must still reach its loopback endpoint from Windows. Never edit the service registration/database or signal guessed Linux process IDs from Windows.

A custom/newer version can be unverified without being incompatible. Read the actual contract error before changing versions. If session environment synchronization fails, fix the execution-host environment/connection: CodeNomad will not send a prompt without that synchronization. See [OpenCode](opencode.md).

## Login, TLS and direct connectivity {#login-and-tls}

| Symptom | Safe check and recovery |
| --- | --- |
| **Sign in to CodeNomad again** | Keep the page open, enter the server username/password and select **Sign in**. Recovery reconnects in place to keep drafts; it does not replay the failed action. |
| Server unreachable | Verify the backend is running and use its printed address/actual port. An unreachable check alone does not prove your login expired. |
| Provider rejects authentication | Repair the provider's login through its owner; do not change the CodeNomad server password to repair provider OAuth. |
| Certificate name/trust error | Check the actual hostname/IP against certificate SANs and install the intended CA trust or a valid server certificate. Do not disable TLS verification. |
| Direct connection refused | Check effective HTTP/HTTPS binding, firewall and routing. HTTP in desktop or dual-listener mode stays loopback; standalone HTTP-only has different binding behavior. |

After authentication recovery, inspect state before manually retrying a mutation whose reply was uncertain. Runtime passwords must be supplied on every backend start; a password saved through settings persists. See [security](security.md), [TLS/binding rules](remote-access.md) and [server reference](server.md).

## Remote Control pairing {#pairing}

1. On the host, open **Settings → Remote Access** and check Remote Control is running.
2. Create a fresh pairing link and open it on the intended device before it expires.
3. If the client shows **Pair this device again**, pair from the host, then select **Check connection** on the client.

Pairing links are single-use and short-lived; the direct-access password is not a substitute. Revoked or inactivity-expired device credentials require re-pairing. Closing the last desktop window stops its backend and therefore Remote Control; an enabled service resumes at the next application launch. See [Remote Control](remote-control.md) for unavailable host-only surfaces and revocation.

## Provider, plugin and extension state {#providers-and-addons}

| Problem | Recovery |
| --- | --- |
| Wrong provider account/quota | Check the selected native account and **Usage**. A quota display is not a token/cost total. Refresh after an uncertain account change; selection can affect other clients of that service. |
| Expired externally owned OAuth | Sign in again through OpenCode, Claude Code or the relevant credential owner. CodeNomad does not exchange their refresh tokens. |
| Automatic rotation does not switch | Check opt-in eligibility and whether the current account is actually full. It is a pre-admission policy, not in-flight failover or prompt replay. |
| Plugin state looks stale | Use **Refresh plugin controls** and inspect the plugin tooltip's scope/target; runtime activation may await native refresh. Do not repeatedly toggle an uncertain write. |
| Installed extension missing | Check its single activation checkbox in panel customization. Installation/replacement leaves it disabled until you explicitly activate and approve required consent. |
| Extension assets denied | Confirm API 2 asset-read consent for the current mounted session. Installing an extension is not permission to read arbitrary files/history. |

See [Providers](providers.md), [Integrations](integrations.md) and [Extensions](extensions.md).

## History, pending requests and cleanup {#history-and-requests}

Full-history search is not limited to the transcript rows currently loaded. A display filter hides content without deleting it; use [History](history.md) to distinguish search, compaction, technical cleanup and deletion.

If pending-request recovery is incomplete, CodeNomad retains known queues and answer drafts instead of treating missing coverage as an empty queue. After two consecutive incomplete recoveries it warns through ordinary notifications; transient failures are retried by the liveness check. Compaction-related deferral does not mean the request was cancelled. Leave the draft intact, verify the service connection and use the request's current state before answering again.

For cancelled or partial cleanup, read its progress/receipts before starting another deletion. Cancelling does not undo an already dispatched batch. Do not repair history by editing the native database. For Mission uncertainty, use its **Check status**/refresh recovery rather than creating another run or automatically replaying work; [Missions](missions.md) explains restart and lifetime limits.

## Logs and safe diagnostics {#diagnostics}

1. Open **Instance Info** to inspect its status; **Show server logs** exposes the available output.
2. In **Preferences → OpenCode**, choose the intended **Default log level** only when more detail is needed. For standalone CodeNomad logging, use the [server CLI logging options](server.md).
3. Open **Settings → Info → Diagnostics** and use **Report a bug**, **Copy to clipboard** or **Download .txt**.

Logging detail can expose paths, output and application data. Redact credentials, pairing links, network addresses, private paths and conversation content before sharing logs/captures. The full diagnostic report includes paths/addresses; the prefilled bug form deliberately excludes them. See [Support](support.md#report-a-bug).
