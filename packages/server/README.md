# CodeNomad Server

**CodeNomad Server** is the high-performance engine behind the CodeNomad cockpit. It transforms your machine into a robust development host, managing the lifecycle of multiple OpenCode instances and providing the low-latency data streams that long-haul builders demand. It bridges your local filesystem with the UI, ensuring that whether you are on localhost or a remote tunnel, you have the speed, clarity, and control of a native workspace.

## Features & Capabilities

### 🌍 Deployment Freedom
- **Remote Access**: Host CodeNomad on a powerful workstation and access it from your lightweight laptop.
- **Code Anywhere**: Tunnel in via VPN or SSH to code securely from coffee shops or while traveling.
- **Multi-Device**: The responsive web client works on tablets and iPads, turning any screen into a dev terminal.
- **Always-On**: Run as a background service so your sessions are always ready when you connect.

### ⚡️ Workspace Power
- **Multi-Instance**: Juggle multiple OpenCode sessions side-by-side with per-instance tabs.
- **Long-Context Native**: Scroll through massive transcripts without hitches.
- **Deep Task Awareness**: Monitor background tasks and child sessions without losing your flow.
- **Command Palette**: A single, global palette to jump tabs, launch tools, and fire shortcuts.

## Prerequisites
- **OpenCode**: `opencode` must be installed and configured on your system.
- Node.js 18+ and npm (for running or building from source).
- A workspace folder on disk you want to serve.
- Optional: a Chromium-based browser if you want `--launch` to open the UI automatically.

## Usage

### Run via npx (Recommended)
You can run CodeNomad directly without installing it:

```sh
npx @neuralnomads/codenomad --launch
```

### Install Globally
Or install it globally to use the `codenomad` command:

```sh
npm install -g @neuralnomads/codenomad
codenomad --launch
```

### Common Flags
You can configure the server using flags or environment variables:

| Flag | Env Variable | Description |
|------|--------------|-------------|
| `--port <number>` | `CLI_PORT` | HTTP port (default 9898) |
| `--host <addr>` | `CLI_HOST` | Interface to bind (default 127.0.0.1) |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | Default root for new workspaces |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | Allow full-filesystem browsing |
| `--config <path>` | `CLI_CONFIG` | Config file location |
| `--launch` | `CLI_LAUNCH` | Open the UI in a Chromium-based browser |
| `--log-level <level>` | `CLI_LOG_LEVEL` | Logging level (trace, debug, info, warn, error) |
| `--username <username>` | `CODENOMAD_SERVER_USERNAME` | Username for CodeNomad's internal auth (default `codenomad`) |
| `--password <password>` | `CODENOMAD_SERVER_PASSWORD` | Password for CodeNomad's internal auth |
| `--generate-token` | `CODENOMAD_GENERATE_TOKEN` | Emit a one-time local bootstrap token for desktop flows |
| `--dangerously-skip-auth` | `CODENOMAD_SKIP_AUTH` | Disable CodeNomad's internal auth (use only behind a trusted perimeter) |

### Authentication
- Default behavior: CodeNomad requires a login (username/password) and stores a session cookie in the browser.
- `--dangerously-skip-auth` / `CODENOMAD_SKIP_AUTH=true` disables the login prompt and treats all requests as authenticated.
  Use this only when access is already protected by another layer (SSO proxy, VPN, Coder workspace auth, etc.).
  If you bind to `0.0.0.0` while skipping auth, anyone who can reach the port can access the API.

### Progressive Web App (PWA)
When running as a server CodeNomad can also be installed as a PWA from any supported browser, giving you a native app experience just like the Electron installation but executing on the remote server instead.

1. Open the CodeNomad UI in a Chromium-based browser (Chrome, Edge, Brave, etc.).
2. Click the install icon in the address bar, or use the browser menu → "Install CodeNomad".
3. The app will open in a standalone window and appear in your OS app list.

> **TLS requirement**
> Browsers require a secure (`https://`) connection for PWA installation.
> If you host CodeNomad on a remote machine, serve it behind a reverse proxy (e.g. Caddy, nginx) with a valid TLS certificate — self-signed certificates will not work.

### Data Storage
- **Config**: `~/.config/codenomad/config.json`
- **Instance Data**: `~/.config/codenomad/instances` (chat history, etc.)
