# Developer Automation

Developer Automation lets a running CodeNomad desktop host launch and inspect an isolated packaged CodeNomad build. It replaces the manual debug launch environment with one Advanced Settings workflow for Electron and Windows Tauri.

## Launch Contract

Every run receives a private profile, update channel, config path, and automatic loopback CDP port.

Tauri sets:

- `WEBVIEW2_USER_DATA_FOLDER`
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-address=127.0.0.1 --remote-debugging-port=<port>`
- `RUST_BACKTRACE=1`
- `NODE_OPTIONS=--enable-source-maps`

Electron passes the equivalent `--remote-debugging-address`, `--remote-debugging-port`, `--user-data-dir`, and `--enable-logging` arguments and enables Node source maps.

The host waits for the exact CDP page target, keeps bounded stdout/stderr logs, and stops the complete process tree on explicit stop or host shutdown.

## Agent Feedback

The small automation adapter registers these definitions with OpenCode:

- `codenomad.inspect`: accessibility tree, runtime diagnostics, target metadata, and recent launch logs.
- `codenomad.act`: click, type, or restart using refs from the latest inspection.
- `codenomad.screenshot`: PNG capture of the connected build.

OpenCode plugin setup is currently one-shot, so definitions are visible in unrelated locations. Calls remain inert unless the bridge verifies that the current session location is owned by the active CodeNomad instance.

The adapter is intentionally narrower than the removed V1 plugin runtime. It does not own OpenCode lifecycle or state, spawn one daemon per workspace, or expose autonomous browser previews.

## Trust Boundaries

- Discovery registrations contain random tokens and target an internal loopback HTTP listener, independent of the user-facing HTTPS certificate.
- The bridge verifies the OpenCode session and its location against the current CodeNomad workspace manager.
- One OpenCode session owns a developer run until that run stops or is replaced.
- CDP uses the exact target ID reported by the native host.
- Accessibility refs are invalidated by navigation.
- Diagnostics, accessibility snapshots, screenshots, and log histories are bounded.

## Main Paths

- Electron lifecycle: `packages/electron-app/electron/main/developer-run-manager.ts`
- Tauri lifecycle: `packages/tauri-app/src-tauri/src/developer_run.rs`
- Shared CDP controller: `packages/server/src/developer-cdp.ts`
- Automation adapter: `packages/server/src/opencode/automation-plugin.ts`
- Authenticated bridge route: `packages/server/src/server/routes/automation-plugin.ts`
- UI: `packages/ui/src/components/settings/developer-automation-card.tsx`
