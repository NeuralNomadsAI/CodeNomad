# Desktop automation with the Rust server: design note

Status: option B chosen, Tauri only (Electron does not launch the Rust server on this branch). Scope: `codenomad.inspect`, `codenomad.act`, `codenomad.screenshot`, `codenomad.browser` and `act({ action: "restart" })`.

## 1. What the tools do and the current path

For the agent, the tools do five things (`dev-docs/BROWSER_AUTOMATION.md`, `.opencode/skills/codenomad-automation/SKILL.md`):

- **inspect**: an indented accessibility outline of the focused local CodeNomad window, with refs, budgeted collapse, `ref`/`query` scoping, the window/workspace/conversation context and runtime diagnostics (renderer console and exceptions, the host's last 32 preview errors).
- **act**: real pointer, wheel and key input aimed at a ref's visible centre and refused when covered; text insertion, native `<select>`, drag, chords, text waits. Every trusted input carries the application's automation provenance marker, so it can never pass as a human Form answer.
- **screenshot**: a PNG of the inspected page (≤ 5 MiB).
- **browser**: the same engine on the session's visible preview, plus `open`, `navigate` and `screenshot`, which the host performs.
- **restart**: the host relaunches gracefully; the plugin waits for the same native identity with a new run and returns a fresh inspection.

Current path and what each layer contributes:

| Layer | Contribution |
| --- | --- |
| OpenCode plugin (TS, inside the daemon) | Tool schemas, presence following, discovery of `automation-bridges/` registrations (WSL also reads the Windows directory), "exactly one owning backend", per-session pin of the inspected backend, restart reconnection, text/image formatting. |
| `curl.exe --noproxy "*"` | Only for a WSL plugin reaching the Windows loopback bridge under WSL2 NAT. |
| Server bridge `/api/opencode-plugin/automation` | Token and loopback check; **OpenCode session → location → owned workspace** (the only layer that knows both sides); action validation; preview page engine with per-session refs over `browser.page.begin/send/check/end`; app-window page engine over a CDP WebSocket (target discovery through `/json/list`, window/session matching, run pinning, navigation epochs, console capture). |
| Tauri host | Window and run identity, WebView2's Chromium-assigned CDP port (`DevToolsActivePort`, Windows only), focused-window choice, restart; preview registry, leases, document generations, allowlisted page operations through a `cdp` driver (WebView2 `CallDevToolsProtocolMethod`) or a `webkit` driver (fixed isolated-world read program, native NSEvent/GDK input), preview screenshots. |
| Page | Accessibility tree, input, fixed injected programs (`automation/page/functions.generated.json`, WebKit `page_read.generated.h`), provenance marker. |

The page engine (snapshot renderer, aiming, input sequences, keys, refs: about 1,100 TS lines) runs in the server only because the server was where Node code lived. The host already reaches every page in process; only the Windows application window goes through a debugging port.

## 2. Coverage by system, today and with B

Established from the branch's code and tests (`developer_mode.rs`, `browser_controller.rs`, `browser_controller_page.rs`, `embedded_view/input_*`, their regression tests). Not yet confirmed by a real run on each system: Windows needs the `desktop-hosts` build; the Ubuntu VM has 1.4 GB free and only binaries older than this branch; the macOS VM disk is full.

| Tool | Windows (WebView2) | macOS 14+ (WKWebView) | Linux (WebKitGTK) |
| --- | --- | --- | --- |
| inspect, act, screenshot (app window) | Yes: server CDP WebSocket to `--remote-debugging-port=0` → **B**: in-process `CallDevToolsProtocolMethod`, no port | No: `developer.status` refuses ("requires the Tauri Windows runtime"); WebKit has no CDP → **B**: new, WebKit driver on the app's own view | No, as macOS → **B**: new, as macOS |
| restart | Yes, after an inspection → **B**: yes | No: needs an inspection, and `developer.restart` is refused although the host's relaunch is cross-platform → **B**: yes once inspect works | No, as macOS → **B**: as macOS |
| browser open, navigate, screenshot | Yes: host navigation, CDP `Page.captureScreenshot` → **B**: unchanged | Yes: `takeSnapshotWithConfiguration` → **B**: unchanged | Yes: `webkit_web_view_get_snapshot` → **B**: unchanged |
| browser snapshot and page actions | Yes: server engine, host `cdp` driver → **B**: engine in the host, same driver | Yes: server engine, host `webkit` driver → **B**: engine in the host, same driver | Yes, as macOS → **B**: as macOS |
| inspect diagnostics | Renderer console through CDP events, host preview errors → **B**: WebView2 DevTools event receiver, plus Rust server diagnostics | None (no inspect) → **B**: a fixed page-world console/error hook, plus Rust server diagnostics | As macOS |

## 3. Option B on Tauri

- The engine becomes a module of the Tauri crate (server-rs needs none), driven through the existing operation drivers: `cdp` over `CallDevToolsProtocolMethod`, `webkit` over the read program and native input. Injected programs stay the existing JS and generated assets, embedded with `include_str!` as `browser_page_operation.rs` already does.
- Windows app window: the main local webview through `CallDevToolsProtocolMethod`; console, exceptions and `Page.frameNavigated` through `GetDevToolsProtocolEventReceiver`. The `--remote-debugging-port` flag and the `DevToolsActivePort` handling go.
- macOS and Linux app window (new): install the read program in the application view as for previews, aim native input at that view, capture with the existing snapshot calls. The provenance marker (`__codenomadAutomationInputUntil`) must be set in the page world by a fixed program, since WebKit has no CDP input; this and the console hook need their own security review and the `automation-input` tests on WebKit.
- Two private native methods carry it: `developer.execute { command }` and `browser.execute` extended to `snapshot` and page actions. Refs live in the host, per window run and per preview session.
- The Rust server only authenticates, checks session ownership, validates the action, forwards and appends its own diagnostics. While Tauri can still launch the TS server, the host keeps `developer.status`, the Windows debugging port and `browser.page.*` for it; switching the TS server to the same forwarding (about half a day) removes them earlier.
- Unchanged: the plugin, the bridge modes, bodies, errors, restart semantics and the WSL `curl.exe` path.

Estimate (Tauri only):

| Work | Days |
| --- | --- |
| Engine in Rust (snapshot renderer and budgets, refs, aiming, input sequences and provenance, keys, waits), checked against the existing TS fixtures (`driver.golden.json`, `contract.cases.json`, snapshot cases) | 3–4 |
| Previews through the in-host engine, both drivers | 1–1.5 |
| Windows app window, event receiver, input provenance and paint-holding qualification | 1.5–2 |
| macOS and Linux app window (new capability), VM qualification once their disks have room | 4–6 |
| Rust server forwarding and bench (bridge and publication already done) | 0.5 |
| **Windows parity** / **all three systems** | **6–8** / **10–14** |

Risks: WebView2 calls hop to the UI thread (keep the engine on a worker, as the preview path does); trusted input through `CallDevToolsProtocolMethod` on the app window and through WebKit native input must keep the human-answer guarantees; the VMs must be given room before WebKit window automation can be qualified.

**Rust server diagnostics.** Today `inspect` reports the renderer console and the host's preview errors; Node errors appear only when they reach the renderer. The Rust server keeps its last 32 panics (location, plus this crate's frames when `RUST_BACKTRACE=1` and line tables are present) and 5xx refusals with their call site; the bridge appends them to inspection diagnostics.

## 4. Server in the Tauri process

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
