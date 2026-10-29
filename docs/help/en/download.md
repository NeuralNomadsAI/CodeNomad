# Download CodeNomad

Free and open-source (MIT) desktop app for Windows, macOS and Linux. It connects to your OpenCode service; check the [requirements](install.md#requirements) first.

## Desktop apps {#desktop}

{{release}}

{{download-button}}

| Platform | Tauri (recommended) | Electron |
| --- | --- | --- |
| Windows 10 or later | [Installer, x64](release:tauri-windows-x64) | [ZIP, x64](release:electron-windows-x64) |
| macOS 13.5 or later | [ZIP, Apple Silicon](release:tauri-macos-arm64) · [ZIP, Intel](release:tauri-macos-x64) | [ZIP, Apple Silicon](release:electron-macos-arm64) · [ZIP, Intel](release:electron-macos-x64) |
| Linux x64 (tested on Ubuntu 24.04) | [AppImage, x64](release:tauri-linux-x64) | [Debian package, x64](release:electron-linux-x64) |

Both builds provide the same workspace. Tauri can install updates from within the app; Electron is updated by downloading a new release and supports native browser automation on every platform (Tauri on Windows only). [Compare the builds](install.md#desktop-downloads).

## Package managers {#package-managers}

On Windows, winget installs the Tauri build:

```sh
winget install NeuralNomadsAI.CodeNomad
```

To run CodeNomad as a standalone server and use it in a browser, start it with npm on a host with Node.js 24:

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

The [standalone server](server.md#run) page covers the first sign-in, global installation, addresses and authentication; the [requirements](install.md#requirements) list Node.js, Git and OpenCode.

## Install and first launch {#verify-and-install}

Download only from this page or the [official releases](https://github.com/NeuralNomadsAI/CodeNomad/releases), and never run an untrusted archive merely to bypass a warning.

- **Linux**: make the AppImage executable or install the Debian package; see [Install on Linux](install.md#linux-install).
- **macOS**: if macOS blocks the first launch, see [macOS quarantine](troubleshooting.md#macos-quarantine).
- **Every platform**: install Git and a compatible OpenCode CLI as listed in the [requirements](install.md#requirements), then [select OpenCode on first launch](install.md#first-launch). Other launch problems are covered in [troubleshooting](troubleshooting.md#desktop-launch).
