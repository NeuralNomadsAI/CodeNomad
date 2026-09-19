# Desktop Automation (formerly Developer Mode)

Desktop automation instruments the current CodeNomad desktop process for agent feedback. It never launches or owns another CodeNomad process and never starts, stops, or replaces the shared OpenCode daemon. The internal developer-mode module names remain for continuity; tool access is no longer a mode or a saved permission.

## User Contract

The single `codenomad.automation` plugin supplies browser and developer tools while a desktop backend is present. All tools are available by default. There is no Developer Mode toggle, marker-based permission, or activation restart. Loading the plugin, exposing definitions and selecting an authorized execution target are separate responsibilities.

## Startup Contract

At normal startup, Electron:

- Uses a persistent developer browser directory below the existing channel/config profile while keeping the singleton and client-state identities unchanged.
- Enables a Chromium-assigned loopback CDP port and removes a stale `DevToolsActivePort` only after the stable singleton lock is acquired.
- Enables Chromium logging and Node source-map stack traces.

At normal startup on Windows, Tauri:

- Uses a persistent local `developer-mode` WebView2 directory below the existing channel/config profile without overriding isolated remote-window profiles.
- Gives only local WebViews `--remote-debugging-port=0`, then reads and verifies their `EBWebView/DevToolsActivePort` endpoint.
- Enables Rust backtraces and Node source-map stack traces for the managed backend.

Packaged Electron main/preload/renderer, UI, and server builds emit source maps. Local hosts sanitize inherited debugging flags and use an automatically assigned loopback port. Isolated remote-window profiles do not inherit local instrumentation. Windows WebView2 is the supported Tauri CDP host.

## Persistent OpenCode Integration

OpenCode remains the owner of its global service, database, sessions, and plugin lifecycle. The CodeNomad repository provides:

- One bundled `codenomad.automation` plugin, provisioned through normal native OpenCode discovery in the selected host/WSL namespace. It also supplies browser tools; see [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md).
- `.opencode/skills/codenomad-automation/SKILL.md`, the complete inspect, edit, build, relaunch, reconnect, and evidence workflow.
- `codenomad.inspect`, `codenomad.act`, and `codenomad.screenshot` tools.

An active CodeNomad backend publishes an ephemeral registration containing a per-process 256-bit token. The registration disappears on graceful shutdown. Plugin definitions follow backend presence. Previously captured tool definitions cannot bypass execution-time checks after backend shutdown or a change of visible session/window.

Windows registrations are also discoverable by an OpenCode plugin running in WSL. Calls to those registrations use Windows interop so they reach the Windows-only loopback listener under default WSL2 NAT. Provisioning follows the connected daemon's authenticated `config.get` discovery roots, including reconnects, and migrates only recognizable generated entries. It never overwrites a user-authored plugin or assumes that next-start environment overrides apply to an already-running daemon.

`codenomad.act({ action: "restart" })` asks the host pinned by the latest successful inspection to relaunch gracefully. The plugin then runs inside the persistent OpenCode daemon, ignores the old registration, waits for the same host/profile/artifact identity with a new process generation, verifies the same visible OpenCode session, and returns a fresh inspection. It never switches to another worktree build.

## Target And Trust Boundaries

- The HTTP bridge and CDP endpoint use IPv4 loopback only. The bridge requires its random token. Raw CDP has no authentication and trusts local processes; default tool availability does not remove the bridge's authentication or its session/window selection checks.
- The native host selects the focused local window, or the most-recent local window when CodeNomad is not focused. A focused remote window is never selected.
- CDP evaluates a bounded set of page targets and requires exactly the native window UUID, visible `data-instance-id`, and active `data-session-id`.
- The bridge resolves the OpenCode session through the shared service and verifies that the visible `data-instance-id` owns that session location.
- Operations for one native run are serialized. Click and type revalidate context immediately before input; inspection and screenshot revalidate after capture. Accessibility refs are invalidated by navigation, target replacement, context change, and restart.
- Actions and screenshots require a successful inspection and remain pinned to that registration until another inspection or a verified restart replaces it.
- Registration files, bridge responses, target probes, diagnostics, accessibility snapshots, screenshots, request bodies, and reconnect time are bounded.

## Main Paths

- Electron mode: `packages/electron-app/electron/main/developer-mode.ts`
- Tauri mode: `packages/tauri-app/src-tauri/src/developer_mode.rs`
- Shared CDP controller: `packages/server/src/developer-cdp.ts`
- OpenCode adapter: `packages/server/src/opencode/automation-plugin.ts`
- Authenticated bridge route: `packages/server/src/server/routes/automation-plugin.ts`
- Agent workflow: `.opencode/skills/codenomad-automation/SKILL.md`
