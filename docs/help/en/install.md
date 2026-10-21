# Install CodeNomad

Choose a local desktop host or run the [standalone server](server.md). In both cases, OpenCode owns the shared native service and history.

## Desktop downloads {#desktop-downloads}

1. Open [the latest release](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest).
2. Choose the build matching your operating system and processor.
3. Extract the ZIP or install/run the platform package, then launch CodeNomad.

| Platform | Electron release | Tauri release | Platform notes |
| --- | --- | --- | --- |
| macOS | ZIP, Intel or Apple Silicon | ZIP, Intel or Apple Silicon | macOS 13.5 or later is required by the bundled runtime. |
| Windows | ZIP, x64 | Installer, x64 | Windows 10 or later; Tauri uses WebView2. |
| Linux | Debian package, x64 | AppImage, x64 | Built and tested on Ubuntu 24.04; compatibility with older distributions is not guaranteed. |

Desktop releases include the runtime resources needed by the backend and OpenCode installer, so you do not need a separate Node.js/npm installation to use them. Git is not bundled. Native browser automation is supported in Electron and Windows Tauri; other Tauri platforms use iframe previews.

For a verified download blocked at launch, see [platform troubleshooting](troubleshooting.md#desktop-launch). Never run an untrusted archive merely to bypass a warning.

## Install on Linux {#linux-install}

From the folder containing your downloaded release, substitute its actual version and filename:

```sh
sudo apt install ./CodeNomad-Electron-linux-x64-<version>.deb
```

For the Tauri AppImage:

```sh
chmod +x CodeNomad-Tauri-linux-x64-<version>.AppImage
./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

If FUSE is unavailable, use the AppImage's extraction-and-run mode:

```sh
./CodeNomad-Tauri-linux-x64-<version>.AppImage --appimage-extract-and-run
```

The Electron Debian installation configures Chromium's sandbox. Do not disable the sandbox as an installation workaround. Linux Tauri graphics issues have a [targeted WebKit workaround](troubleshooting.md#desktop-launch).

## Requirements {#requirements}

| Requirement | Where it must be available | Current requirement |
| --- | --- | --- |
| OpenCode CLI | Selected execution host, including the selected WSL distribution where applicable | Minimum **2.1.0**; **2.1.1** is the recommended/qualified target. Newer or custom versions undergo contract validation rather than an untested-version ban. |
| Git | CodeNomad backend account's `PATH` | Required for repository identity, Git operations and worktrees. |
| Node.js/npm | Standalone-server and source-build host | Node.js 24 LTS; reproducible source builds use `.node-version` (**24.20.0**). Bundled with desktop runtime/installation resources. |
| Workspace folder | Backend-accessible disk | An explicitly opened physical folder, not a device-local folder inferred by a remote browser. |

On Windows, install [Git for Windows](https://gitforwindows.org/) with command-line/third-party access enabled. A user-writable, per-user installation is sufficient. On macOS/Linux, use [Git's platform instructions](https://git-scm.com/downloads).

After changing `PATH`, fully quit and relaunch the desktop app, or restart the standalone backend under the intended account. Reloading a browser does not update the backend environment. Git available only inside WSL does not satisfy a Windows backend's Git requirement.

Without Git, you can still open a physical folder and use directory-only conversations, including asking the agent for installation help. Repository/worktree operations remain unavailable; session access stays limited to that exact folder. CodeNomad tells the agent about backend Git availability before prompts/custom commands and removes that advisory after recovery. The agent's execution host can differ from the backend host, so install Git for the backend, not only for the agent's shell.

## Select OpenCode on first launch {#first-launch}

1. In setup, choose a compatible existing executable or use the offered OpenCode installation action.
2. Verify the runtime status before opening a project.
3. Revisit **Preferences → OpenCode** to manage the executable, installation and shared service separately.

CodeNomad prefers compatible executables on `PATH` and supports an explicitly selected executable. If `PATH` starts an older OpenCode, setup offers to replace an npm-installed OpenCode 1.x after confirmation, or to install OpenCode 2 for CodeNomad beside an installation made another way, which it never modifies; see [OpenCode setup](opencode.md#select-cli). Installing/updating a CLI does not silently restart an already running shared service. See [OpenCode setup](opencode.md) for restart/reload consequences, WSL and session environment.

## Use a browser instead {#browser-install}

Install Node.js/npm, Git and OpenCode on the server host, then use the [server launch procedures](server.md). Connect with the printed address, configured authentication and a trusted certificate. A browser/PWA needs a live backend; it is not an offline copy of your projects.

For ports, bindings and TLS, use [direct access](remote-access.md). To pair a device without opening inbound ports, use [Remote Control](remote-control.md). For development and packaging commands, see [source builds](support.md#build-from-source).
