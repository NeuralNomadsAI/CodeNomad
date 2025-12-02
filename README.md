# CodeNomad

## A fast, multi-instance workspace for running OpenCode sessions.

CodeNomad is built for people who live inside OpenCode for hours on end and need a cockpit, not a kiosk. It delivers a premium, low-latency workspace that favors speed, clarity, and direct control.

![Multi-instance workspace](docs/screenshots/newSession.png)
_Manage multiple OpenCode sessions side-by-side._

<details>
<summary>📸 More Screenshots</summary>

![Command palette overlay](docs/screenshots/command-palette.png)
_Global command palette for keyboard-first control._

![Image Previews](docs/screenshots/image-previews.png)
_Rich media previews for images and assets._

![Browser Support](docs/screenshots/browser-support.png)
_Browser support via CodeNomad Server._

</details>

## Getting Started

Choose the way that fits your workflow:

### 🖥️ Desktop App (Recommended)
The best experience. A native application (Electron-based) with global shortcuts, deeper system integration, and a dedicated window.

- **Download**: Grab the latest installer for macOS, Windows, or Linux from the [Releases Page](https://github.com/shantur/CodeNomad/releases).
- **Run**: Install and launch like any other app.

### 🦀 Tauri App (Experimental)
We are also working on a lightweight, high-performance version built with [Tauri](https://tauri.app). It is currently in active development.

- **Download**: Experimental builds are available on the [Releases Page](https://github.com/shantur/CodeNomad/releases).
- **Source**: Check out `packages/tauri-app` if you're interested in contributing.

### 💻 CodeNomad Server
Run CodeNomad as a local server and access it via your web browser. Perfect for remote development (SSH/VPN) or running as a service.

```bash
npx @neuralnomads/codenomad --launch
```

This command starts the server and opens the web client in your default browser.

## Highlights

- **Multi-Instance**: Juggle several OpenCode sessions side-by-side with tabs.
- **Long-Session Native**: Scroll through massive transcripts without hitches.
- **Command Palette**: A single global palette to jump tabs, launch tools, and control everything.
- **Deep Task Awareness**: Monitor background tasks and child sessions without losing flow.

## Requirements

- **[OpenCode CLI](https://opencode.ai)**: Must be installed and available in your `PATH`.
- **Node.js 18+**: Required if running the CLI server or building from source.

## Troubleshooting

### macOS says the app is damaged
If macOS reports that "CodeNomad.app is damaged and can't be opened," Gatekeeper flagged the download because the app is not yet notarized. You can clear the quarantine flag after moving CodeNomad into `/Applications`:

```bash
xattr -l /Applications/CodeNomad.app
xattr -dr com.apple.quarantine /Applications/CodeNomad.app
```

After removing the quarantine attribute, launch the app normally. On Intel Macs you may also need to approve CodeNomad from **System Settings → Privacy & Security** the first time you run it.

## Architecture & Development

CodeNomad is a monorepo split into specialized packages. If you want to contribute or build from source, check out the individual package documentation:

| Package | Description |
|---------|-------------|
| **[packages/electron-app](packages/electron-app/README.md)** | The native desktop application shell. Wraps the UI and Server. |
| **[packages/server](packages/server/README.md)** | The core logic and CLI. Manages workspaces, proxies OpenCode, and serves the API. |
| **[packages/ui](packages/ui/README.md)** | The SolidJS-based frontend. Fast, reactive, and beautiful. |

### Quick Build
To build the Desktop App from source:

1.  Clone the repo.
2.  Run `npm install` (requires pnpm or npm 7+ for workspaces).
3.  Run `npm run build --workspace @neuralnomads/codenomad-electron-app`.
