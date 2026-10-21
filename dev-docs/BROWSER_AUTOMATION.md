# Browser Automation

CodeNomad exposes `codenomad.browser` for controlling the visible web preview attached to the current OpenCode session. It supports `open`, `navigate`, `snapshot`, `screenshot` and the same page actions as `codenomad.act`: `click`, `type`, `select`, `hover`, `drag`, `scroll`, `press` and `wait`.

## Integration and shared bridge

Browser previews are an ordinary desktop feature and must work in user projects outside the CodeNomad source checkout.

- One bundled V2 plugin, `codenomad.automation`, is provisioned through native OpenCode plugin discovery in the selected host/WSL daemon namespace. Its definitions follow backend presence; browsers start and actions run only on tool calls.
- Provisioning follows the `config.get` discovery-root, sibling `.codenomad/<SHA-256 of discovery root>/` lease and WSL rules in `OPENCODE_COMPATIBILITY.md`. A lease mtime update beneath the watched root would reload every loaded location; only the new directory receives heartbeats; missing discovery information is reported, never guessed.
- The plugin exposes `browser`, `inspect`, `act`, and `screenshot` while a desktop backend is present. Tool availability is separate from plugin loading.
- Browser and developer calls share the backend's loopback registration and private native transport. Native instrumentation is prepared at normal startup and every tool is available. Execution still verifies the selected backend, supported native capabilities and invoking session.
- Developer inspection targets the native window, independently of its selected project/conversation (including empty views). The invoking session still identifies an owning backend; it need not be visible. Actions retain the inspected window/run and document-scoped accessibility references, so agents can navigate back themselves. Window automation stays valid across session/project selection; navigation, replaced pages, changed native targets or windows and restarts require fresh inspection. Browser-preview tools retain their separate per-session attachment rules.
- `packages/server/src/server/routes/automation-plugin.ts` serves the `/api/opencode-plugin/automation` endpoint with the per-process token.
- `browser-claim` verifies that exactly one CodeNomad instance owns the session before an `open` action asks the UI to create a preview.
- `browser-probe` also requires a visible native preview registered to that session.
- `browser-execute` validates the browser action and forwards `browser.probe` or `browser.execute` over the fenced native-parent request channel.

The bridge is loopback-only, token-authenticated, bounded, and session-location gated.

## Desktop instrumentation

At normal startup, native instrumentation prepares the current CodeNomad desktop process for agent feedback. It never launches or owns another CodeNomad process and never starts, stops or replaces the shared OpenCode daemon.

Electron (`packages/electron-app/electron/main/developer-mode.ts`):

- Uses a persistent `developer-mode-browser-v2` browser directory inside the data profile, keeping the singleton and client-state identities unchanged.
- Enables a Chromium-assigned loopback CDP port and removes a stale `DevToolsActivePort` only after the stable singleton lock is acquired.
- Enables Chromium logging and Node source-map stack traces.

Windows Tauri (`packages/tauri-app/src-tauri/src/developer_mode.rs`):

- Uses a persistent local `developer-mode` WebView2 directory inside the data profile, leaving isolated remote-window profiles untouched.
- Gives only local WebViews `--remote-debugging-port=0`, then reads and verifies their `EBWebView/DevToolsActivePort` endpoint.
- Enables Rust backtraces and Node source-map stack traces for the managed backend.

Packaged Electron main/preload/renderer, UI and server builds emit source maps. Local hosts sanitize inherited debugging flags; isolated remote-window profiles run without local instrumentation. Windows WebView2 is the supported Tauri CDP host. `packages/server/src/developer-cdp.ts` (`DeveloperCdp`) is the shared CDP controller and `opencode/automation-plugin.ts` the OpenCode adapter. `.opencode/skills/codenomad-automation/SKILL.md` holds the inspect, edit, build, relaunch, reconnect and evidence workflow.

An active backend publishes an ephemeral registration with a per-process 256-bit token and removes it on graceful shutdown. Tool definitions captured earlier still go through execution-time checks, which refuse calls after backend shutdown or a change of visible session/window. A WSL OpenCode plugin also discovers Windows registrations and reaches the Windows-only loopback listener through Windows interop under default WSL2 NAT. Provisioning migrates only recognizable generated entries and never overwrites a user-authored plugin.

`codenomad.act({ action: "restart" })` asks the host pinned by the latest successful inspection to relaunch gracefully, ignores the old registration, waits for the same native identity with a new run, re-inspects it for the invoking session and returns that inspection. It never switches to another worktree build.

- The HTTP bridge and CDP endpoint use IPv4 loopback only. The bridge requires its random token. Raw CDP has no authentication and can execute code in authenticated renderer pages, so it trusts local processes; the bridge keeps its token and session/window selection checks.
- The host targets the focused local window, or the most recent local window when CodeNomad is not focused. Preferences and remote windows are never targets.
- Operations for one native run are serialized. Click and type revalidate context immediately before input; inspection and screenshot revalidate after capture.
- Actions and screenshots require a successful inspection and stay pinned to that registration until another inspection or a verified restart replaces it.
- Registration files, bridge responses, target probes, diagnostics, accessibility snapshots, screenshots, request bodies and reconnect time are bounded.

## Page engine

`codenomad.inspect` / `codenomad.act` (the CodeNomad window) and `codenomad.browser` (the session preview) run on the same page engine in `packages/server/src/automation/page/`, which only needs a DevTools protocol channel: `snapshot.ts` renders the accessibility tree, `actions.ts` performs actions, `input.ts` dispatches trusted pointer, wheel and keyboard input, `keys.ts` maps key chords, `parse.ts` validates tool input on both sides of the bridge, `protocol.ts` holds the shared protocol primitives and `refs.ts` names DOM nodes. The app uses `DeveloperCdp`; previews use `automation/browser-page.ts`. The preview's `snapshot({ ref, query })` has the same outline and scoping as the app's `inspect`.

- Inspection is an indented outline with refs, read as plain text. Wrappers, unnamed images and text repeating its parent's name are dropped; fields show their value instead of their inner nodes; native selects list their options with `selected`/`disabled`. A character budget (32 000 by default) is shared among siblings: small parts stay whole while large ones collapse in place with `(+N hidden)` or `(+N more)`, keeping their first and last items, so nothing is cut silently. `ref` expands one subtree and `query` keeps elements whose name, value or description contains it, or whose role is exactly it, with their contents and ancestors.
- A ref names one node within one target, run and navigation epoch. It keeps its name and stays usable for the life of that page generation, whatever is inspected later; a node that left the page fails its action explicitly.
- `type` focuses the field and refuses one that cannot take focus (hidden, disabled, behind a modal dialog), because native text insertion goes to the focused element. It then replaces the field's text by default (select, then native insertion, so framework input handlers fire); `clear: false` appends. Date, time, range and color inputs are validated before anything changes, then set with `input`/`change`, keeping the browser's normalization; email and number inputs append as a value. `select` picks native `<select>` options by label, else value, and dispatches `input`/`change` only when the choice changes; clicking an option ref picks that exact option. Results return the field value (passwords masked, rich text with its line breaks) or the chosen labels.
- `click` is a real pointer click at the centre of the element's visible part, refused when another element would receive it (hit testing respects `pointer-events: none`, and a label of the target counts as the target); an element without a visible box is activated programmatically. `click` on a native select asks for `select` instead of opening its out-of-page popup. `hover` and `scroll` (wheel on a ref or the page) use the same aiming. `drag` requires both ends already visible, without scrolling under a saved start point; its stepped pointer moves serve pointer-based drag libraries only. `press` dispatches a key or chord (`Enter`, `Shift+Tab`, `Control+K`, `Mod+K` = Meta on macOS) to the focused element, optionally focusing a ref first and refusing it unless focus actually moved there, and returns the newly focused element. Failed input sequences best-effort release held buttons/keys on their original channel without replaying the action. `wait` polls (≤ 15 s) for text in the rendered page or in labels, titles, placeholders and values, or for its disappearance. Native application-menu accelerators handled by the host may not see dispatched keys.
- Trust rule: in the CodeNomad window page functions run under `__codenomadAutomationDepth`, and every trusted DevTools input (pointer, wheel, keys, text insertion) under the short `__codenomadAutomationInputUntil` lease in `performance.now()` units. Ending it retains its end timestamp: `lib/automation-input.ts` checks the originating event's `timeStamp`, not when a stalled renderer handles it. Delayed automated keys and their same-turn implicit submit clicks remain automated after expiry. `form-answer-interaction.ts` refuses human provenance for those events, so automation can never produce the trusted dock click or key press a human Form answer requires. Never add unmarked trusted input to the application window, and never expose arbitrary script evaluation there.
- An input timeout has an **unknown outcome**: a busy renderer can deliver an already admitted key or click later, including when cleanup releases its held input. Cleanup still attempts release when its marker write times out, but never repeats the press. The tool explicitly instructs inspection before retrying; never automatically retry these inputs.
- The marker returns the page's own epoch timestamp for CDP mouse/key events. Cleanup retains the original press timestamp even if its marker renewal times out, so delayed releases remain within the original provenance interval independently of command-timeout settings. Missing/invalid provenance timestamps refuse before input dispatch.
- `packages/ui/tests/browser/automation-forms.test.ts` drives a real Chromium page and the real Mission editor through `DeveloperCdp`; `automation-input.test.ts` covers trusted input and proves that automation clicks and Enter in the real InterruptionDock never carry the human-answer header, while a real user click does.

### Guarded preview channel

The native hosts own the guests: their visibility, URL policy, storage, history, emulation, navigation and screenshots; page snapshots, refs and form input belong to the backend engine. The backend's `BrowserPage` serializes page operations per session and uses only the private native-parent `browser.page.begin/send/check/end` channel, never renderer IPC or Tauri commands.

Electron maps the channel's `Input.insertText` to `WebContents.insertText` and `Input.dispatchKeyEvent` to `WebContents.sendInputEvent` (including the character event when the key produces text): direct CDP text/key input can be silently ignored by a newly opened embedded/background guest until its first pointer click. These stay native inputs, never a value setter or framework-specific action; they require the same current lease and never show or raise the application window.

`begin` binds one expiring operation lease to the exact visible registered guest and document generation. Every `send` is bounded and allowlisted to the protocol methods the engine consumes; every `check` revalidates visibility, registration and document identity. Responses are fenced again after native I/O. A changed, hidden, ambiguous or missing target fails rather than switching guests. The backend owns refs per session and generation; it issues no refs from an unconfirmed read and never retries a failed mutation. `end` cleans up that exact lease even after cancellation or navigation, without detaching someone else's emulation overrides. A host without channel support fails explicitly.

Only fixed engine functions and protocol arguments cross this channel: models cannot choose protocol methods or evaluate scripts. Never grant guest pages application/native capabilities through it, nor expose the application's human-input provenance variables to preview pages. `tests/browser/automation-preview.test.ts` exercises both production ends against a real isolated Electron guest, with the window hidden to avoid desktop focus changes.

## Design constraints

Browser and developer tools ship together in this one bundled plugin (user decision), every tool available. Execution re-reads session ownership through the shared connection and validated worktree inventory; never let a plugin location or a caller-provided session ID alone grant access. The visible preview, its window, storage partition and permissions stay in the native hosts; the daemon stays independently owned and the connection-scoped compatibility adapter stays.

Native/HTTP deadlines bound browser tool execution; the tool context's `signal` is unused (`opencode/automation/desktop-plugin.ts`), so an interrupted turn leaves dispatched native work running until its deadline. Stronger cancellation needs end-to-end propagation and native tests.

## Native Hosts

Electron uses hardened `<webview>` tabs sharing one persistent browser partition (`persist:codenomad-browser-shared-v1`) per data profile/config pair. Attachment verifies guest ownership, allows only credential-free HTTP(S) URLs and denies permissions and downloads; page operations use the guarded channel above.

Windows Tauri uses a child webview owned by the local application window. Commands, capabilities, navigation checks, bounds, visibility, and storage are managed by `browser_controller.rs`. Application capabilities select primary `local-*` webviews, never their parent-window wildcard: Tauri combines window/webview matching with OR, so a window grant would also authorize an untrusted child. Full primary-renderer navigation disposes its preview children. Final-window decisions count native windows, including multi-webview windows. Other Tauri platforms use the iframe preview, without native browser automation.

The UI routes an autonomous open request to the one loaded instance containing the session, claims the request for one local window, selects that session, and opens its preview. Hidden or duplicate targets are rejected rather than selected implicitly.

## Focused Validation

- Server: `automation-plugin.test.ts`, `automation/desktop-plugin.test.ts`, `routes/automation-plugin.test.ts`, and the shared pruning-presence regressions
- Native discovery: build with `npm run build:automation --workspace @neuralnomads/codenomad`, then run `node scripts/test-automation-native.mjs <absolute-cli-path>`. The fixture uses an isolated daemon/config/database and exercises ordinary-project discovery, all tools at startup, execution fences, independent leases, shutdown and reopening. CI runs it against the minimum and latest OpenCode runtimes.
- Electron: `browser-controller.test.ts`, `browser-webview-security.test.ts`, preload tests
- Tauri: `browser_controller.rs` and `browser_controller_regressions.rs` tests, including actual capability resolution, primary-renderer cleanup, window counting, lock ordering and expired dispatch
- UI: `browser-frame-security.test.ts`, `lib/native/browser.test.ts` and `tests/browser/browser-frame-native.test.ts` (real Solid/Electron guests, insecure HTTP, registration disposal and Tauri IPC failure recovery). Linux Electron rendering requires a display; CI runs the browser suite under Xvfb.
- Session lifetime: `tests/browser/session-browser-history.test.ts` exercises the real instance shell/store, a real Electron guest and the Tauri IPC boundary across chat/session/project/Info transitions, the preview's X, retained Back history and project-wide URL migration.
- Shared site state: the same suite tests real Electron HttpOnly-cookie/localStorage sharing, independent documents/history, app-profile isolation and shared logout; Rust regressions verify Tauri's common persistent browser directory.

## Agent conventions

- Native session previews behave as tabs in one browser: share the persistent preview profile's cookies/site storage across sessions and projects within a CodeNomad data profile/config pair, but never with the trusted app renderer, remote-window profiles or the other desktop engine. Keep documents, navigation stacks, history cursors and automation attachments session-owned. Electron uses `persist:codenomad-browser-shared-v1`; Windows Tauri uses `browser/shared-v1`. Leave per-session preview profiles found on disk in place and never merge them into the shared profile: they can hold conflicting accounts. Iframe fallbacks keep their sandbox; never grant guests native capabilities.
- Browser preview state is keyed by project folder and session ID. Keep explicitly opened guests mounted in stable DOM order across chat/session/Info/project visibility changes; the preview's X also hides it and returns to chat without discarding history. Only their lightweight session shells remain: inactive transcripts and composers still unmount and the transcript memory budget stays independent. Hidden guests must stop being automation targets (Electron unregisters, Tauri hides). Saved project-wide URLs migrate once to the first restoring session. Across renderer restart, restore URL history/cursor only on explicit browser opening; never eagerly visit saved pages or persist native pageState/forms/POST bodies. Reuse owned CDP history IDs for live traversal and load just the selected saved URL when its native entry no longer exists. History is bounded to 32 credential-free HTTP(S) URLs/session within the 4 KB aggregate layout budget; trim history before evicting saved previews.
