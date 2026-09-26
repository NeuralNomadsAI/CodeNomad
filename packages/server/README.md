# CodeNomad Server

**CodeNomad Server** connects the desktop and browser UI to your projects and one shared OpenCode V2 background service. It provides workspace access, Git operations, authentication, and live event delivery. OpenCode owns the sessions, messages, and agent execution; closing CodeNomad leaves the shared OpenCode service running.

## Features & Capabilities

### 🌍 Deployment Freedom

- **Remote Access**: Host CodeNomad on a powerful workstation and access it from your lightweight laptop.
- **Code Anywhere**: Tunnel in via VPN or SSH to code securely from coffee shops or while traveling.
- **Multi-Device**: The responsive web client works on tablets and iPads, turning any screen into a dev terminal.
- **Always-On**: Run as a background service so your sessions are always ready when you connect.

### ⚡️ Workspace Power

- **Multiple projects**: Work across project tabs and sessions over the same OpenCode service.
- **Long conversations**: Bounded transcript loading, full-history search, and timeline navigation.
- **Deep Task Awareness**: Monitor background tasks and child sessions without losing your flow.
- **Command Palette**: A single, global palette to jump tabs, launch tools, and fire shortcuts.

## Prerequisites

- **Git**: A prerequisite in the backend process's `PATH` for repository identity, Git operations and worktree management. Without Git, directory-only conversations in the explicitly opened physical folder remain available so the user can ask the agent for installation help. Owned session prompts/custom commands update the native `codenomad.git-availability` instruction; it reports the backend platform and is removed when Git becomes available. Git/worktree operations still fail explicitly with `503`/`git_required`. Install from https://git-scm.com/downloads and restart the backend after changing `PATH`. A Windows per-user installation is sufficient; Git inside WSL alone is insufficient for a Windows backend.
- **OpenCode V2**: For CodeNomad 0.20.0, install `opencode` **2.0.7 or later**, with **2.0.16 recommended and qualified**. The npm package is `@opencode/cli`; see the [V2 installation guide](https://opencode.ai/v2/docs/). CodeNomad prefers the CLI on `PATH` and also supports an explicitly selected executable. It uses the official service lifecycle and validates authenticated daemon metadata and API compatibility. V1 and former V2 beta runtimes are unsupported; custom/prerelease versions are unverified and still undergo contract validation. See [`runtime-support.ts`](src/opencode/runtime-support.ts) for the current requirements.
- **OpenCode data**: The global daemon owns its platform-default storage, database, and service registration. Configured startup environment applies only when CodeNomad starts a missing daemon; an existing daemon is unchanged.
- **Windows to WSL**: A configured WSL UNC binary uses Linux `service status`, `service start`, and `service get password`; Windows must have WSL localhost forwarding enabled to reach its loopback service.
- **Node.js and npm**: Use Node.js 24 LTS for the standalone server; source and release builds use [`.node-version`](../../.node-version) (currently 24.20.0). Desktop distributions bundle Node/npm.
- A workspace folder on disk you want to serve.
- Optional: a Chromium-based browser if you want `--launch` to open the UI automatically.

## Usage

### Run via npx (Recommended)

You can run CodeNomad directly without installing it:

```sh
npx @neuralnomads/codenomad --password <your-password> --launch
```

> **Authentication required:** The server requires a password. Pass it via `--password`, the `CODENOMAD_SERVER_PASSWORD` environment variable, or create an `auth.json` file (see [Authentication](#authentication) below).

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
codenomad --password <your-password> --launch
```

### Install Locally (per-project)

If you prefer to install CodeNomad into a project and run the local binary:

```sh
npm install @neuralnomads/codenomad
npx codenomad --password <your-password> --launch
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
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | Restricts the root path where new workspaces can be opened. Git worktrees are created in `.codenomad/worktrees` inside the project folder. |
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
| `--ui-auto-update <enabled>` | `CLI_UI_AUTO_UPDATE` | Enable remote UI updates (`true`) |
| `--ui-manifest-url <url>` | `CLI_UI_MANIFEST_URL` | Remote UI manifest URL |

### Dev Releases (Advanced)

If you want the latest bleeding-edge builds (published as GitHub pre-releases), use the dev package:

```sh
npx @neuralnomads/codenomad-dev --password <your-password> --launch
```

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

> **Browser warning:** Self-signed certificates trigger a "Your connection is not private" warning in browsers on first visit. This is expected and safe for local development (127.0.0.1 / localhost):
> 
> 1. **Chrome/Brave/Edge:** Click **Advanced** → **Proceed to 127.0.0.1 (unsafe)**
> 2. **Firefox:** Click **Advanced** → **Accept the Risk and Continue**
> 3. **Alternative:** For local-only development without the warning, run with `--https=false --http=true`
> 
> **Note:** Only accept self-signed certificates for localhost/127.0.0.1 that you control. For remote hosts, use proper TLS certificates.

### Authentication

- Default behavior: CodeNomad requires a login (username/password) and stores a session cookie in the browser.
- `--dangerously-skip-auth` / `CODENOMAD_SKIP_AUTH=true` disables the login prompt and treats all requests as authenticated.
  Use this only when access is already protected by another layer (SSO proxy, VPN, Coder workspace auth, etc.).
  If you bind to `0.0.0.0` while skipping auth, anyone who can reach the port can access the API.

#### Setting a password

**Practical setup options:**

1. **Runtime password (every start):** Use `--password <your-password>` or set `CODENOMAD_SERVER_PASSWORD=<your-password>` environment variable
2. **Persistent password (UI setup):** Launch with `--generate-token`, complete the local bootstrap flow in your browser, then set a password through the UI settings

The `--password` flag and `CODENOMAD_SERVER_PASSWORD` env var are **runtime credentials** — they must be provided on every server start and are not persisted to disk.

**Advanced: `auth.json` internals**

The `auth.json` file (`~/.config/codenomad/auth.json`) is automatically created and managed by CodeNomad when you set a password through the UI. You generally don't need to edit this file manually. For reference, it uses the following scrypt-based schema:

```json
{
  "version": 1,
  "username": "codenomad",
  "password": {
    "algorithm": "scrypt",
    "saltBase64": "<base64-salt>",
    "hashBase64": "<base64-hash>",
    "keyLength": 64,
    "params": {
      "N": 16384,
      "r": 8,
      "p": 1,
      "maxmem": 33554432
    }
  },
  "userProvided": true,
  "updatedAt": "2026-05-18T12:00:00.000Z"
}
```

Manual creation of this file is not recommended unless you have a helper to generate a valid scrypt `PasswordHashRecord`.

### Progressive Web App (PWA)

When running as a server CodeNomad can also be installed as a PWA from any supported browser, giving you a native app experience just like the Electron installation but executing on the remote server instead.

1. Open the CodeNomad UI in a Chromium-based browser (Chrome, Edge, Brave, etc.).
2. Click the install icon in the address bar, or use the browser menu → "Install CodeNomad".
3. The app will open in a standalone window and appear in your OS app list.

> **TLS requirement**
> Browsers require a secure (`https://`) connection for PWA installation.
> If you host CodeNomad on a remote machine, use HTTPS. Self-signed certificates generally won't work unless they are explicitly trusted by the device/browser (e.g., via a custom CA).

### Data Storage

- **Stable server configuration**: `~/.config/codenomad/config.yaml`
- **Mutable server state**: `~/.config/codenomad/state.yaml`
- **Legacy migration input**: `~/.config/codenomad/config.json` is migrated to the YAML files above.
- **CodeNomad instance data**: `~/.config/codenomad/instances/`
- **OpenCode V2 sessions, messages, and service registration**: OpenCode's platform-default global locations.
- **Desktop restore state**: `~/.codenomad/client-state/v2/`

CodeNomad owns no private OpenCode port, database, service registration, or daemon PID. Allowed profile environment variables and the current `NODE_EXTRA_CA_CERTS` are passed when starting a missing daemon; connecting to an existing daemon does not change its process environment. Separately, CodeNomad applies the profile's complete execution-host environment to the native session before each prompt, custom command, or session shell request, including removal of previously configured values. Legacy `OPENCODE_DB` and `XDG_STATE_HOME` ownership variables are ignored. See [Session Environment](../../dev-docs/SESSION_ENVIRONMENT.md). WSL lifecycle commands run inside Linux and never inspect or signal Linux PIDs from Windows.

Explicit **Stop Workspace** evicts that location and its resources from the global service without stopping the daemon. Closing a UI tab or native window only detaches local state and never evicts. Backend shutdown clears only CodeNomad's in-memory connection state and never stops the global service.

### Event Delivery

CodeNomad holds one shared OpenCode V2 `client.event.subscribe()` stream. It routes native location-scoped events to logical workspaces and multiplexes them with CodeNomad events over `GET /api/events` for browser `EventSource` clients.

The stream is volatile and has no replay guarantee. After reconnecting, clients must refetch authoritative sessions and pending permission and Form requests; file and config consumers must also refetch after `filesystem.changed` and `config.updated` invalidations.

### Provider Plan Usage

The Status panel automatically displays quota information for the provider used by the active session. CodeNomad reads existing OpenCode and Codex CLI credential files but never modifies them or returns provider secrets through its API. Expired externally owned OAuth sessions must be refreshed by OpenCode or Codex CLI; CodeNomad does not exchange their refresh tokens, so refresh-token rotation cannot be lost.

Some optional usage integrations require credentials that OpenCode does not expose. They can be enabled without UI configuration through these environment variables:

- Cursor access token: `CURSOR_ACCESS_TOKEN` or `CURSOR_TOKEN`
- Ollama Cloud: `OLLAMA_CLOUD_COOKIE`
- OpenCode Go: `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE`
