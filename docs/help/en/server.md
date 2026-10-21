# Standalone server

Run CodeNomad where your projects and tools live, then use its browser UI locally or remotely. The backend supplies filesystem access, Git operations, authentication and event delivery. OpenCode's shared service owns conversations and execution; it is not a child server to stop when a browser disconnects.

The same UI supports [multiple project tabs and worktrees](projects.md), [conversation families and background activity](conversations.md), [bounded history loading, search and timeline navigation](history.md), and a [command palette and shortcuts](shortcuts.md). Browser and tablet access do not move execution off the host.

## Prepare the host {#prerequisites}

1. Install Node.js 24 LTS and npm; the repository's pinned build runtime is 24.20.0. Desktop packages include Node/npm.
2. Put Git on the **backend process's PATH**. Git inside WSL alone does not satisfy a Windows backend.
3. Install or select OpenCode: the required minimum is **2.1.2**, with **2.1.2** the recommended qualification target. Newer or custom builds undergo compatibility checks, not a tested-version allowlist. See [OpenCode setup](opencode.md).
4. Choose the folder from which to start the server, or pass `--workspace-root` explicitly.

Without Git, conversations remain available only in the explicitly opened physical folder; Git and worktree operations fail. Install Git and restart the backend after a PATH change. A workspace root limits opening/browsing, not agent execution: see [Security](security.md).

## Run or install {#run}

Choose one installation method. These first-run examples use a local bootstrap rather than putting a password into shell history:

### Run with npx {#npx}

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

### Install globally {#global-install}

```sh
npm install -g @neuralnomads/codenomad
codenomad --generate-token --launch
```

### Install in a project {#local-install}

```sh
npm install @neuralnomads/codenomad
npx codenomad --generate-token --launch
```

`npx codenomad` uses the project's installed binary when present. This installs the package in that project; it does **not** make configuration or OpenCode storage project-local.

1. Open the printed **Local Connection URL** on the host. Complete [local bootstrap](security.md), then save a persistent server password. That procedure includes a loopback-only HTTP setup option if you have not configured HTTPS trust yet.
2. On subsequent starts, omit `--generate-token`; alternatively supply `CODENOMAD_SERVER_PASSWORD` on every start.
3. Use `codenomad --help` to inspect the installed CLI's options.

The commands run in the foreground. Closing the terminal or sending Ctrl+C stops that backend and its Remote Control connection. `--launch` only opens a browser; it does not daemonize the server. For unattended availability, run the same command under your OS process/service manager with explicit configuration, working directory, environment and restart policy. Do not put secrets in service logs or a public unit file.

Closing a browser does not stop a separately running standalone backend. Closing a project tab removes that project's CodeNomad connection, but sessions continue in OpenCode; reopen the project to find them again. CodeNomad never unloads its native Location. Closing a whole window, quitting or reloading preserves project connections for restoration. Backend shutdown likewise leaves the OpenCode service running. Backend-dependent features are unavailable until CodeNomad returns; see [Missions](missions.md) for the separate native scheduling lifetime.

## Addresses and ports {#addresses}

Startup prints **Local Connection URL**, and **Remote Connection URL** when one is available, plus **Other Accessible URLs** where applicable. Use the printed scheme and port, not a guessed address. A loopback URL is reachable only on that machine; a printed LAN address still requires routing and firewall access.

HTTPS prefers port **9898** and HTTP prefers **9899**. With no port override, an occupied preferred port falls back to an OS-assigned port. An explicit nonzero port does not fall back; `0` requests an OS-assigned port. Ports accept integers from 0 through 65535.

For listener exposure, certificates, VPN/SSH and reverse proxies, use [Direct remote access](remote-access.md). For access without an inbound port, use [Remote Control](remote-control.md).

## Public CLI reference {#cli-reference}

Flags override their environment counterparts. Value-taking flags use the shown argument; switches do not. HTTPS/HTTP values recognize `1`, `true`, `yes`, `y` and `on` as enabled, case-insensitively; use explicit `true`/`false` for clarity. UI auto-update recognizes `1`, `true` and `yes`.

**Strict boolean environment variables** (`CLI_UNRESTRICTED_ROOT`, `CLI_UI_NO_UPDATE`, `CLI_LAUNCH`, `CODENOMAD_GENERATE_TOKEN` and `CODENOMAD_SKIP_AUTH`) enable their switches with `1`, `true`, `yes` or `on`, ignoring case and surrounding whitespace. `0`, `false`, `no`, `off`, empty/whitespace-only values or unset variables leave the switches off. Any other value prevents server startup, even with the corresponding CLI flag. A CLI flag enables its switch over a valid off value; otherwise, the `false` defaults below apply.

| Flag | Environment | Default and effect |
| --- | --- | --- |
| `-h, --help` | — | Print help and exit. |
| `-v, --version` | — | Print the installed package version and exit. |
| `--host <host>` | `CLI_HOST` | `127.0.0.1`; `localhost` normalizes to IPv4 loopback. IPv6 zone identifiers are rejected. See the [binding matrix](remote-access.md). |
| `--https <enabled>` | `CLI_HTTPS` | `true`; HTTPS listener. |
| `--http <enabled>` | `CLI_HTTP` | `false`; HTTP listener. At least one listener must be enabled. |
| `--https-port <number>` | `CLI_HTTPS_PORT` | `9898` preferred; `0` automatic. |
| `--http-port <number>` | `CLI_HTTP_PORT` | `9899` preferred; `0` automatic. |
| `--tls-key <path>` | `CLI_TLS_KEY` | Unset; PEM private key, requires `--tls-cert`. |
| `--tls-cert <path>` | `CLI_TLS_CERT` | Unset; PEM certificate, requires `--tls-key`. |
| `--tls-ca <path>` | `CLI_TLS_CA` | Unset; optional PEM CA chain for supplied certificates. |
| `--tlsSANs <list>` | `CLI_TLS_SANS` | Unset; additional comma-separated DNS names/IPs for generated certificates. |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | Process working directory; root for opening workspaces. |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | `false`; allow full-filesystem browsing. Not an agent sandbox setting. |
| `--config <path>` | `CLI_CONFIG` | Resolved active default: `~/.config/codenomad/config.yaml`. Accepts a directory or YAML file for explicit placement. |
| `--log-level <level>` | `CLI_LOG_LEVEL` | `info`; documented levels: `trace`, `debug`, `info`, `warn`, `error`. |
| `--log-destination <path>` | `CLI_LOG_DESTINATION` | `stdout`; otherwise write to the chosen file. |
| `--username <username>` | `CODENOMAD_SERVER_USERNAME` | `codenomad`; runtime auth username. A stored auth file retains its stored username when no runtime password overrides it. |
| `--password <password>` | `CODENOMAD_SERVER_PASSWORD` | Unset; runtime-only password, takes precedence over the managed auth file. |
| `--auth-cookie-name <name>` | `CODENOMAD_AUTH_COOKIE_NAME` | `codenomad_session`; characters outside letters, digits, `_` and `-` become `_`. |
| `--generate-token` | `CODENOMAD_GENERATE_TOKEN` | `false`; print a one-use, 60-second local bootstrap token. |
| `--dangerously-skip-auth` | `CODENOMAD_SKIP_AUTH` | `false`; disables direct-listener authentication. Dangerous: see [Security](security.md). Remote Control still requires device pairing. |
| `--ui-dir <path>` | `CLI_UI_DIR` | Package's `public` directory; an explicit override serves that UI instead of remote UI resolution. |
| `--ui-dev-server <url>` | `CLI_UI_DEV_SERVER` | Unset; proxy UI through the HTTP listener. For development, use `--https=false --http=true`; the HTTPS listener does not proxy the dev UI. |
| `--ui-no-update` | `CLI_UI_NO_UPDATE` | `false`; overrides auto-update and uses available cached/bundled UI. |
| `--ui-auto-update <enabled>` | `CLI_UI_AUTO_UPDATE` | `true`; check for compatible remote UI at startup. |
| `--ui-manifest-url <url>` | `CLI_UI_MANIFEST_URL` | `https://ui.codenomad.neuralnomads.ai/version.json`; remote UI manifest. |
| `--launch` | `CLI_LAUNCH` | `false`; open the local UI in a browser after startup. |
| `--upgrade [version]` | — | No upgrade by default. When requested, globally install `@neuralnomads/codenomad@latest`, or the supplied version, and exit. |

The public reference lists user-facing options; desktop hosts manage their own private launch coordination.

### Additional deployment environment {#deployment-environment}

| Variable | Default and scope |
| --- | --- |
| `CODENOMAD_GITHUB_REPO` | `NeuralNomadsAI/CodeNomad`; repository queried for release offers. |
| `CODENOMAD_REMOTE_CONTROL_API` | Unset: hosted OpenTunnel API. Set an API origin for a self-hosted relay deployment. |
| `NODE_EXTRA_CA_CERTS` | Node's optional additional CA file; passed with allowed startup environment when starting a missing OpenCode daemon. Does not change an already running daemon. |

Provider-specific usage credentials are covered in [Providers](providers.md). Desktop data-profile selection is covered in [Desktop](desktop.md), not controlled by the release feed.

## Configuration and storage ownership {#storage}

Default paths below use the backend user's home. An explicit `--config` directory changes the configuration base; a YAML filename selects that file with sibling state/storage. Use one intentional configuration identity for a deployment and protect the whole directory with OS permissions.

| Owner/data | Default location or rule |
| --- | --- |
| Stable CodeNomad preferences | `~/.config/codenomad/config.yaml` |
| Mutable CodeNomad state | `~/.config/codenomad/state.yaml` |
| CodeNomad instance metadata | `~/.config/codenomad/instances/` |
| Password hash | `auth.json` beside the active YAML configuration; app-managed. |
| Generated TLS certificates and private keys | `tls/` under the configuration base. |
| Remote Control route, enabled choice and device hashes | `remote-control-devices.json` under the configuration base. |
| Temporary workspace registry and folders | `temporary-workspaces.json` and `temporary-workspaces/` under that base. |
| Installed panel extensions and permission receipts | `panel-extensions/` and `permission-receipts/` under that base. |
| Downloaded UI cache | `~/.config/codenomad/ui/`; the CLI's UI resolver uses this home-based cache even with a custom `--config`. |
| OpenCode conversations, messages, service registration and provider connections | OpenCode's own global storage on the execution host, not the CodeNomad instance directory. |
| Desktop restore state | Default `~/.codenomad/client-state/v2/`; see [Desktop](desktop.md) for profile/window scope. |

CodeNomad connects to the existing shared daemon or starts it if missing. Startup environment affects a newly started daemon only. Separately, the configured complete session environment is applied before each prompt, custom command or session shell request, not when preferences are merely viewed or edited. See [OpenCode setup](opencode.md).

## Events and reconnects {#events}

The backend consumes a shared native OpenCode event stream and multiplexes workspace and CodeNomad events to browser clients using Server-Sent Events. Delivery is live and volatile: there is **no guaranteed event replay**.

After reconnecting, the UI refetches authoritative session and pending-request state; file/configuration invalidations also trigger fresh reads. A reconnect is not permission to repeat a send, delete, answer or other mutation whose reply was lost. Check the resulting state first. Known pending requests and drafts are retained when recovery is incomplete; see [Permissions](permissions.md) and [Troubleshooting](troubleshooting.md).

## Preview packages and maintenance {#maintenance}

To try the preview CLI package explicitly:

```sh
npx @neuralnomads/codenomad-dev --generate-token --launch
```

Use a deliberately separate configuration if you need isolated CodeNomad settings; selecting a package does not isolate shared OpenCode storage. **Settings → Info → Updates → Update feed** controls offered releases, not the backend's data identity or the installed package.

`codenomad --upgrade` updates the global stable CLI package using the detected npm/pnpm/bun manager (npm if none is detected). It neither restarts a running server nor updates OpenCode. For a project-local or preview installation, update that exact npm package explicitly. Restart your managed CodeNomad process deliberately after updating; check its printed addresses again.

See [Updates](updates.md) for desktop maintenance, [Support](support.md) for source-build commands, and [Providers](providers.md) for provider plan usage.
