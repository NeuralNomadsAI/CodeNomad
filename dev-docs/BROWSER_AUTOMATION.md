# Browser Automation

CodeNomad exposes `codenomad.browser` for controlling the visible web preview attached to the current OpenCode session. The supported actions are `open`, `navigate`, `snapshot`, `click`, `type`, and `screenshot`.

## Shared Bridge

Browser control extends the Developer Mode adapter instead of installing another plugin or listener:

- `.opencode/plugins/codenomad-automation.ts` loads the reviewed project-local adapter, while `packages/server/src/opencode/automation-plugin.ts` publishes one loopback registration.
- `packages/server/src/server/routes/automation-plugin.ts` serves the existing `/api/opencode-plugin/automation` endpoint with the existing per-process token.
- `browser-claim` verifies that exactly one CodeNomad instance owns the session before an `open` action asks the UI to create a preview.
- `browser-probe` also requires a visible native preview registered to that session.
- `browser-execute` validates the browser action and forwards `browser.probe` or `browser.execute` over the existing fenced native-parent request channel.

The bridge remains loopback-only, token-authenticated, bounded, and session-location gated. The removed V1 plugin runtime and browser-specific bridge routes are not part of this design.

## Native Hosts

Electron uses a hardened `<webview>` with per-session storage. Attachment verifies guest ownership, allows only credential-free HTTP(S) URLs, denies permissions and downloads, and uses Chromium accessibility/CDP commands for snapshots and actions.

Windows Tauri uses a child webview owned by the local application window. Commands, capabilities, navigation checks, bounds, visibility, and storage are managed by `browser_controller.rs`. Other Tauri platforms continue to use the existing iframe preview and do not advertise native browser automation.

The UI routes an autonomous open request to the one loaded instance containing the session, claims the request for one local window, selects that session, and opens its preview. Hidden or duplicate targets are rejected rather than selected implicitly.

## Focused Validation

- Server: `automation-plugin.test.ts` and `routes/automation-plugin.test.ts`
- Electron: `browser-controller.test.ts`, `browser-webview-security.test.ts`, preload tests
- Tauri: `browser_controller.rs` tests plus command capability generation
- UI: `browser-frame-security.test.ts` and `lib/native/browser.test.ts`
