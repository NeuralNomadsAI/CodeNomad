# CodeNomad

## The AI Coding Cockpit for OpenCode

CodeNomad transforms OpenCode from a terminal tool into a **premium desktop workspace** — built for developers who live inside AI coding sessions for hours and need control, speed, and clarity.

> OpenCode gives you the engine. CodeNomad gives you the cockpit.

![Multi-instance workspace](docs/screenshots/newSession.png)

---

## Features

- **🚀 Multi-Instance Workspace**
  
  Juggle multiple projects side-by-side without losing context or switching terminals

- **🌐 Remote Access**
  
  Code from anywhere — connect from your phone, tablet, or another machine via browser

- **🧠 Session Management**
  
  Organize conversations by task, pick up right where you left off, and keep your workspace clean

- **🎙️ Voice Input & Speech**
  
  Dictate prompts naturally and listen to responses while you review code or take a break

- **🌳 Git Worktrees**
  
  Create and switch between branches in parallel without interrupting your current work

- **💬 Rich Message Experience**
  
  Read AI responses with beautiful formatting, see code changes at a glance, and scroll through massive transcripts without lag

- **⌨️ Command Palette**
  
  Navigate, configure, and control everything from your keyboard without ever reaching for the mouse

- **📁 File System Browser**
  
  Explore and edit your project files without breaking focus or leaving the app

- **🔐 Authentication & Security**
  
  Protect your workspace when exposing it to your network or running it remotely

- **🔔 Notifications**
  
  Stay aware of your sessions without watching the screen — get alerted only when it matters

- **🎨 Theming**
  
  Match your environment and reduce eye strain with automatic light and dark mode switching

- **🌍 Internationalization**
  
  Work comfortably in your preferred language with full RTL support

---

## Getting Started

### 🖥️ Desktop App

Available as both Electron and Tauri builds — choose based on your preference.

Download the latest installer for your platform from [Releases](https://github.com/shantur/CodeNomad/releases).

| Platform | Formats |
|----------|---------|
| macOS | DMG, ZIP (Universal: Intel + Apple Silicon) |
| Windows | NSIS Installer, ZIP (x64, ARM64) |
| Linux | AppImage, deb, tar.gz (x64, ARM64) |

### 💻 CodeNomad Server

Run as a local server and access via browser. Perfect for remote development.

```bash
npx @neuralnomads/codenomad --launch
```

See [Server Documentation](packages/server/README.md) for flags, TLS, auth, and remote access.

### 🧪 Dev Releases

Bleeding-edge builds from the `dev` branch:

```bash
npx @neuralnomads/codenomad-dev --launch
```

---

## Requirements

- **[OpenCode CLI](https://opencode.ai)** — must be installed and in your `PATH`
- **Node.js 18+** — for server mode or building from source

---

## Development

CodeNomad is a monorepo built with:

| Package | Description |
|---------|-------------|
| **[packages/server](packages/server/README.md)** | Core logic & CLI — workspaces, OpenCode proxy, API, auth, speech |
| **[packages/ui](packages/ui/README.md)** | SolidJS frontend — reactive, fast, beautiful |
| **[packages/electron-app](packages/electron-app/README.md)** | Desktop shell — process management, IPC, native dialogs |
| **[packages/tauri-app](packages/tauri-app)** | Tauri desktop shell (experimental) |

### Quick Start

```bash
git clone https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
npm install
npm run dev
```

---

## Troubleshooting

<details>
<summary><strong>macOS: "CodeNomad.app is damaged and can't be opened"</strong></summary>

Gatekeeper flag due to missing notarization. Clear the quarantine attribute:

```bash
xattr -dr com.apple.quarantine /Applications/CodeNomad.app
```

On Intel Macs, also check **System Settings → Privacy & Security** on first launch.
</details>

<details>
<summary><strong>Linux (Wayland + NVIDIA): Tauri App closes immediately</strong></summary>

WebKitGTK DMA-BUF/GBM issue. Run with:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 codenomad
```

See full workaround in the original README.
</details>

---

## Community

[![Star History](https://api.star-history.com/svg?repos=NeuralNomadsAI/CodeNomad&type=Date)](https://star-history.com/#NeuralNomadsAI/CodeNomad&Date)

---

**Built with ♥ by [Neural Nomads](https://github.com/NeuralNomadsAI)** · [MIT License](LICENSE)
