# OpenCode setup

## Select or install the CLI {#select-cli}

1. Open **Settings → OpenCode** and use the **OpenCode Binary** card, below **OpenCode version**, to select the executable.
2. Leave the automatic entry selected, or expand **Choose another binary…** to use **Browse for Binary…** or enter a path and choose **Add**.
3. Use **Check status and updates**. If OpenCode is missing, choose **Install and start OpenCode**; review the host and installation scope first.
4. If setup offers **Connect and continue**, use it after resolving the reported problem.

**Install for the user and configure PATH** changes that user's terminal setup; open a new terminal afterward. A browser connects to the CodeNomad server: its file picker and executable selection concern that server, not the browsing device.

When an older OpenCode comes first on PATH, the offered action depends on how it was installed. For OpenCode 1.x installed with npm, **Replace OpenCode {version} with OpenCode 2** asks for confirmation, removes that npm package and installs OpenCode 2 in the same npm folder; the OpenCode data folder is kept, and OpenCode 2 imports 1.x conversations itself. An older or unusable OpenCode installed another way (winget, Homebrew, manual) is never modified: **Install OpenCode 2 for CodeNomad** installs OpenCode 2 in the user npm folder beside it, and CodeNomad then uses that copy. If that older command itself sits in the user npm folder (for example a link in `~/.local/bin`), or that folder cannot be written, setup explains why instead of offering the action: move or rename the command, or fix the folder's permissions, then choose **Check status and updates**. A terminal's `opencode` command may still start the older version. An explicitly selected custom executable is never replaced.

The **OpenCode version** card shows **Running service** separately when it differs from **Installed version** or is unknown. **Version details** shows the minimum version and, when different, the recommended version.

## Required, recommended and unverified versions {#versions}

| Classification | Current requirement | Meaning |
| --- | --- | --- |
| Minimum | OpenCode **2.4.0** | Required for this CodeNomad release. Conversations saved by earlier versions stay readable after updating. |
| Recommended | OpenCode **2.4.1** | For CodeNomad **1.2.0**. |
| Unverified | A newer or custom version not fully validated | Not rejected merely for being untested; the connected service's actual API contracts are checked. |

## Host, WSL and shared-service scope {#execution-host}

On Windows, a selected WSL executable runs inside its chosen distribution. Install/update it there and use paths meaningful inside that distribution. WSL connectivity depends on Windows localhost forwarding. A Windows CLI and a WSL CLI are not interchangeable execution environments.

Closing a project tab closes that project in CodeNomad; sessions continue in OpenCode and reappear when you reopen the project. Closing a whole window, quitting or reloading preserves project connections for restoration; neither those actions nor backend shutdown stops the shared daemon. See [Projects](projects.md).

## Launch at startup {#login-start}

In **Settings → OpenCode**, **Launch at startup** has your operating system start the OpenCode service in the background when you sign in, even with CodeNomad closed. It is off until you turn it on, takes effect at your next sign-in and applies to your account on the computer running the CodeNomad server. It starts the executable selected in the **OpenCode Binary** card; selecting another native executable updates it, otherwise it keeps starting the previous one.

| System | What starts OpenCode | After a crash |
| --- | --- | --- |
| Windows | A hidden scheduled task for your account, without password or administrator rights. A WSL executable starts in its distribution. | Not restarted. |
| macOS | A LaunchAgent. | Restarted by macOS. |
| Linux | A systemd user service started at login, without enabling lingering. | Restarted by systemd. |

Turning it off removes only that task, LaunchAgent or service; a running OpenCode keeps running. **Unavailable on this system** appears when the CodeNomad server runs inside WSL or on another system without login start.

## Update, restart or reload {#maintenance}

1. In **Settings → OpenCode**, choose **Check status and updates**.
2. To replace installed CLI files, choose **Update to OpenCode {version}** when offered. Wait for completion.
3. Review the running-service status. Use **Restart shared service** only when you intend to activate the selected installation for every connected client.
4. For a process restart without installing anything, expand **Troubleshooting** and choose **Restart OpenCode service**, then confirm.

| Action | Scope and effect |
| --- | --- |
| Update CLI | Changes the supported installed executable; does not implicitly restart the running daemon. |
| Restart service | Replaces the shared process and interrupts active work in all connected OpenCode clients; session history remains. |
| Reload OpenCode configuration | Keeps the process. For all connected clients, cancels pending permissions/Forms, closes terminals/background commands and can interrupt active work. |

Use **Reload OpenCode configuration**, under **Troubleshooting** when the running service supports it, when a saved configuration or installed plugin remains unavailable. Review and confirm the warning: reloading can interrupt active work in all connected clients. CodeNomad will not use an older selected CLI to downgrade a newer running daemon.

## Session environment {#session-environment}

1. Open **Settings → Advanced** and expand **Environment Variables**.
2. Add overrides, edit their values or remove them. Saved names are read-only. In Rune, select a variable, edit its value, then choose **Save**.
3. Send the next prompt, custom command or session shell request through CodeNomad to apply the current environment to that conversation.

This is a configuration-profile setting. Merely opening/reading a conversation or saving settings does not alter a native session. Removing an override restores the execution host's inherited value, or removes it if absent there.

The environment controls subsequent local shell launches in that native session. Already running processes retain their environment. It does **not** reconfigure providers, MCP/LSP servers, independent terminals or Location-only background shells. Queued prompts do not each capture their own environment, and another OpenCode client can replace the same session environment. Do not assume child sessions created wholly within OpenCode receive a CodeNomad send-time update.

Allowed variables are also passed when starting a stopped service; connecting to an existing daemon does not change its process environment. In WSL, values are combined with the Linux execution environment, not Windows PATH/HOME.

## Edit native configuration files {#configuration-files}

1. Open **Settings → Config Files** and select **File**.
2. Check the displayed path, edit, then choose **Save**.
3. Use **Reload** to reread the file; this is not **Reload OpenCode configuration**.

This editor exposes only its listed global `opencode.json` and `opencode.jsonc` files under the **CodeNomad server user's** `.config/opencode` directory. It is not an arbitrary-file editor, a Project-config selector or a guarantee that a WSL/custom-discovery daemon reads that file. Use the displayed path to verify the target; use the daemon's own tooling for other roots.

Saving writes the file as text; it does not validate the entire native configuration or restart/reload OpenCode. Coordinate edits with other clients: this surface does not offer an external-change merge. Keep a copy before replacing substantial configuration. Switching files or reloading a dirty draft asks whether to discard it.

See [Integrations](integrations.md), [Providers](providers.md), [Missions](missions.md) and [OpenCode documentation](https://opencode.ai/v2/docs/) for configuration-specific workflows.
