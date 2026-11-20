# Desktop automation with the Rust server: design note

Status: option B chosen, Tauri only (Electron does not launch the Rust server on this branch); Windows parity implemented (`packages/tauri-app/src-tauri/src/automation/`), macOS and Linux window automation not started. Scope: `codenomad.inspect`, `codenomad.act`, `codenomad.screenshot`, `codenomad.browser` and `act({ action: "restart" })`.

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

`server-rs` linked as a library inside the Tauri host, with the same code built as the separate binary for remote use. For option B this turns the native requests into direct calls through a trait instead of the stdio channel; the plugin bridge stays an HTTP loopback endpoint because the plugin lives in the OpenCode daemon.

Estimate: 8–11 days, then qualification on three systems.

| Work | Days |
| --- | --- |
| Library/binary split: `start(config, host) -> Handle` and `stop()`, no environment reads or `process::exit` after start | 2–3 |
| Tauri: in-process start and stop, native calls through a trait, session cookie injected into the webview, restart on profile change, TS/Rust switch | 3–5 |
| Build and CI: path dependency, one lock file, unified `reqwest`/`rustls`/`tokio`, longer Tauri compile | 1 |
| Lifecycle tests | 2 |

Removed on the Tauri side: the child-process launch in `cli_manager.rs`, `cli_output.rs`, `native_request.rs`, most of the stdin protocol in `shutdown.rs`, `cli_drain_tests.rs`, the internal Windows launcher, the Job Object and POSIX group for the server, the 60 s start-up wait, the TCP token exchange and `resources/server` (`managed_node.rs` stays only if OpenCode still needs npm). On the server side: the stdio transport of `native_parent` (replaced by a trait), the token and status lines, the stdin reader, `--generate-token` and `--auth-cookie-name`.

Kept for the remote binary: `serve` and its useful options, HTTPS and pairing, the password and `/login`, the static UI, SIGTERM, `install/`, the bench's stdin stop. The loopback HTTP listener also stays in library mode: the webview loads the UI and API from it.

A server panic does not close the windows, under four conditions: `panic = "unwind"` enforced (`compile_error!` under `abort`); the server on its own thread and runtime, never inside tao/webview callbacks, where a panic crossing FFI aborts the process; no `process::exit` or signal handler left in the library (four today); `catch_unwind` around the server thread, to observe its death and restart it. Tokio and hyper already contain panics per task, and `panic_guard` answers 500. Still fatal: stack overflow, OOM, double panic, undefined behaviour in FFI (Windows ACLs).

Main risk: restarting the server inside the same process. Globals survive it (native bridge `PENDING`, extensions `STATE`/`DESIGN`, memory `CACHE`/`SEEN`, search `CACHE`, worktree fence `STATE`/`QUEUES`, Git `SLOTS`), and a poisoned lock leaves the server answering 500 for good. They must move into `App`, which is also what a profile change without restart needs. Updates are unchanged; WSL is unchanged while the server runs on Windows; a server leak becomes a host leak.

Recommendation: first Tauri trial with the separate binary (ready); move to the library only once globals are per instance and a "panic in a handler, then in-process restart" test passes.

