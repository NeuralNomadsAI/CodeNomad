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

To list all CLI options:

```sh
npx @neuralnomads/codenomad --help
```

On startup, CodeNomad prints two URLs:

- `Local Connection URL : ...` (used by desktop shells)
- `Remote Connection URL : ...` (used by browsers/other machines when remote access is enabled)

### Install Globally
Or install it globally to use the `codenomad` command:

```sh
npm install -g @neuralnomads/codenomad
codenomad --launch
```

### Install Locally (per-project)
If you prefer to install CodeNomad into a project and run the local binary:

```sh
npm install @neuralnomads/codenomad
npx codenomad --launch
```

(`npx codenomad ...` will use `./node_modules/.bin/codenomad` when present.)

### Common Flags
You can configure the server using flags or environment variables:

| Flag | Env Variable | Description |
|------|--------------|-------------|
| `--https <enabled>` | `CLI_HTTPS` | Enable HTTPS listener (default `true`) |
| `--http <enabled>` | `CLI_HTTP` | Enable HTTP listener (default `false`) |
| `--https-port <number>` | `CLI_HTTPS_PORT` | HTTPS port (default `9898`, use `0` for auto) |
| `--http-port <number>` | `CLI_HTTP_PORT` | HTTP port (default `9899`, use `0` for auto) |
| `--tls-key <path>` | `CLI_TLS_KEY` | TLS private key (PEM). Requires `--tls-cert`. |
| `--tls-cert <path>` | `CLI_TLS_CERT` | TLS certificate (PEM). Requires `--tls-key`. |
| `--tls-ca <path>` | `CLI_TLS_CA` | Optional CA chain/bundle (PEM) |
| `--tlsSANs <list>` | `CLI_TLS_SANS` | Additional TLS SANs (comma-separated) |
| `--host <addr>` | `CLI_HOST` | Interface to bind (default 127.0.0.1) |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | Default root for new workspaces |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | Allow full-filesystem browsing |
| `--config <path>` | `CLI_CONFIG` | Config file location |
| `--launch` | `CLI_LAUNCH` | Open the UI in a Chromium-based browser |
| `--log-level <level>` | `CLI_LOG_LEVEL` | Logging level (trace, debug, info, warn, error) |
| `--log-destination <path>` | `CLI_LOG_DESTINATION` | Log destination file (defaults to stdout) |
| `--username <username>` | `CODENOMAD_SERVER_USERNAME` | Username for CodeNomad's internal auth (default `codenomad`) |
| `--password <password>` | `CODENOMAD_SERVER_PASSWORD` | Password for CodeNomad's internal auth |
| `--generate-token` | `CODENOMAD_GENERATE_TOKEN` | Emit a one-time local bootstrap token for desktop flows |
| `--dangerously-skip-auth` | `CODENOMAD_SKIP_AUTH` | Disable CodeNomad's internal auth (use only behind a trusted perimeter) |
| `--ui-dir <path>` | `CLI_UI_DIR` | Directory containing the built UI bundle |
| `--ui-dev-server <url>` | `CLI_UI_DEV_SERVER` | Proxy UI requests to a running dev server (requires `--https=false --http=true`) |
| `--ui-no-update` | `CLI_UI_NO_UPDATE` | Disable remote UI updates |
| `--ui-auto-update <enabled>` | `CLI_UI_AUTO_UPDATE` | Enable remote UI updates (true|false) |
| `--ui-manifest-url <url>` | `CLI_UI_MANIFEST_URL` | Remote UI manifest URL |

### Update Checks (Advanced)
These environment variables control how CodeNomad checks for dev updates:

| Env Variable | Description |
|-------------|-------------|
| `CODENOMAD_UPDATE_CHANNEL` | Update channel (use `dev` to enable dev build update checks) |
| `CODENOMAD_GITHUB_REPO` | GitHub repo used for dev release checks (default `NeuralNomadsAI/CodeNomad`) |

### HTTP vs HTTPS

- Default: `--https=true --http=false` (HTTPS only).
- To run plain HTTP only (useful for development):

```sh
codenomad --https=false --http=true
```

- To run both HTTPS (for remote) and HTTP loopback (for desktop):

```sh
codenomad --https=true --http=true
```

### Remote Access Binding Rules

- When remote access is enabled (bind host is non-loopback, e.g. `--host 0.0.0.0`):
  - HTTP listens on `127.0.0.1` only.
  - HTTPS listens on `--host` (LAN/all interfaces).
- When remote access is disabled (bind host is loopback, e.g. `--host 127.0.0.1`):
  - Both HTTP and HTTPS listen on `127.0.0.1`.

### Self-Signed Certificates

If `--https=true` and you do not provide `--tls-key/--tls-cert`, CodeNomad generates a local certificate automatically under your config directory:

- `~/.config/codenomad/tls/ca-cert.pem`
- `~/.config/codenomad/tls/server-cert.pem`

Certificates are valid for about 30 days and rotate automatically on startup when needed. You can add extra SANs via:

```sh
codenomad --tlsSANs "localhost,127.0.0.1,my-hostname,192.168.1.10"
```

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
> If you host CodeNomad on a remote machine, use HTTPS. Self-signed certificates generally won't work unless they are explicitly trusted by the device/browser (e.g., via a custom CA).

### Data Storage
- **Config**: `~/.config/codenomad/config.json`
- **Instance Data**: `~/.config/codenomad/instances` (chat history, etc.)
