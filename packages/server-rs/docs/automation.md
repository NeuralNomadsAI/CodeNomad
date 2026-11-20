# Desktop automation with the Rust server: design note

Status: proposal for review. Scope: `codenomad.inspect`, `codenomad.act`, `codenomad.screenshot`, `codenomad.browser` and `act({ action: "restart" })` when a desktop host runs the Rust server.

## 1. What the tools do and the current path

For the agent, the tools do five things (`dev-docs/BROWSER_AUTOMATION.md`, `.opencode/skills/codenomad-automation/SKILL.md`):

- **inspect**: an indented accessibility outline of the focused local CodeNomad window, with refs, budgeted collapse, `ref`/`query` scoping, the window/workspace/conversation context and runtime diagnostics (renderer console and exceptions; Tauri adds its last 32 preview errors).
- **act**: real pointer, wheel and key input aimed at a ref's visible centre and refused when covered; text insertion, native `<select>`, drag, chords, text waits. Every trusted input carries the application's automation provenance marker, so it can never pass as a human Form answer.
- **screenshot**: a PNG of the inspected page (≤ 5 MiB).
- **browser**: the same engine on the session's visible preview guest, plus `open`, `navigate` and `screenshot`, which the host performs.
- **restart**: the host relaunches gracefully; the plugin waits for the same native identity with a new run and returns a fresh inspection.

Current path and what each layer contributes:

| Layer | Contribution |
| --- | --- |
| OpenCode plugin (TS, inside the daemon) | Tool schemas, presence following, discovery of `automation-bridges/` registrations (WSL also reads the Windows directory), "exactly one owning backend", per-session pin of the inspected backend, restart reconnection, text/image formatting. |
| `curl.exe --noproxy "*"` | Only for a WSL plugin reaching the Windows loopback bridge under WSL2 NAT. |
| Server bridge `/api/opencode-plugin/automation` | Token and loopback check; **OpenCode session → location → owned workspace** (the only layer that knows both sides); action validation; preview page engine with per-session refs over `browser.page.begin/send/check/end`; app-window page engine over a CDP WebSocket (target discovery through `/json/list`, window/session matching, run pinning, navigation epochs, console capture). |
| Host (Electron / Tauri) | Window and run identity, Chromium-assigned CDP port (`DevToolsActivePort`), focused-window choice, restart; preview guest registry, leases, document generations, allowlisted operations, native input, preview screenshots, WebKit driver. |
| Page | Accessibility tree, DevTools input, fixed injected functions (`automation/page/functions.generated.json`), provenance marker. |

Two facts shape the rest. The page engine (snapshot renderer, aiming, input sequences, keys, refs: about 1,100 TS lines) runs in the server only because the server was where Node code lived. And both hosts already speak CDP in process to preview guests: Tauri through WebView2 `CallDevToolsProtocolMethod` (`browser_controller.rs`), Electron through `webContents.debugger` (`browser-controller.ts`). Only the application window goes through a debugging port.

## 2. Simpler Rust architecture

**Option A, faithful port into `server-rs`.** Bridge, CDP WebSocket client, target discovery and the whole page engine in the server; hosts unchanged. About 6–8 days. It keeps the unauthenticated loopback CDP port on the app window and leaves two engines (Rust in the server, TS in Electron's preview path) to keep identical. A CDP crate does not pay off here: `chromiumoxide` 0.9.1 (Feb 2026, MIT OR Apache-2.0, actively released) generates the whole protocol and runs its own browser/target handler built to own a browser, while we use about fifteen methods with per-command deadlines on a browser we must not disturb. A raw `tokio-tungstenite` client (~150 lines) would do, and option B needs neither.

**Option B, the host drives its own pages (recommended).** The engine moves to whoever owns the page and talks to it in process:

- One Rust crate, `codenomad-automation` (engine only, transport-agnostic: a `send(method, params)` closure plus a checkpoint), used by the Tauri host. The injected programs stay the existing JS assets, embedded with `include_str!` as `browser_page_operation.rs` already does.
- Tauri runs it over `CallDevToolsProtocolMethod` for the application window as for previews, and reads console, exceptions and `Page.frameNavigated` through the DevTools event receiver. Electron runs the existing TS engine in its main process over `webContents.debugger`, moved from `packages/server/src/automation/page` to a shared package (Electron must stop importing `packages/server/src` anyway).
- Two private native methods replace the rest: `developer.execute { command }` (inspect, act, screenshot, restart) and `browser.execute` extended to `snapshot` and page actions. Refs live in the host per window run and per preview session.
- Both servers (TS and Rust) become forwarders: authenticate, check session ownership, validate the action, forward, append their own diagnostics. Hosts keep `developer.status` and `browser.page.*` until the TS server forwards too, then those go.

Removed: the remote-debugging port and `DevToolsActivePort` handling, `developer-cdp.ts`, `/json/list` probing and window matching, inspection target pinning in the server, the cross-process lease protocol (leases stay but become in-process calls), and in `server-rs` any CDP or engine code. The tool and plugin contract is unchanged: same bridge modes, bodies, errors and restart semantics. About 9–11 days across both hosts. Risks: both hosts change; WebView2 calls hop to the UI thread (keep the engine on a worker, as the preview path does); trusted-input provenance and paint holding through `CallDevToolsProtocolMethod` on the app window must be qualified with the existing `automation-input` tests; the private method change must ship with both servers in step.

**Rust-specific diagnostics (either option).** Today `inspect` reports the renderer console and the host's preview errors; Node errors appear only when they reach the renderer. The Rust server adds a bounded ring of its own panics (panic hook with `file:line` and the line-table backtrace from `RUST_BACKTRACE=1`) and logged errors, appended to inspection diagnostics by the bridge. Restart relaunches the host, which relaunches the Rust binary; the WSL `curl.exe` path is untouched because the plugin and bridge wire stay as they are.

**Fastest path for tranche 14.** The bridge forwarder and its registration (production publication, `0600`, atomic write, `CODENOMAD_NATIVE_PARENT` / `CODENOMAD_NATIVE_BROWSER_AUTOMATION` / `CODENOMAD_AUTOMATION_BRIDGE_TOKEN` handling) are needed by both options and come first. Option B then lands host by host.

## 3. Server in the Tauri process

Linking `server-rs` as a library inside the Tauri host removes the stdout readiness line, the bootstrap token and its exchange, the stdin shutdown line and the native-parent stdin/stdout channel: native requests become function calls and `developer.execute` a direct call. The automation bridge stays an HTTP loopback endpoint because the plugin lives in the OpenCode daemon. Electron keeps the separate binary, and so do `npx @neuralnomads/codenomad` and the bench, so the crate becomes a library plus a thin `main`.

Estimate: 8–10 days, plus about 2 days of qualification on three OSes.

- Configuration from an explicit struct instead of process environment (`config.rs` and scattered `env::var`; `set_var` is unsafe in edition 2024 and racy): 2–3 days.
- Host integration (start, stop, restart, session cookie handoff, direct native calls): 2–3 days.
- Profile transitions and shutdown ordering, with tests: 2 days.
- Child environment on macOS/Linux, where GUI apps lack the login shell's `PATH`: the host resolves it and the server passes it explicitly to OpenCode, git and npm: 1–2 days.

Risks:

- **Shared crash**: an abort, stack overflow or OOM in the server closes every window; the host can no longer show an error and restart the server. Requires `panic = "unwind"`, per-task containment and a review of `abort` paths.
- **Lifecycle and globals**: profile switch and server restart need a clean in-process stop and restart; process-wide statics (`OnceLock` caches, bench flags) must be resettable or removed.
- **Shutdown**: `ExitRequested` must wait for the graceful stop (OpenCode daemon, receipts), bounded like today's 30 s; the Job Object must still cover OpenCode children.
- **Updates**: the server ships with the host, as today; only an independent server hotfix becomes impossible.
- **Profiles**: config and TLS directories come from the host's profile scope instead of `CLI_CONFIG`.
- **WSL**: unchanged; the Windows host still reaches WSL daemons through `wsl.exe`, and the WSL plugin still reaches the bridge through `curl.exe`.
- **Memory and isolation**: the server's heap joins the host process; the remote-access listener runs inside the GUI process (same user, small delta).
- **Tests**: server tests are unchanged as a library; host integration tests gain a real server; build time and dependency versions (tokio, rustls, `windows` crates) unify with the Tauri crate.

[`host-cli` opinion to be integrated here.]
