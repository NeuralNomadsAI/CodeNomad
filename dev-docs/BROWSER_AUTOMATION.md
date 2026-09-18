# Browser Automation

CodeNomad exposes `codenomad.browser` for controlling the visible web preview attached to the current OpenCode session. The supported actions are `open`, `navigate`, `snapshot`, `click`, `type`, and `screenshot`.

## Integration and shared bridge

Browser previews are an ordinary desktop feature. They must work in user projects outside the CodeNomad source checkout and do not require Developer Mode.

- One bundled V2 plugin, `codenomad.automation`, is provisioned through native OpenCode plugin discovery in the selected host/WSL daemon namespace. Its definitions follow backend presence. Loading it does not start a browser or perform an action.
- Provisioning follows the authenticated connection, including reconnects. `config.get` supplies the first (global) discovery directory; neither the backend environment nor CLI `debug paths` identifies an existing daemon's roots. New managed bundles and leases live in that root's `.codenomad/` directory, outside `plugins/`; existing generated entries retain their recorded storage for older backends' leases. WSL translates the returned Linux path to its selected distro's UNC path only for filesystem access. Missing authoritative discovery information is reported rather than replaced with a guessed directory.
- The plugin exposes `browser`, `inspect`, `act`, and `screenshot` while a desktop backend is present. Tool availability is separate from plugin loading; there is no Developer Mode access gate.
- Browser and developer calls share the backend's loopback registration and private native transport. Native instrumentation is prepared at normal startup, so tool access does not require a toggle or an additional restart. Execution still verifies the selected backend, supported native capabilities and invoking session.
- `packages/server/src/server/routes/automation-plugin.ts` serves the existing `/api/opencode-plugin/automation` endpoint with the existing per-process token.
- `browser-claim` verifies that exactly one CodeNomad instance owns the session before an `open` action asks the UI to create a preview.
- `browser-probe` also requires a visible native preview registered to that session.
- `browser-execute` validates the browser action and forwards `browser.probe` or `browser.execute` over the existing fenced native-parent request channel.

The bridge remains loopback-only, token-authenticated, bounded, and session-location gated. The removed V1 plugin runtime and browser-specific bridge routes are not part of this design.

## September 2026 architecture decision

The original beta-era MCP limitation is obsolete: current [OpenCode V2 MCP documentation](https://opencode.ai/v2/docs/mcp-servers#context) specifies `_meta.sessionID` for session-backed calls, including Code Mode. This metadata is correlation, not authorization. MCP is now a viable integration choice.

For this in-application preview, use one bundled V2 automation plugin rather than add another protocol server, MCP configuration, discovery and cancellation implementation. The user explicitly chose unified distribution for browser and developer tools, with all tools available as the initial baseline rather than introducing a mode-based permission system. CodeNomad already needs the authenticated backend-to-native transport, and the existing pruning integration supplies normal native plugin discovery and backend presence mechanics. The plugin uses OpenCode's invoking tool context; session ownership is re-read through the shared connection and validated worktree inventory at execution. Neither a plugin location nor a caller-provided session ID alone grants access.

This decision concerns distribution and transport, not a replacement for the native controllers: OpenCode does not own CodeNomad's visible Electron/WebView2 preview, its window, storage partition or permissions. Keep those responsibilities native, preserve the independently owned OpenCode daemon, and keep the current connection-scoped compatibility adapter for V2 location/API differences.

The pinned `@opencode/plugin` 2.0.4 Promise tool context has no `signal`. Browser execution currently has native/HTTP deadlines rather than a guarantee of immediate cancellation when an agent turn is interrupted. Do not invent `tool.signal` or claim that switching to MCP alone cancels already-dispatched native work. Any stronger cancellation contract needs end-to-end propagation and native tests.

## Native Hosts

Electron uses a hardened `<webview>` with per-session storage. Attachment verifies guest ownership, allows only credential-free HTTP(S) URLs, denies permissions and downloads, and uses Chromium accessibility/CDP commands for snapshots and actions.

Windows Tauri uses a child webview owned by the local application window. Commands, capabilities, navigation checks, bounds, visibility, and storage are managed by `browser_controller.rs`. Application capabilities select primary `local-*` webviews, never their parent-window wildcard: Tauri combines window/webview matching with OR, so a window grant would also authorize an untrusted child. Full primary-renderer navigation disposes its preview children. Final-window decisions count native windows, including multi-webview windows. Other Tauri platforms continue to use the existing iframe preview and do not advertise native browser automation.

The UI routes an autonomous open request to the one loaded instance containing the session, claims the request for one local window, selects that session, and opens its preview. Hidden or duplicate targets are rejected rather than selected implicitly.

## Focused Validation

- Server: `automation-plugin.test.ts`, `automation/desktop-plugin.test.ts`, `routes/automation-plugin.test.ts`, and the shared pruning-presence regressions
- Native discovery: build with `npm run build:automation --workspace @neuralnomads/codenomad`, then run `node scripts/test-automation-native.mjs <absolute-cli-path>`. The fixture uses an isolated daemon/config/database and exercises ordinary-project discovery, all tools without activation, execution fences, independent leases, shutdown and reopening. CI crosses legacy and current V2 contract families, including 2.0.7.
- Electron: `browser-controller.test.ts`, `browser-webview-security.test.ts`, preload tests
- Tauri: `browser_controller.rs` and `browser_controller_regressions.rs` tests, including actual capability resolution, primary-renderer cleanup, window counting, lock ordering and expired dispatch
- UI: `browser-frame-security.test.ts`, `lib/native/browser.test.ts` and `tests/browser/browser-frame-native.test.ts` (real Solid/Electron guests, insecure HTTP, registration disposal and Tauri IPC failure recovery). Linux Electron rendering requires a display; CI runs the browser suite under Xvfb.
