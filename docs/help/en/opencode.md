# OpenCode setup

CodeNomad connects to a shared OpenCode service on the execution host. Selecting a CLI, updating its files, restarting that service and reloading configuration are different operations; none is a substitute for the others.

## Select or install the CLI {#select-cli}

1. Open **Settings → OpenCode** and use the **OpenCode Binary** card, below **OpenCode version**, to select the executable.
2. Leave the automatic entry selected to prefer the server's PATH, unless it holds an older OpenCode, then its user npm OpenCode 2 installation; or use **Browse for Binary…** or enter a path and choose **Add**.
3. Use **Check status and updates**. If OpenCode is missing, choose **Install and start OpenCode**; review the host and installation scope first.
4. If setup offers **Connect and continue**, use it after resolving the reported problem.

Installation uses bundled Node/npm for a standard user installation shared with other clients. **Install for the user and configure PATH** changes that user's terminal setup; open a new terminal afterward. A browser connects to the CodeNomad server: its file picker and executable selection concern that server, not the browsing device.

When an older OpenCode comes first on PATH, the offered action depends on how it was installed. For OpenCode 1.x installed with npm, **Replace OpenCode {version} with OpenCode 2** asks for confirmation, removes that npm package and installs OpenCode 2 in the same npm folder; the OpenCode data folder is kept, and OpenCode 2 imports 1.x conversations itself. An older or unusable OpenCode installed another way (winget, Homebrew, manual) is never modified: **Install OpenCode 2 for CodeNomad** installs OpenCode 2 in the user npm folder beside it, and CodeNomad then uses that copy. A terminal's `opencode` command may still start the older version. An explicitly selected custom executable is never replaced.

The installed executable and the running service can have different versions. Compare **Installed version** with **Running service** in the **OpenCode version** card rather than assuming that selecting another executable has replaced the live daemon; **Version details** lists the minimum and recommended versions. If installation is busy or the executable is locked, wait for the installer or process to release it and check status before retrying; do not run competing installers.

## Required, recommended and unverified versions {#versions}

| Classification | Current requirement | Meaning |
| --- | --- | --- |
| Minimum | OpenCode **2.1.0** | Required native transcript, replay and compaction format; conversations saved by earlier versions stay readable after updating. |
| Recommended | OpenCode **2.1.1** | Qualified target, distinct from the technical minimum. |
| Unverified | A newer or custom version not fully validated | Not rejected merely for being untested; the connected service's actual API contracts are checked. |

The required session, permission, Form, inbox and session-environment contracts must also be available. An executable version alone does not prove that the connected service supports them. If setup reports an unsupported running service, select/install a supported CLI and use the explicit shared-service restart when ready.

## Host, WSL and shared-service scope {#execution-host}

On Windows, a selected WSL executable runs inside its chosen distribution. Install/update it there and use paths meaningful inside that distribution. WSL connectivity depends on Windows localhost forwarding. A Windows CLI and a WSL CLI are not interchangeable execution environments.

OpenCode owns its global service registration, sessions, messages and database. CodeNomad does not create a private OpenCode database per window or project. Closing a project tab closes that project in CodeNomad; sessions continue in OpenCode and reappear when you reopen the project. CodeNomad never unloads native Locations. Closing a whole window, quitting or reloading preserves project connections for restoration; neither those actions nor backend shutdown stops the shared daemon. See [Projects](projects.md).

## Update, restart or reload {#maintenance}

1. In **Settings → OpenCode**, choose **Check status and updates**.
2. To replace installed CLI files, choose **Update to OpenCode {version}** when offered. Wait for completion.
3. Review the running-service status. Use **Restart shared service** only when you intend to activate the selected installation for every connected client.
4. For a process restart without installing anything, expand **Troubleshooting** and choose **Restart OpenCode service**, then confirm.

| Action | Scope and effect | Safe recovery |
| --- | --- | --- |
| Update CLI | Changes the supported installed executable; does not implicitly restart the running daemon. | Check both installed and running versions after a failure; retry explicitly only after resolving the error. |
| Restart service | Replaces the shared process and interrupts active work in all connected OpenCode clients; session history remains. | Reconnect and inspect conversations and scheduled Missions; a restart is not automatic continuation. |
| Reload OpenCode configuration | Keeps the process but rebuilds **every loaded Location** for all clients. Cancels pending permissions/Forms and closes terminals/background commands; active work may be interrupted. | Recheck resources and pending work after reload. Do not repeat a prompt or mutation merely because its reply was lost. |

Use **Reload OpenCode configuration**, under **Troubleshooting** when the running service supports it, explicitly when a saved configuration or installed plugin remains unavailable and the disruption is acceptable. It is not a harmless display refresh. CodeNomad will not use an older selected CLI to downgrade a newer running daemon.

## Session environment {#session-environment}

1. Open **Settings → Advanced** and expand **Environment Variables**.
2. Add, change or remove the profile's overrides; each change is saved immediately.
3. Send the next prompt, custom command or session shell request through CodeNomad to apply the current environment to that conversation.

This is a configuration-profile setting, applied server-side before each send. Merely opening/reading a conversation or saving settings does not alter a native session. Removing an override restores the execution host's inherited value, or removes it if absent there. Failure to apply the environment blocks the send instead of using stale values.

The environment controls subsequent local shell launches in that native session. Already running processes retain their environment. It does **not** reconfigure providers, MCP/LSP servers, independent terminals or Location-only background shells. Queued prompts do not each capture their own environment, and another OpenCode client can replace the same session environment. Do not assume child sessions created wholly within OpenCode receive a CodeNomad send-time update.

Allowed variables are also passed when starting a stopped service; connecting to an existing daemon does not change its process environment. In WSL, values are combined with the Linux execution environment, not Windows PATH/HOME. Changing these overrides does not relocate OpenCode's database or service registration.

## Edit native configuration files {#configuration-files}

1. Open **Settings → Config Files** and select **File**.
2. Check the displayed path, edit, then choose **Save**.
3. Use **Reload** to reread the file; this is not **Reload OpenCode configuration**.

This editor exposes only its listed global `opencode.json` and `opencode.jsonc` files under the **CodeNomad server user's** `.config/opencode` directory. It is not an arbitrary-file editor, a Project-config selector or a guarantee that a WSL/custom-discovery daemon reads that file. Use the displayed path to verify the target; use the daemon's own tooling for other roots.

Saving writes the file as text; it does not validate the entire native configuration or restart/reload OpenCode. Coordinate edits with other clients: this surface does not offer an external-change merge. Keep a copy before replacing substantial configuration. Switching files or reloading a dirty draft asks whether to discard it.

See [Integrations](integrations.md), [Providers](providers.md), [Missions](missions.md) and [OpenCode documentation](https://opencode.ai/v2/docs/) for configuration-specific workflows.
