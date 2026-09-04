# Developer Mode

Developer Mode instruments the current CodeNomad desktop process for agent feedback. It never launches or owns another CodeNomad process and never starts, stops, or replaces the shared OpenCode daemon.

## User Contract

The session tab bar contains one **Developer Mode** toggle. Its desired state is the presence of `~/.config/codenomad/developer-mode`, shared by Electron and Tauri on the device. The native host captures the active state before creating Chromium or WebView2, so changing the toggle takes effect on the next full CodeNomad start.

The UI receives `{ enabled, active }`. A mismatch means a restart is pending. There is no executable picker, target selector, Start/Stop control, CDP status, profile path, or launch-log panel.

## Startup Contract

When active, Electron:

- Uses a persistent developer browser directory below the existing channel/config profile while keeping the singleton and client-state identities unchanged.
- Enables a Chromium-assigned loopback CDP port and removes a stale `DevToolsActivePort` only after the stable singleton lock is acquired.
- Enables Chromium logging and Node source-map stack traces.

When active on Windows, Tauri:

- Uses a persistent local `developer-mode` WebView2 directory below the existing channel/config profile without overriding isolated remote-window profiles.
- Gives only local WebViews `--remote-debugging-port=0`, then reads and verifies their `EBWebView/DevToolsActivePort` endpoint.
- Enables Rust backtraces and Node source-map stack traces for the managed backend.

Packaged Electron main/preload/renderer, UI, and server builds emit source maps. Disabling the mode strips inherited remote-debugging flags on the next startup. Windows WebView2 is the supported Tauri CDP host.

## Persistent OpenCode Integration

OpenCode remains the owner of its global service, database, sessions, and plugin lifecycle. The CodeNomad repository provides:

- `.opencode/plugins/codenomad-automation.ts`, a project-local adapter loaded by OpenCode.
- `.opencode/skills/codenomad-automation/SKILL.md`, the complete inspect, edit, build, relaunch, reconnect, and evidence workflow.
- `codenomad.inspect`, `codenomad.act`, and `codenomad.screenshot` tools.

An active CodeNomad backend publishes an ephemeral registration containing a per-process 256-bit token. The registration disappears on graceful shutdown. Definitions can remain loaded while CodeNomad is absent, but calls are inert until an authorized bridge reconnects.

Windows registrations are also discoverable by an OpenCode plugin running in WSL. Calls to those registrations use Windows interop so they reach the Windows-only loopback listener under default WSL2 NAT. Native startup removes only the recognizable generated global shim from older releases; it never overwrites or removes a user-authored plugin.

`codenomad.act({ action: "restart" })` asks the host pinned by the latest successful inspection to relaunch gracefully. The plugin then runs inside the persistent OpenCode daemon, ignores the old registration, waits for the same host/profile/artifact identity with a new process generation, verifies the same visible OpenCode session, and returns a fresh inspection. It never switches to another worktree build.

## Target And Trust Boundaries

- The HTTP bridge and CDP endpoint use IPv4 loopback only. The bridge requires its random token. Raw CDP has no authentication, can execute code in authenticated renderer pages, and therefore trusts other processes running as the local user; enable this opt-in mode only on a trusted machine.
- The native host selects the focused local window, or the most-recent local window when CodeNomad is not focused. A focused remote window is never selected.
- CDP evaluates a bounded set of page targets and requires exactly the native window UUID, visible `data-instance-id`, and active `data-session-id`.
- The bridge resolves the OpenCode session through the shared service and verifies that the visible `data-instance-id` owns that session location.
- Operations for one native run are serialized. Click and type revalidate context immediately before input; inspection and screenshot revalidate after capture. Accessibility refs are invalidated by navigation, target replacement, context change, and restart.
- Actions and screenshots require a successful inspection and remain pinned to that registration until another inspection or a verified restart replaces it.
- Registration files, bridge responses, target probes, diagnostics, accessibility snapshots, screenshots, request bodies, and reconnect time are bounded.

## Main Paths

- Electron mode: `packages/electron-app/electron/main/developer-mode.ts`
- Tauri mode: `packages/tauri-app/src-tauri/src/developer_mode.rs`
- Session toggle: `packages/ui/src/components/instance-tabs.tsx`
- Native UI adapter: `packages/ui/src/lib/native/developer-mode.ts`
- Shared CDP controller: `packages/server/src/developer-cdp.ts`
- OpenCode adapter: `packages/server/src/opencode/automation-plugin.ts`
- Authenticated bridge route: `packages/server/src/server/routes/automation-plugin.ts`
- Agent workflow: `.opencode/skills/codenomad-automation/SKILL.md`
