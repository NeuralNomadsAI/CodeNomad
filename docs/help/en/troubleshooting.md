# Troubleshooting

## Desktop launch problems {#desktop-launch}

### macOS quarantine {#macos-quarantine}

CodeNomad's macOS releases are not notarized by Apple, so macOS can block the first launch of a downloaded copy, even one you verified from the official repository: it can report **"CodeNomad" Not Opened** (Apple could not verify that it is free of malware), or that the application is damaged.

1. Check the download's origin and the installed app path.
2. If the app is installed at the following path, remove its quarantine attribute:

```sh
xattr -dr com.apple.quarantine /Applications/CodeNomad.app
```

3. Launch again. For the **Not Opened** message you can instead, after the blocked launch, choose **Open Anyway** for CodeNomad in **System Settings → Privacy & Security** and confirm with your administrator password.

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

If an owned worktree or conversation placement cannot be verified, open its physical folder explicitly rather than trying arbitrary paths or editing native storage. Force-removing a worktree can destroy uncommitted files; do not use it as a connection repair.

## OpenCode runtime and WSL {#opencode-runtime}

In a launch-error dialog, choose **Open OpenCode Settings** to check the executable and version; for environment overrides, switch to **Advanced → Environment Variables**.

1. Open **Preferences → OpenCode** and check the **OpenCode version** card (installed version and running service status), then the selected executable under **OpenCode Binary**.
2. Use the supported installation/update action when the required runtime is missing. Current minimum: **2.4.2**; recommended/qualified version: **2.4.2**.
3. If the installed CLI differs from the running service, decide explicitly whether to restart the shared service.

**Restart OpenCode service** is available under **Troubleshooting** and requires confirmation. It interrupts active work in every connected client, but retains session history. Configuration reload is a separate action: it keeps the process but rebuilds loaded Locations and cancels pending questions/permissions. Neither is a harmless refresh.

For a WSL executable, confirm the intended distribution and Windows localhost forwarding. Service lifecycle runs inside Linux; CodeNomad must still reach its loopback endpoint from Windows. Never edit the service registration/database or signal guessed Linux process IDs from Windows.

## Login, TLS and direct connectivity {#login-and-tls}

| Symptom | Safe check and recovery |
| --- | --- |
| **Sign in to CodeNomad again** | Keep the page open, enter the server username/password and select **Sign in**. Recovery reconnects in place to keep drafts; it does not replay the failed action. |
| Server unreachable | Verify the backend is running and use its printed address/actual port. |
| Certificate name/trust error | Check the actual hostname/IP against certificate SANs and install the intended CA trust or a valid server certificate. Do not disable TLS verification. |
| Direct connection refused | Check effective HTTP/HTTPS binding, firewall and routing. |

Runtime passwords must be supplied on every backend start; a password saved through settings persists. See [security](security.md), [TLS/binding rules](remote-access.md) and [server reference](server.md).

## Remote Control pairing {#pairing}

1. On the host, open **Settings → Remote Access** and check Remote Control is running.
2. Create a fresh pairing link and open it on the intended device before it expires.
3. If the client shows **Pair this device again**, pair from the host, then select **Check connection** on the client.

Pairing links are single-use and short-lived; the direct-access password is not a substitute. Revoked or inactivity-expired device credentials require re-pairing. Closing the last desktop window stops its backend and therefore Remote Control; an enabled service resumes at the next application launch. See [Remote Control](remote-control.md) for unavailable host-only surfaces and revocation.

## Provider, plugin and extension state {#providers-and-addons}

- Added plugin failed or shows **Not confirmed** — Check the package name, version and registry access of the OpenCode host. Search the OpenCode log for the error reference in the plugin tooltip. **Not confirmed** also appears for a disabled plugin.
- Installed extension missing — Enable it in panel customization. Installation/replacement leaves it disabled until you explicitly activate and approve required consent.
- **Full timeline unavailable** — Read the load error for `codenomad-session-pruning` in the OpenCode log.

See [Providers](providers.md), [Integrations](integrations.md) and [Extensions](extensions.md).

## History, pending requests and cleanup {#history-and-requests}

Full-history search is not limited to the transcript rows currently loaded. A display filter hides content without deleting it; use [History](history.md) to distinguish search, compaction, technical cleanup and deletion.

For cancelled or partial cleanup, read its progress/receipts before starting another deletion. Cancelling does not undo an already dispatched batch. Do not repair history by editing the native database.

## Logs and safe diagnostics {#diagnostics}

1. Open **Settings → OpenCode → View OpenCode logs**. This reads the selected execution host’s global `opencode.log`, located with `opencode debug paths log`. It shows at most the last 128 KiB; **Refresh** rereads the file.
2. In **Preferences → OpenCode**, choose the intended **Default log level** only when more detail is needed. For standalone CodeNomad logging, use the [server CLI logging options](server.md). The CodeNomad server also keeps its own log in `logs/server.log` beside its configuration file (`~/.config/codenomad` by default); the previous full file is `server.previous.log`.
3. Open **Settings → Info → Diagnostics** and use **Report a bug**, **Copy to clipboard** or **Download .txt**.

Logging detail can expose paths, output and application data. Redact credentials, pairing links, network addresses, private paths and conversation content before sharing logs/captures. The full diagnostic report includes paths/addresses; the prefilled bug form deliberately excludes them. See [Report a bug](support.md#report-a-bug).
