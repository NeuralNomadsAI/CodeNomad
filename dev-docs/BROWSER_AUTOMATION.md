# Browser Automation

CodeNomad serves OpenCode's native browser tools (`tools.browser.*` and the built-in `browser` skill from `opencode.browser`, OpenCode 2.4+) directly from the visible web preview attached to each session.

## Integration and shared bridge

Browser previews are an ordinary desktop feature and must work in user projects outside the CodeNomad source checkout.

- While a local desktop view with browser automation capability shows a session (`packages/ui/src/lib/native-browser-hold.ts`), it holds that session on the local backend (`PUT/DELETE /api/native-browser/holds/:holdId`, local UI requests only: `localUiRequest` also refuses clients behind a loopback proxy).
- `NativeBrowserAttachments` (`packages/server/src/opencode/native-browser/attachments.ts`) keeps one attachment per session, whichever workspaces' views hold it. It attaches through a holding workspace that owns the session's location (`ownsLocation`), retrying while none does, and checks ownership again when each command's turn in the preview queue comes: `open` targets only verified owners, and a lost owner fails the command without reading the preview or publishing its inventory, then attaches again. Admission reads the session's current location, so a session moved elsewhere refuses its queued commands. Inventory publications run one at a time and each reads the tab at its turn, since OpenCode replaces its inventory with every one it receives; a queued command's publication is acknowledged before the next command runs. Each web open, and each preview replaced by another registration, gives the tab a new ID. Previews browse over the desktop's network, as the person's own preview does, so OpenCode's server-network tunnel (`tunnel.*`, its `/proxy` entrypoint) is not used: a WSL daemon's `localhost` reaches the desktop, which WSL2's default localhost forwarding connects to WSL servers. A refused inventory publication still sends the command's result, and a command that cannot be read is settled as failed. Probes, opens and loads report the preview registration, and an open or load that ends in another preview fails. Probes name the verified owners, so only a preview registered in one of their project tabs serves the session. It attaches to OpenCode's `experimental.browser` RPC (version 4) with a long-lived `headersTimeout: 0` dispatcher. Internal `rpc.experimental.browser.control` events are consumed on the server bus and omitted from UI SSE streams (`/api/events`); the relay can deliver one event per owning workspace, so each request ID runs once. Cancellation and the end of an attachment abort its commands; a native request already sent is not recalled.
- `PreviewTab` (`packages/server/src/opencode/native-browser/commands.ts`) exposes the session's visible preview as a single tab whose generation advances with the document witness. Commands run one at a time and each keeps the target it started on; the tab reports the document's title and history (`Page.getNavigationHistory`; WebKit previews report none). Supported operations are `tabs.list`, `tabs.open`, `tabs.focus`, `navigate`, `back`, `forward`, `reload`, `snapshot`, `find`, `click`, `hover`, `drag`, `fill`, `fill_form`, `select`, `check`, `press`, `scroll`, `wait`, `screenshot`, `console`, `network.list` and `network.get`. Options an operation cannot honor (frames, interactive or depth-limited snapshots, cache-bypassing reload, background `tabs.open`, middle, right or double clicks, element or full-page screenshots) are refused, never ignored. `select` matches option values exactly (`select-values`); `check` reads the state attributes after the ref and confirms the state after clicking; `press` refuses clipboard and context-menu shortcuts like OpenCode's own browser; screenshots above OpenCode's 5 MiB file limit fail, and a result OpenCode refuses still settles its request as a failure; agent clicks refuse file inputs and their labels, and Electron and WebView2 also intercept native file pickers (`Page.setInterceptFileChooserDialog`) for the length of each agent page lease, lifted again when the lease ends or fails, Linux WebKitGTK cancels `run-file-chooser` while one of the preview's page leases is held, and on macOS the vendored Wry's `set_file_panels_refused` cancels the page's file panels for each agent page lease; `wait` for load follows the native probe's `loading` state, which the tab also reports; a `click` or `press` the page received before its document changed (a followed link, a submitted form) succeeds and returns the tab on the document it led to. WebKit previews (macOS and Linux Tauri) answer `back`, `forward` and `reload` as unsupported. Refs follow OpenCode's `e<n>` format via a `BrowserPage` ref prefix. Unsupported operations (including `evaluate`) fail explicitly with `code: "unsupported"`.
- Console and network diagnostics follow OpenCode's desktop browser. Electron and WebView2 enable the `Runtime`, `Log` and `Network` domains on the preview's own protocol attachment, auto-attach out-of-process frames and dedicated workers paused at start (frames get the same domains in their sessions before they run; workers run and are left; every child is resumed even when its domains fail), and keep the listed raw events of the current document (`automation/page/diagnostic-events.ts`, generated `diagnostic-events.generated.json` for Rust) in a bounded buffer, each frame event tagged with its session. The buffer restarts its epoch when a main-frame navigation starts (WebView2: a new navigation ID, so redirects keep it) or `document.open()` replaces the document. Network events (with frame detaches) and the others have separate budgets, so a console flood never evicts a request's lifecycle; reads name, bounded like the buffer, the requests whose ending event (`loadingFinished`, `loadingFailed`, `webSocketClosed`, a WebSocket's handshake response or frame error) or frame detach was evicted unread, which the readout ends as failed instead of leaving pending; other lost events only count as drops. A readout whose tab or document changes while it is read fails with `document_changed`, and a web open reads the host's buffer before it navigates, so the new tab's readouts start with the open, its new page's startup included. WebView2 keeps one buffer per registration generation, so a candidate's setup or an older generation's removal leaves the published preview's. A new tab (a web open or another preview) starts with empty readouts; an event too large to keep whole keeps its console text cut past OpenCode's 2,000-character entry limit. The buffer also keeps the live execution contexts, which outlast epochs and evictions; only a frame's default context counts as the page's, as in OpenCode. The `diagnostics` page operation reads the events after a sequence number with the epoch, the live contexts and the epoch's console entries and requests evicted before any read; `response-body` reads one retained body in its frame's session. A body read fenced by a document change answers `document_changed`. `PreviewDiagnostics` (`opencode/native-browser/diagnostics.ts`, with the request machine ported from OpenCode in `diagnostics-machine.ts`) builds OpenCode's readouts: page-world console entries, Chromium log entries and uncaught errors (500 kept), requests with redirects and wire status (500 kept), `cookie`, `set-cookie`, `authorization` and `proxy-authorization` values redacted, and text bodies up to 20,000 characters. Electron starts capture when the guest is created, before its first load; WebView2 when the preview's webview is set up. WebKit previews answer diagnostics as unsupported.
- One bundled V2 plugin, `codenomad.automation`, is provisioned through native OpenCode plugin discovery in the selected host/WSL daemon namespace. Its definitions follow backend presence and expose `inspect`, `act`, and `screenshot` for CodeNomad's own desktop UI.
- Provisioning follows the `config.get` discovery-root, sibling `.codenomad/<SHA-256 of discovery root>/` lease and WSL rules in `OPENCODE_COMPATIBILITY.md`. A lease mtime update beneath the watched root would reload every loaded location; only the new directory receives heartbeats; missing discovery information is reported, never guessed.
- Developer inspection targets a local native window (including empty views). The invoking session identifies an owning backend and helps choose the first window; it need not be visible. `inspect({targets:true})` lists eligible windows and invocation-scoped session presence; `inspect({target})` selects an exact returned identifier. A plain inspection keeps its selected window. Actions retain the inspected window/run and document, independently of focus and project/conversation selection. Document changes require a fresh inspection; a lost window requires a new selection.
- `packages/server/src/server/routes/automation-plugin.ts` serves the `/api/opencode-plugin/automation` endpoint with the per-process token for developer inspection, Mission dispatch (`browser-claim` with Mission `purpose`, `mission-input`), and memory bridge calls.

An active backend publishes an ephemeral registration with a per-process 256-bit
token and removes it on graceful shutdown. All bridge discovery checks the
filename's publishing PID before reading the file: PIDs outside 1–2³¹−1 and
`ESRCH` establish absence; other process-probe errors retain liveness
conservatively. Best-effort pruning removes recognized local registrations whose
filename or parsed PID establishes absence. A file removed between enumeration
and open is absent. Windows PIDs belong to their host namespace, so WSL discovery
uses endpoint evidence for Windows registrations and leaves their files in place.
Windows path lookup reads `LOCALAPPDATA` as UTF-16LE from `cmd.exe /U`. It shares an in-flight lookup for the effective
distro/PATH, and ordinary discovery retains its cached result.
Missions' strict ownership and retry rules are in the [creation recovery contract](MISSIONS.md#mission-profile-selection-and-creation-recovery).

## Desktop instrumentation

Native instrumentation prepares the current desktop process at startup. Never launch or own another CodeNomad process, or start, stop or replace the shared OpenCode daemon through instrumentation.

Electron (`packages/electron-app/electron/main/developer-mode.ts`):

- Uses a persistent `developer-mode-browser-v2` browser directory inside the data profile, keeping the singleton and client-state identities unchanged.
- Enables a Chromium-assigned loopback CDP port and removes a stale `DevToolsActivePort` only after the stable singleton lock is acquired.
- Enables Chromium logging and Node source-map stack traces.

Windows Tauri (`packages/tauri-app/src-tauri/src/developer_mode.rs`):

- Uses a persistent local `developer-mode` WebView2 directory inside the data profile, leaving isolated remote-window profiles untouched.
- Gives only local WebViews `--remote-debugging-port=0`, then reads and verifies their `EBWebView/DevToolsActivePort` endpoint.
- Enables Rust backtraces and Node source-map stack traces for the managed backend.
- With the Rust server (`CODENOMAD_SERVER_IMPL=rust`), the host drives its own pages instead: no debugging port is opened. `automation/` holds the page engine and runs it on the inspected local window through WebView2's DevTools session, served as the private `developer.execute`; `browser.execute` runs preview snapshots and actions inside one `browser.page.*` lease. The Rust bridge issues conversation-scoped receipts for the inspected run, window incarnation and document. The trusted renderer programs in `functions.application.generated.json` and `developer.generated.json` implement the same live destination and provenance checks as the TypeScript adapter and never reach a preview. `engine.cases.json` contains the TypeScript engine's outlines, chords and per-action operation sequences for the Rust parity tests. Regenerate these assets with `scripts/build-page-function-registry.ts`.
- Retains the latest 32 contextual preview errors in memory for the lifetime of the native process (2,048 characters per log entry). `developer.status` includes them in its native snapshot `logs`; `codenomad.inspect` exposes them as runtime diagnostics. The error dialog keeps the complete native message, including its HRESULT, after the localized heading. Copy that detail or the inspection diagnostics when reporting a preview failure.

Packaged Electron main/preload/renderer, UI and server builds emit source maps. Local hosts sanitize inherited debugging flags; isolated remote-window profiles run without local instrumentation. Windows WebView2 is the supported Tauri CDP host. `packages/server/src/developer-cdp.ts` (`DeveloperCdp`) is the shared CDP controller and `opencode/automation-plugin.ts` the OpenCode adapter. `.opencode/skills/codenomad-automation/SKILL.md` holds the inspect, edit, build, relaunch, reconnect and evidence workflow.

Tool definitions captured earlier still go through execution-time checks, which refuse calls after backend shutdown or when the inspected native window, run or document changed; selecting another project or conversation keeps them valid. A WSL OpenCode plugin also discovers the Windows registration directory and reaches the Windows-only loopback listener through Windows interop under default WSL2 NAT. Its `curl.exe` requests use `--noproxy "*"` to bypass inherited proxies for that authenticated loopback endpoint. Provisioning migrates only recognizable generated entries and never overwrites a user-authored plugin.

Windows registry-path discovery in WSL uses asynchronous interop with bounded commands.
Memory admission cancellation reaches both discovery commands and registry scans;
only a qualified path is retained across calls.

`codenomad.act({ action: "restart" })` relaunches the inspected desktop scope (data profile, original config source, executable and Electron app artifact) through the native graceful shutdown. The bridge verifies the current inspection pin and sends its window UUID, incarnation, native scope and run ID with a fresh restart ID to `developer.restartScope`. The host rechecks the exact window before shutdown. The relaunch uses ordinary window restoration and preserves the profile manager's next choice.

Electron's scope binds the physical main module as well as the package root. Direct CLI launches relaunch the resolved script; directory launches keep the package root and require a fresh Electron-compatible entry resolution before admission. The filesystem can still change between admission and the native loader opening the entry; the next CodeNomad run checks the resulting identity before restoring the scope.

`developer-reconnect` checks a new registration for the one-shot restart handoff in a new run of the same scope. It reports a missing UUID, waits for a loading window, or issues a fresh inspection pin for the original UUID's new incarnation. Reconnection uses the same renderer identity and session-ownership checks as ordinary inspection. Transport uncertainty permits read-only reconnection; never resend the restart. Mixed versions refuse restart.

A restart acknowledgement or uncertain delivery retires the run's inspection pins, refs and pending CDP reads. If the profile stays open, a fresh inspection of an exact ready window can issue a new pin.

- The HTTP bridge and CDP endpoint use IPv4 loopback only. The bridge requires its random token. Raw CDP has no authentication and can execute code in authenticated renderer pages, so it trusts local processes; the bridge keeps its token and session/window selection checks.
- Initial discovery prefers a window visibly showing the invoking session, then a window with that session selected in an inactive tab, then a ready window. Focus and local recency break ties within a profile; equally ranked profiles require an explicit selection. Preferences and remote windows are never targets. `developer.targets` supplies the ready local inventory; `developer.status {runId,windowId,windowInstance}` validates the pinned incarnation, including when another window reuses the saved window ID.
- Operations for one native window incarnation are serialized. Immediately before native dispatch, the marked document root checks the current window, the active tab for new input, and the live viewport hit or keyboard focus, including the exact element for ref actions. An ambiguous closed-shadow destination is refused. Inspection and screenshot revalidate after capture.
- Actions, ref expansions, screenshots and restart require the exact receipt from a successful inspection in the invoking session. The OpenCode adapter retains it privately for the inspected window. Without a receipt, another inspection of the selected window sends its exact identifier and verifies the returned window before presenting the outline.
- A newer selection takes precedence over a pending reconnect; the bridge checks before reading CDP and before publishing the restored window's pin.
- Registration files, bridge responses, target probes, diagnostics, accessibility snapshots, screenshots, request bodies and reconnect time are bounded.

## Page engine

`codenomad.inspect` / `codenomad.act` (the CodeNomad window) and OpenCode's native `tools.browser.*` (the session preview) run on the same page engine in `packages/server/src/automation/page/`. `protocol.ts` defines the semantic `PageDriver`: normalized tree, stable node/handle resolution, predefined function calls with JSON arguments, geometry, viewport, hit testing, native input, handle release and checkpoints. `cdp-driver.ts` adapts that contract to DevTools; `native-driver.ts` uses the fenced parent channel. `snapshot.ts` retains the outline renderer and budgets, `actions.ts`/`input.ts` retain action orchestration, `keys.ts` maps chords, and `refs.ts` owns document-scoped references. The app uses `DeveloperCdp`; previews use `automation/browser-page.ts`. The preview's `snapshot({ ref })` and `find({ text })` have the same outline and scoping as the app's `inspect` with `ref` and `query`.

- Inspection is an indented outline with refs, read as plain text. Wrappers, unnamed images and text repeating its parent's name are dropped; fields show their value instead of their inner nodes; native selects list their options with `selected`/`disabled`. A character budget (32 000 by default) is shared among siblings: small parts stay whole while large ones collapse in place with `(+N hidden)` or `(+N more)`, keeping their first and last items, so nothing is cut silently. `ref` expands one subtree and `query` keeps elements whose name, value or description contains it, or whose role is exactly it, with their contents and ancestors.
- A ref names one node within one target, run and navigation epoch. It keeps its name and stays usable for the life of that page generation, whatever is inspected later; a node that left the page fails its action explicitly.
- `type` focuses the field and refuses one that cannot take focus (hidden, disabled, behind a modal dialog), because native text insertion goes to the focused element. It then replaces the field's text by default (select, then native insertion, so framework input handlers fire); `clear: false` appends. Date, time, range and color inputs are validated before anything changes, then set with `input`/`change`, keeping the browser's normalization; email and number inputs append as a value. `select` picks native `<select>` options by label, else value, and dispatches `input`/`change` only when the choice changes; clicking an option ref picks that exact option. Results return the field value (passwords masked, rich text with its line breaks) or the chosen labels.
- `click` is a real pointer click at the centre of the element's visible part, refused when another element would receive it (hit testing respects `pointer-events: none`, and a label of the target counts as the target; the `hit-test` operation carries viewport coordinates, which CDP hosts shift by the layout viewport's scroll offset because `DOM.getNodeForLocation` takes document coordinates); an element without a visible box is activated programmatically. `click` on a native select asks for `select` instead of opening its out-of-page popup. `hover` and `scroll` (wheel on a ref or the page) use the same aiming. `drag` requires both ends already visible, without scrolling under a saved start point; its stepped pointer moves serve pointer-based drag libraries only. `press` dispatches a key or chord (`Enter`, `Shift+Tab`, `Control+K`, `Mod+K` = Meta on macOS) to the focused element, optionally focusing a ref first and refusing it unless focus actually moved there, and returns the newly focused element. Failed input sequences best-effort release held buttons/keys on their original channel without replaying the action. After an HTTP(S) navigation Chromium drops key, click and wheel input until the page's first paint, or about 500 ms after rendering starts (paint holding); every trusted input sequence first waits until the page has painted or roughly that limit has passed since it became interactive, at most one second (`awaitInputAcceptance` in `protocol.ts`), so input sent right after a load is delivered rather than lost. `wait` polls (â‰¤ 15 s) for text in the rendered page or in labels, titles, placeholders and values, or for its disappearance. Native application-menu accelerators handled by the host may not see dispatched keys.
- Trust rule: in the CodeNomad window page functions run under `__codenomadAutomationDepth`, and every trusted DevTools input (pointer, wheel, keys, text insertion) under the short `__codenomadAutomationInputUntil` lease in `performance.now()` units. Ending it retains its end timestamp: `lib/automation-input.ts` checks the originating event's `timeStamp`, not when a stalled renderer handles it. Delayed automated keys and their same-turn implicit submit clicks remain automated after expiry. `form-answer-interaction.ts` refuses human provenance for those events, so automation can never produce the trusted dock click or key press a human Form answer requires. Never add unmarked trusted input to the application window, and never expose arbitrary script evaluation there.
- An input timeout has an **unknown outcome** once the input has been sent: CDP can still deliver it later. Every release requires a fresh destination check, even after a tab change within the same document. A mouse release requires the same checked recipient as the press or final drag move. A drag can pin the element holding capture from the press's composed path, including an ancestor; capture loss retires that recipient. The observed drag source may follow the pointer and cover the destination without capture. A stalled renderer or changed destination can leave a press without its release. A click may remain incomplete, and a key may already have moved focus or dismissed its own ref. If the final focus read fails, the action reports that the key was sent. The check and dispatch are separate CDP commands, so already admitted input remains the browser's to deliver. Inspect before retrying; never replay a press or a release already sent.
- The application checks the active occurrence in the same renderer call as a direct field update, selection deletion or option selection. Deletion checks the focused field's writability and the browser command's result. Native select actions recheck option identities after focus handlers run and refuse a changed option list. A label hit can stand in for its associated control.
- The marker returns the page's own epoch timestamp for CDP mouse/key events. Cleanup retains the original press timestamp even if its marker renewal times out, so delayed releases remain within the original provenance interval independently of command-timeout settings. Missing/invalid provenance timestamps refuse before input dispatch.
- `packages/ui/tests/browser/automation-forms.test.ts` drives a real Chromium page and the real Mission editor through `DeveloperCdp`. `packages/ui/tests/browser/automation-input.test.ts` covers live hit/focus checks, scrolled iframes, and delayed InterruptionDock input. Delivered automation never carries the human-answer header; a direct user click does.

### Guarded preview channel

The native hosts own the guests: their visibility, URL policy, storage, history, emulation, navigation and screenshots; page snapshots, refs and form input belong to the backend engine. The backend's `BrowserPage` serializes page operations per session and uses only the private native-parent `browser.page.begin/send/check/end` channel, never renderer IPC or Tauri commands.

Electron maps the channel's `Input.insertText` to `WebContents.insertText` and `Input.dispatchKeyEvent` to `WebContents.sendInputEvent` (including the character event when the key produces text): direct CDP text/key input can be silently ignored by a newly opened embedded/background guest until its first pointer click. These stay native inputs, never a value setter or framework-specific action; they require the same current lease and never show or raise the application window.

`begin` binds one expiring operation lease to the exact visible registered guest and document generation. Every `send` is bounded and allowlisted to semantic operations; every `check` revalidates visibility, registration and document identity. Responses are fenced again after native I/O. A changed, hidden, ambiguous or missing target fails rather than switching guests. The backend owns refs per session and generation; it issues no refs from an unconfirmed read and never retries a failed mutation. Once `begin` may have reached the host, `end` cleans up the exact lease even after a lost reply, cancellation or navigation, without detaching someone else's emulation overrides. A host without channel support fails explicitly.

Preview navigation, screenshots and page lease admission carry the probe's `target` beside `sessionID` and revalidate it before native dispatch. Screenshots keep the exact document through capture. Open uses an exact occurrence claim instead of a document witness; both paths use the same native navigation and load receipt for the admitted registration.

Electron and Windows Tauri observe private CDP `Page.documentOpened` events before issuing a witness. A main-frame document stream reopened at the same URL revokes that guest's witness and page lease, independently of native navigation and load completion. Electron attaches its debugger and enables the Page domain when the guest is created, and keeps that attachment, with the diagnostics it feeds, for the guest's lifetime; hide and unregister end page leases only, preserving emulation overrides. Tauri installs the receiver and enables the Page domain during WebView2 creation; the receiver follows that native view's lifetime.

`begin` announces `driver: "cdp" | "webkit"` and `contractVersion: 1`. `send` accepts one closed `operation` union: tree, resolve, call, scroll-into-view, geometry, viewport, hit-test, pointer, wheel, keyboard, insert-text, release-handles, checkpoint, and on Electron and WebView2 diagnostics and response-body. Both native hosts reject unknown operation fields, function IDs and argument shapes. Calls carry a registered function ID, opaque target handle and JSON arguments. The hosts obtain executable programs from their own shared fixed registry; the private wire carries operations rather than protocol methods or program text. WebKit implements these operations through its isolated program and target-local native input adapters.

WebKit's fixed isolated-world reader bundles `dom-accessibility-api` 0.7.1 (MIT, notice included in the program and `webkit/LICENSE.dom-accessibility-api`). It computes names, descriptions and roles and adapts native field states to the shared renderer. Password values use the shared read-value policy's maximum sixteen masking bullets. Hidden, inert and ARIA-hidden branches are excluded. Open and captured closed shadow roots and same-origin frames are traversed; cross-origin frames receive an opaque, non-actionable boundary marker. Chromium's main-frame `Accessibility.getFullAXTree` exposes closed-root controls and frame elements, with frame contents available through separate frame-tree requests.

A fixed document-start page-world hook weakly associates each host with its `attachShadow` root, preserving wrapper identity for the host's lifetime. A synchronous host-bound reply carries one undispatched PointerEvent in its predicted-event list. Its native `relatedTarget` retains the root without shadow retargeting or JavaScript-value serialization. These vendor-named, untrusted reference messages stay separate from native input delivery. Host-bound listeners support nested roots and document recreation. The isolated reader invokes native event getters, validates ShadowRoot brand, exact host, mode and owner document, and rewraps the root before traversal or ref resolution. Forged endpoints receive an explicit unavailable marker. The bridge consumes PointerEvent constructor prediction lists and `getPredictedEvents`. Declarative parser-created closed roots are opaque: parser attachment bypasses the JavaScript hook and consumes its template outside document mutation observations. Their rendered controls stay outside WebKit snapshots and refs.

Each WebKit document owns weak numeric node identities and opaque token-prefixed handles, bounded to 20,000 live nodes. Mutation observations retire removed identities even after reinsertion; document recreation and pagehide rotate the document token. Subframe pagehide retires that document's nodes. Lifecycle listeners are reinstalled after document streaming recreation. Fragment and History API changes preserve identity. Native reads pass JSON as JavaScript argument dictionaries in a retained named content world, with loading, registration, visibility, deadline and document checks around native callbacks. The isolated reader checks the lease's document token before executing an operation; numeric node operations require it. Hidden, closed and replaced guests revoke leases. Regenerate the program and native header with `node --import tsx scripts/build-webkit-read.ts`; run `node --import tsx scripts/compare-webkit-read.ts` for CDP/read-program comparisons on the shared Electron HTML fixtures.

WebKit aiming uses visible client rectangles, same-origin frame clipping and composed affine DOMMatrix transforms, including rotation and reflection on frames and their ancestors. Bounding boxes anchor layout, scroll and transform-origin translations; deep frame hit testing uses the inverse matrix. Perspective, singular matrices, independent CSS transforms, motion paths and frame boxes that cannot be mapped exactly return a typed unsupported error before scrolling or native input. Top-level transformed targets retain viewport rectangles and native hit-test validation. Click, hover, ref-wheel and both drag endpoints share this aiming path. Native wheel dispatch also requires an isolated hit test. Form preparation, special-value setters, select validation/events and result masking share the fixed registry. Contenteditable selection uses `Selection.setBaseAndExtent`, including editing hosts inside shadow roots. Wait searches the semantic tree plus field attributes/values, including captured roots and same-origin frames, with the shared fifteen-second polling bound.

Native input dispatch follows an isolated document preflight and registration/navigation/deadline checks on the UI thread and at completion. History sampling publishes URL metadata; native navigation/load callbacks fence documents. Each lease retains at most 64 pending key/button releases before admitting downs. `end` and expired-lease admission best-effort release that exact document; an outstanding release fenced by same-document navigation can renew its document check once. Completed releases and input mutations are never replayed. The adapters target the guest view directly, with native text insertion and explicit modifier transitions, preserving desktop focus and the physical pointer.

Background WKWebView has qualified input limits: an initial standalone hover after navigation can omit `pointerenter`; a Meta editing equivalent such as `Mod+A` selects through its native responder while consuming the main `A` keydown before DOM listeners. Meta down/up and the following Enter down/up are delivered in the real parent-channel action flows. Native application-menu shortcuts retain the host handling described above.

`functions.ts` owns the fixed program source and argument metadata. Electron uses it directly, and Tauri compiles `functions.generated.json`. Application input-provenance functions belong only to the trusted application's direct CDP driver. Never grant guest pages application/native capabilities through this channel, nor expose the application's human-input provenance variables to preview pages. `tests/browser/automation-preview.test.ts` exercises both production ends against a real isolated Electron guest, with the window hidden to avoid desktop focus changes.

The hidden Electron fixture supplies visible ownership to the controller. Before input, its preparation waits for the loaded guest's non-empty hidden `capturePage` within one monotonic 10 s load/capture budget, retaining the exact guest while its window stays hidden and unfocused. `automation-preview-preparation.test.ts` executes the fixture against fake Electron objects to check loading, capture errors, guest replacement, owner state, deadlines and timer cleanup.

## Remote preview content transport

`codenomad-servers/preview-capabilities.ts` owns a lazy, content-only IPv4 loopback
listener. Each remote preview receives a fresh `<capability>.preview.localhost`
origin on that listener's ephemeral port. Every HTTP path and WebSocket upgrade
on the listener resolves only through that capability's remote preview token.
Responses use a sandbox with `allow-same-origin` on that capability's exclusive
content origin and the existing remote path proxy's asset/runtime rewriting.
HTTP Origin carriers, CORS preflights and WebSocket upgrades bind to that exact
origin; opaque/null and foreign Origin carriers are refused before upstream
dispatch. `Cross-Origin-Resource-Policy: same-origin` protects no-CORS resources.
The sandbox's `frame-ancestors` admits the content origin and its issuing local
UI origin, captured during guarded creation. Request cookies and authorization, response
cookies and remote connection credentials stay outside content traffic, matching
the local path-preview policy.

The owning local UI creates a capability with
`POST /api/backends/:id/preview-capabilities` and `{ sessionId, url }`, carrying its
current `X-CodeNomad-Backend-Authority` header. The response is
`RemotePreviewCapability`: the remote preview plus `capability` and `contentUrl`.
Issuance retains the backend generation through remote creation and publication.
`DELETE /api/backends/:id/preview-capabilities/:capability` jointly revokes the
capability and its HTTP/WS transfers; deleting the collection detaches that
generation's previews across listeners. Both operations retain the original
authority header. Retargeting, removal, Forget, observed identity change and
backend shutdown also revoke transfers. Remote token deletion is best-effort
under that original generation.

The session preview store uses the owning client's capability API for remote
projects. Same-application navigation reuses its capability; changing application
origins creates a replacement. `BrowserFrame` separates the loaded source from
the displayed application address and maps native history entries before storing
their logical URLs. Remote dismissal releases live authority while retaining
saved logical history. Tab detachment and attachment revocation fence pending
creation/restoration and release live capabilities; `pagehide` uses keepalive
deletion. Internal content URLs remain confined to embedded loading. Unmapped
native commits admit only external HTTP(S) site addresses as navigation requests. The
`isolatedOrigin` frame policy requires origin-bound HTTP/WS admission on its
host-issued content origin.

Native remote previews pass a logical address with their registration. Their
native presentation keeps the content capability private: native context menus,
clipboard exports, link dragging, printing, pop-ups, downloads, page dialogs and permission prompts
are suppressed. Electron's guarded before-unload fallback uses the logical
origin or CodeNomad as its title. WebView2 hides its native status bar; WebKit
disables link previews/tooltips. The fixed privilege-free
`lib/native/remote-preview-guards.cjs` document-start program applies only to
private preview origins. Ordinary native previews retain their browser policy.

Service-worker script requests are refused on the isolated listener before
transport construction or upstream dispatch. `Service-Worker-Allowed` stays
outside the response allowlist. An expired content origin's network response
carries `Clear-Site-Data: "storage"` as best-effort cleanup; the control API
retains the trusted UI's storage. A worker-synthesized response can bypass
network headers, so registration prevention and fresh capability origins own
the authority boundary.

### Remote-client path capabilities

Remote clients (Remote Control devices, verified direct HTTPS, admitted LAN HTTP
and their PWAs) cannot resolve `preview.localhost`. With `multiBackend` enabled (the default), the
same creation route issues them a host path capability instead:
`contentUrl` is `/previews/<capability>/…` on the page's own origin, and the
remote token stays private. Creation uses the authenticated UI guard
(`isBackendUiRoute()` admits only POST of the collection and DELETE of one
capability; generation-wide detachment stays local) and binds the capability to
its issuing principal (`relay-principal.ts` `lifetime()`), its channel (ingress
socket or direct listener) and exact public `Host`. Logout, idle/absolute expiry,
password replacement, device revocation or expiry, Remote Control Stop for tunnel
devices, the host's **Web previews** switch for paired devices, server
remove/retarget/Forget and owner deletion revoke it and close its HTTP and WS
transfers. Admission and publication read current authority without extending
its lifetime. Explicit invalidation is synchronous; the device expiration and
availability check supplements it for idle transfers. Only the issuing principal
can delete it.

Content is cookie-free. `/previews/:token` routes and the preview upgrade handler
hand capabilities they do not own locally to `RemotePreviewCapabilities.servePath()`
/ `upgradePath()`, which reuse the generation owner's pinned transport and the
isolated listener's header filtering. They accept only absent or `null` Origin,
the issuing channel and Host, and refuse service-worker script requests. Responses
carry `sandbox` without `allow-same-origin` plus `frame-ancestors 'self'`,
`Referrer-Policy: no-referrer` and `Access-Control-Allow-Origin: null`; same-origin
CORP is omitted because the opaque document's own no-CORS loads would fail it.
HTML, CSS and JavaScript bodies and `Location` replace the remote prefix with
the host capability prefix, which also retargets the remote runtime bridge's
fetch/XHR/WS/SSE rewriting. Body replacement preserves the surrounding bytes and
omits the origin's representation validators and range headers; partial text
responses are refused. The source and host use the same MIME classification,
including the exact JavaScript essences from WHATWG MIME Sniffing. Each proxy
admits four active rewrites of up to 16 MiB per document and queues up to 32
paused inputs in arrival order without allocating rewrite buffers for them.
The 15-second deadline covers queueing, rewriting and downstream completion;
disconnect or authority revocation cancels the wait. The source rewrites
UTF-8, UTF-16 and supported
ASCII-compatible legacy text in its original charset, after streaming
decompression for gzip, deflate or Brotli if needed. The host substitutes the
prefix in place. The host also admits up to 128 pending and live relay preview
records together. Binary bodies and SSE stream without a rewrite slot;
WebSocket messages pass through unchanged.

`remotePreviewContent()` (`lib/remote-preview-address.ts`) resolves either form;
`BrowserFrame`'s `opaqueSource` keeps the iframe sandbox without
`allow-same-origin` and expects `null` message origins, while the logical
address and history mapping stay as for isolated sources. Previews sharing the
public hostname have distinct opaque origins: they cannot script, frame or
store into each other, reach application APIs or register workers. Chromium
sends no Referer or Fetch Metadata from these documents, so HTTP/WS reads between
previews rely on keeping capability URLs private. CodeNomad keeps remote-client
bearer URLs out of its own logs and saved logical preview history. A same-preview
`Location` may carry the public capability. Browser navigation history and
reverse-proxy access logs may retain bearer URLs, and plain HTTP exposes them
in transit. Treat these URLs as secrets and prefer HTTPS.

Remote project preview controls and preview links wait for metadata from both
the host and the project's attached backend. A host event-stream open lets mounted
views recover missing host metadata through the shared cache. If the initial read
is still pending, recovery waits for it and shares one follow-up read on failure.

#### Preview transport validation

`preview-capabilities.test.ts` covers content-origin reservation, equal remote
tokens on separate backends, guarded issuance, real HTTP/WS exchange, SSH
destination ownership, revocation and the real remote CodeNomad path proxy.
`tests/browser/remote-preview-origin-isolation.test.ts` drives Chromium against identical remote
tokens to qualify fetch/XHR/WS, no-CORS scripts/images/fetch, iframe embedding,
opaque callers and legitimate own-origin resources.
`remote-control/remote-client-previews.test.ts` drives two controlled A/B remotes
with identical tokens through Remote Control, a TLS reverse proxy and a real LAN
interface: rewriting, fetch/preflight/redirect/SSE/WS, hostile refusals and each
revocation row. `tests/browser/remote-preview-path-isolation.test.ts` qualifies
the opaque path documents in Chromium, including UI embedding and sibling,
application, worker and Referer probes.

## Design constraints

Execution re-reads session ownership through the shared connection and validated worktree inventory; never let a plugin location or a caller-provided session ID alone grant access. Keep the connection-scoped compatibility adapter.

Native/HTTP deadlines bound developer automation tools; the tool context's `signal` is unused (`opencode/automation/desktop-plugin.ts`), so dispatched work continues until its deadline after turn interruption. OpenCode's browser tools cancel through the attachment instead (see above).

## Native Hosts

| Desktop host | Native preview/history | Agent browser automation | Device profiles | Pop-ups / downloads / dialogs |
| --- | --- | --- | --- | --- |
| Electron | Chromium | Supported | Chromium mobile | Supported |
| Tauri Windows | WebView2 | Supported | Chromium mobile | Supported |
| Tauri macOS 14+ | WKWebView | Supported | Native WebKit mobile | Supported |
| Tauri Linux | WebKitGTK | Supported | Native WebKit mobile | Supported |

Browser automation uses the visible owned session target on every native desktop
host. Driver/profile availability follows the compiled native adapter and the
host-published capability contract. Unsupported hosts and unknown semantic
operations fail explicitly. Engine-specific input, shadow-root, clipboard and
mobile-profile limits are specified below and in `BROWSER_DEVICE_EMULATION.md`.

Electron uses hardened `<webview>` tabs sharing one persistent browser partition (`persist:codenomad-browser-shared-v1`) per data profile/config pair. Attachment verifies guest ownership and accepts credential-free HTTP(S) entry URLs. Owned pop-ups retain the preview partition and native opener; site documents additionally support `about:blank` and same-origin blob URLs. Camera, microphone, geolocation and notifications are denied. Other classified permissions use origin-bound consent or an explicit device/source chooser; unknown requests are denied with an error. Page operations use the guarded channel above.

Tauri uses a child webview owned by the local application window: WebView2 on Windows, WKWebView on macOS 14+, and WebKitGTK on Linux. Pages load directly in the native view. `embedded_view.rs` owns native creation, geometry, visibility, closure, shared storage and mandatory credential-free HTTP(S) navigation, permission, download and new-window protections; its Windows adapter also installs native accelerators. `browser_controller.rs` owns session registrations, renderer generations, history, events, emulation and automation leases. Application capabilities select primary `local-*` webviews, never their parent-window wildcard: Tauri combines window/webview matching with OR, so a window grant would also authorize an untrusted child, including localhost content. Full primary-renderer navigation disposes its preview children. Final-window decisions count native windows, including multi-webview windows.

Native views follow the preview bounds and hide beneath local menus, lists and dialogs. Reshow applies the latest bounds before revealing the retained document. Windows/GTK HTML fullscreen fills its owning window, preserves normal guest bounds and the previous window mode, and restores both on exit/hide/close; WKWebView uses native fullscreen. WebKit Back/Forward uses each view's native back-forward list, with registration-owned entry identities and a 32-entry journal; restored sessions load the selected saved URL on explicit opening. WebKit presets apply fitted native CSS viewports and per-view mobile identity, with density/input differences specified in `BROWSER_DEVICE_EMULATION.md`. Element comments are unavailable in native previews.

Local Tauri primary renderers receive `__CODENOMAD_BROWSER_CAPABILITIES__` during initialization, with independent `embedding`, `history`, `emulation` and `automation` flags. WebKit publishes all four true and `reason: "webkit"` for its native profile hints; unsupported targets publish `reason: "unsupported-platform"`. UI host selection consumes this contract; registration/history readiness stays independent of device emulation. UI registrations request hidden construction and recheck `localOverlayOpen()`, clipped bounds and display scale before the first reveal, including asynchronous construction beneath a dialog. WebKit registration/update/profile commands await native scale and configuration off the UI thread.

Agent browser automation (`tools.browser.*`, including open, probe, history/reload and page actions) routes through the authenticated backend and guarded native-parent channel on Electron and Tauri Windows/macOS/Linux. Plain-browser and remote-view clients use the sandboxed iframe proxy.

The iframe proxy's HTTP, asset fallback and WebSocket connections pin one DNS
lookup's answers and refuse the backend's live listening addresses/ports before connecting
(`server/proxy-destination.ts`; boundary details in `REMOTE_CONTROL.md`).

The Tauri launcher pipes backend stdin and sets `CODENOMAD_NATIVE_PARENT=1` after shell-environment resolution on Windows, macOS and Linux. The private channel fences requests and responses against the backend process generation and absolute deadline. WebKit's internal open, navigate, probe and visible-PNG operations use the common target/open-claim registry, with native navigation completion/failure callbacks and registration/document checks around capture. Native adapter code is compiled only for its target platform.

Supported Tauri hosts publish `CODENOMAD_NATIVE_BROWSER_AUTOMATION=1` independently of transport readiness and retain `CODENOMAD_TAURI_WEBKIT` for host identity. The authenticated bridge validates session ownership and native availability; the UI's open-request subscription follows embedding availability. Mission-only ownership claims retain their normal admission path. Desktop transport/capability markers are stripped from the shared daemon's startup environment.

Use `tabs.open` with a credential-free HTTP(S) URL to recover a preview showing `about:blank` or an engine-generated error document, then take a fresh snapshot. `navigate` uses the preview witness from the command's own probe. WebKit failure results survive the subsequent load-finished notification; fragment-only navigation completes from the confirmed native URL when document-load callbacks are absent. Capture responses retain the 16 MiB base64 limit, and a hide, close, replacement, navigation or expired backend generation fences the native callback result.

Native browser previews support OAuth pop-ups and downloads. Pop-ups are small native windows owned by the local main window; native related-view/configuration/environment APIs preserve the preview store, opener, postMessage, blank-window document writing and script closure. Typed/restored URLs accept credential-free HTTP(S); site navigation also accepts blank documents and blob documents from the observed main-document origin. File and application schemes remain blocked. Closing the opener or reloading/closing the primary renderer disposes its pop-up tree. Application capabilities, application preloads, page Node access, app IPC initialization and app resource protocols stay outside guests and their pop-ups. Remote embedded-view consumers retain their separate policy.

Downloads go directly to the system Downloads directory, with sanitized UUID-prefixed names and no automatic file opening. Windows and Electron atomically reserve names; WebKit refuses existing destinations. WebKitGTK disables overwriting and routes context-wide download signals to the originating view. Missing Downloads directories fail closed. HTTP(S), blob and data downloads use this policy, subject to the engine's multiple-download consent. WebKitGTK turns rejected data document requests into downloads. Tauri supplies native alert/confirm/prompt dialogs; macOS uses asynchronous AppKit sheets. Electron supplies native alert/confirm and a preview-only prompt preload registered on the separate browser session. This preload exposes only standard `window.prompt` on top-level pages, pop-ups and subframes, using the fixed synchronous `codenomad:browser-prompt` channel. Main validates guest ownership, frame membership and bounded string payloads, and returns string/null from a trusted preload-free app form. Electron's subframe preload gate is enabled with explicit sandbox, context isolation and page Node access disabled. Only the prompt preload is registered on the preview session. Device/source selection uses that same scrollable form.

Camera, microphone, geolocation and notifications remain denied on every host. WebView2's two permission layers deny those four kinds and return classified requests to native consent; unknown raw kinds are denied and reported. Electron shares a typed policy between permission checks and requests, keys grants on the requesting frame's origin, permits Chromium's sanitized clipboard writes and uses native consent for reads/local-network and other classified requests. HID/USB/serial and display capture require explicit selection; serial requests require an unambiguous frame. WebKitGTK storage-access requests use native domain-scoped consent. Its page-scoped pointer-lock request identifies the displayed native document and fences answers by load generation; requests lacking sufficient identity are blocked with an error. Engine APIs and hardware determine availability. On macOS, the native **Paste** button performs user-initiated clipboard paste. Preview TLS validation, web security and the WebView2 F6 crash guard remain active.

WKWebView preview delegates implement WebKit's native print and beforeunload callbacks from `WKUIDelegatePrivate.h`. Printing uses the public `printOperationWithPrintInfo:` API and the system print panel; beforeunload uses the initiating-frame-labelled confirmation sheet. Requalify these selectors on supported macOS/WebKit updates.

Native popup-window close requests run WebKitGTK `try_close`, WKWebView `_tryClose`, or WebView2's CDP `Page.close` before native disposal. These host operations remain independent of mutable page globals and preserve beforeunload decisions. A cancelled beforeunload retains the popup. Owning-window/opener cleanup and primary-renderer replacement dispose their preview tree directly; page work must be saved before these operations.

Cleanup invalidates all selected descendants, including pending construction, before native destruction. Electron binds roots and nested pop-ups to the physical owner and opener and rotates document identities on navigation or renderer failure. Pending prompt/device/display responses and context-menu callbacks recheck their captured identity. Tauri removes a selected subtree under one registry lock, fences native callbacks by creation token, and checks the opener's document generation before publishing a new pop-up. Main-document load start disposes descendants. Owner shutdown and cleanup use forced native disposal; individual user popup closure retains the engine's beforeunload decision.

GTK pointer-lock consent uses a native `GtkInfoBar` on the owning surface. Its buttons retain the WebView's focus on click and offer native mnemonics; load start cancels the bar and the document-generation fence validates the answer. A separate modal surface can cancel WebKit's pending Wayland lock request. Qualification checks the compositor's `zwp_locked_pointer_v1.locked` event as well as DOM state and Escape release.

Affected WebKitGTK builds, including 2.52.6, block `DataTransfer.files` as a security measure for CVE-2025-13947. The system engine's `DataTransfer::allowsFileAccess()` returns false for non-Cocoa ports; the native fixture and a plain WebKit control reproduce an empty FileList with genuine GTK file drags. Keep this protection and use the page's file input. [WebKit 323277](https://bugs.webkit.org/show_bug.cgi?id=323277) tracks the secure separation of native file grants from web-writable URI text; never convert arbitrary dropped URI text into host file reads.

WebKitGTK clipboard writes and native Ctrl+C/V use the engine's user-initiated paths. Async Clipboard reads reach `WebKitClipboardPermissionRequest`, whose public API supplies allow/deny without a requesting-frame identity. The preview policy refuses this request and reports the native permission kind; users can paste into the page with Ctrl+V. Keep permission attribution frame-bound rather than substituting the displayed top-level origin.

### Tauri embedded-view contract

- Consumers choose a unique native label for each creation, including replacements, and a persistent storage descriptor separate from the application renderer. Windows/Linux preview storage is `browser/shared-v1` inside the scoped profile. macOS uses a WebKit-managed identified store. The common registry binds each child to a validated local-window owner before native construction. Every bounds, visibility and close operation rechecks ownership; native calls run outside registry locks.
- WebKit adapters use the same registry and construction guards. Linux installs a consuming `permission-request` denial before target navigation. macOS installs per-instance media denial through Tauri's native `on_permission_request` builder callback during construction. Its persistent data-store identifier is the first 16 SHA-256 bytes of length-prefixed UTF-8 domain, profile key and normalized configuration identity, with domain `browser/shared-v1`. Tauri requires macOS 14 for identified stores. Mandatory guard installation failures close the child and return an error.
- The GTK runtime installs one lazy overlay per owning window: primary content remains in a box, native children occupy a fixed overlay below the menu bar, and uncovered pointer input reaches the primary renderer. Wry persists child geometry in GTK layout properties across reallocations and resolves bounds/reparenting against the actual parent. The native regression under `vendor/tauri-runtime-wry-2.12.3/examples/` covers both display backends and independent owning windows.
- Creation uses an off-canvas neutral document, hides the child, installs mandatory protections and applies physical bounds while hidden. Creation failures remove only their exact reservation and close the created child. Consumers may further restrict navigation; preview documents keep the mandatory URL, ownership, permission and download policy. Main-document load events establish blob ownership. Browser roots/pop-ups receive no application initialization scripts, IPC handler or application resource protocols. Native drag/drop reaches HTML and file inputs. WebKit zoom hotkeys and app zoom-menu actions target the focused preview through native WKWebView pageZoom or WebKitGTK zoom-level; its user factor composes with fitted profile zoom. Other focus keeps app zoom. Windows zoom, navigation gestures and the status bar use browser settings.
- The host navigation interceptor consults the shared `EmbeddedViews` application state first. Reserved `browser-` and `embedded-remote-` labels with missing records are denied. These labels stay outside primary `local-*` and `remote-*` capability patterns. A child decision returns immediately, before window-origin rules and external-link opening.
- The controller publishes its registration with renderer/generation fencing, navigates, then applies current visibility. Hiding revokes automation leases before native I/O, including when the native hide fails. Owner cleanup also invalidates children still being constructed; an old creation cannot publish after primary-renderer reload.
- WebKit history reads the native back/forward list on the UI thread. Each retained native item gets a monotonic numeric handle, with at most 32 exposed entries; redirects and `replaceState` update that item's URL, while distinct same-URL entries keep distinct handles. Reads and traversal revalidate the registration's owner/generation, reject expired or removed handles and release retained items on replacement, close and primary-renderer reload. GTK observes native URI/list changes. WKWebView samples native lists every 250 ms while visible and every second while hidden because its public list API has no same-URL `pushState` notification. Saved restoration keeps only URLs/cursor and loads the selected URL on explicit reopening.
- Keep application capabilities confined to primary local webviews. Never apply `linux_tls.rs` remote-window exceptions to browser previews.

The native host synchronously grants one preview owner per session: a local
window and exact tab occurrence. A manual open changes the surface only after
the reply. A duplicate presents the owner and explicit actions to focus it or
move the preview within that window. Transfer matches the observed owner revision,
retains the guest, and invalidates its prior automation witness. Closing the tab,
window or renderer releases ownership. Returning to chat keeps ownership.

An autonomous open targets the current owner or the most recently used eligible
tab for that session. When there is no recent eligible entry, discovery asks local
windows in native focus/MRU order using backend-verified workspace IDs. The
selected tab asks for ownership once it can display the preview; the host grants
it synchronously before the tab can create or show a guest. Only the exact
visible registration can acknowledge delivery. Its window, occurrence,
registration and deadline remain fenced through navigation and receipt.
Page actions require exactly one visible native target for the invoking session.
Hiding, minimizing, closing or moving the preview invalidates its old witness.

The native host issues the URL only after the exact visible registration is admitted.
It returns that navigation's committed URL, including redirects, after the main document's
load completes or a requested same-document navigation is confirmed in the main frame.
The owning renderer saves the URL and journal only from that request's successful native
result while its gesture is current. A valid commit outside the journal's URL bound stays
live and preserves the previous saved journal, as does retirement. Live address updates
follow the native location independently of the receipt. Expiry or
revocation stops the admitted navigation on its own guest while it is still current;
a successor navigation or replacement guest keeps its own lifetime.
Native-parent stdin preserves UTF-8 across buffer boundaries, and timed-out response
IDs stay retired independently of subsequent requests.

## Focused Validation

- Remote preview transport: see the [capability validation inventory](#preview-transport-validation).

- Server: `automation-plugin.test.ts`, `automation-plugin-restart-ack.test.ts`, `developer-cdp.test.ts`, `automation/desktop-plugin.test.ts`, `routes/automation-plugin.test.ts`, and the shared pruning-presence regressions.
- Native discovery: build with `npm run build:automation --workspace @neuralnomads/codenomad`, then run `node scripts/test-automation-native.mjs <absolute-cli-path>`. The fixture uses an isolated daemon/config/database and exercises ordinary-project discovery, all tools at startup, execution fences, independent leases, shutdown and reopening. CI runs it against the minimum and latest OpenCode runtimes.
- Electron: `browser-controller.test.ts`, `browser-webview-security.test.ts`, preload tests.
  `npm run test:preloads --workspace @neuralnomads/codenomad-electron-app`
  builds the production entries and loads them in hidden sandboxed native views.
  Preload builds use isolated entries with dependencies bundled inline; every
  entry must load autonomously under Electron's sandboxed module loader.
  The built regression checks document-start remote guards, ordinary prompt
  behavior and local/Preferences/remote application bridge fences.
  Linux runs under Xvfb with Chromium's process sandbox disabled for CI;
  each tested renderer retains asserted `sandbox: true`, context isolation and
  disabled page Node integration. Child exit status and bounded output accompany failures.
- Tauri: `embedded_view_tests.rs`, `browser_controller.rs` and `browser_controller_regressions.rs` tests, including ownership, fail-closed child policy, creation rollback, replacement fencing, actual capability resolution, primary-renderer cleanup, window counting, lock ordering and expired dispatch
- Native capabilities: `packages/tauri-app/tests/webkit-capabilities/README.md` describes the backend-free production-layer harness on Windows/macOS/Linux and the Electron harness. It covers OAuth, blank/named windows, opener cleanup, HTTP/data/blob downloads, dialog values/cancellation, permission consent/denial, no app globals, fullscreen/Escape, file inputs/drop and WebAuthn availability. Windows runs the release build with scoped accessibility input; Linux uses both display backends. The HTTPS-to-loopback mode records the requesting origin in Electron's consent UI.
- WebKitGTK history: `python3 packages/tauri-app/scripts/test-webkit-history-linux.py` in a graphical Linux session with GTK 3/WebKitGTK 4.1 development packages. Run with `GDK_BACKEND=wayland` and `GDK_BACKEND=x11`; the standalone native example includes the production adapters, bounded-window selection and handle allocator. It covers redirects, fragments, same-URL `pushState`, `replaceState`, native traversal, branching and the 32-entry bound.
- WebKit private parent channel: `packages/tauri-app/scripts/test-browser-parent-webkit.py` builds the production controller, framing, native adapters and vendored runtime with an isolated owning-window inventory and renderer-claim fixture. The Node fixture uses the production `NativeParent` over real child stdout/stdin pipes. It covers autonomous open from an absent preview, redirects, fragments, failed loads/TLS, deadlines, PNG, hidden/duplicate targets, a fixture-renderer dialog, close/reopen and stale responses. Native PNG-completion tests revoke visibility or close the guest immediately before callback acceptance. The harness owns its fixture child and local servers; the shared daemon keeps its independent lifecycle. Build the Node fixture and run the graphical harness as described in `packages/tauri-app/tests/browser-parent/README.md`.
- UI: `browser-frame-security.test.ts`, `lib/native/browser.test.ts` and `tests/browser/browser-frame-native.test.ts` (real Solid/Electron guests, insecure HTTP, registration disposal and Tauri IPC failure recovery). Linux Electron rendering requires a display; CI runs the browser suite under Xvfb.
- Session lifetime: `tests/browser/session-browser-history.test.ts` exercises the real instance shell/store, a real Electron guest and the Tauri IPC boundary across chat/session/project/Info transitions, the preview's X, retained Back history and project-wide URL migration.
- Shared site state: the same suite tests real Electron HttpOnly-cookie/localStorage sharing, independent documents/history, app-profile isolation and shared logout; Rust regressions verify Tauri's common persistent browser directory.

## Agent conventions

- Live open/restore/navigation resolves the owning backend from the instance key before HTTP. Follow the [remote preview transport contract](#remote-preview-content-transport) for capability cleanup and revocation. Remote project preview controls wait for both the host snapshot and attachment-scoped project metadata. Host version/update checks use local metadata.
- A floating session drawer covers the portaled session preview: `SessionPreviewHost` hides its retained DOM and deactivates its native target until that shell's drawer leaves the DOM. Body-portaled menus and dialogs retain their shared stacking layers; Tauri child views follow `localOverlayOpen()` visibility.

- After changing fixed page programs or their signatures, run `node --import tsx scripts/build-page-function-registry.ts` and the driver contract tests. Keep `functions.generated.json` derived from the authored registry. Bump the private driver contract version for incompatible operation/signature changes. Preserve the fixed-program hashes and snapshot goldens when behavior is unchanged. Never accept caller-supplied protocol names or JavaScript source in the page channel.

- Give `embedded_view.rs` child modules explicit `#[path = "embedded_view/..."]` attributes so the native qualification example can include the production layer directly. Keep fixture-only lifecycle controls inside the example executable.

- Native session previews behave as tabs in one browser: share the persistent preview profile's cookies/site storage across sessions and projects within a CodeNomad data profile/config pair, but never with the trusted app renderer, remote-window profiles or the other desktop engine. Each session owns one document, navigation stack, history cursor, device template, proxy token and native registration within a renderer. Native registrations retain the real session ID for ownership and automation authority. Electron uses `persist:codenomad-browser-shared-v1`; Windows/Linux Tauri uses `browser/shared-v1`; macOS Tauri uses its profile/config-derived identified WebKit store. Leave per-session preview profiles found on disk in place and never merge them into the shared profile: they can hold conflicting accounts. Iframe fallbacks keep their sandbox; never grant guests native capabilities.
- `viewState.previews` retains each occurrence's per-session foreground mode. `session-browser-persistence.ts` saves shared URL/history/template resources by session in `opencode-session-browser-state-v1`. `SessionPreviewHost` retains the guest and follows the active owner's slot geometry. Hidden guests relinquish automation authority (Electron unregisters, Tauri hides); closing the owner releases the guest. Inactive transcripts and composers unmount and keep an independent memory budget. Reopen saved pages explicitly to restore their URL, cursor and template; never persist native pageState/forms/POST bodies. Use owned CDP history IDs to traverse live history. The journal keeps up to 32 credential-free HTTP(S) URLs per session within the 4 KB aggregate window budget; trim history before evicting saved previews.
- Plain-browser and Remote Control clients retain bounded occurrence mode/Mission/panel envelopes in local storage, keyed by normalized folder and duplicate occurrence. Allocation and closure compaction share the local bound-occurrence inventory, so duplicates opened during a pending backend deletion retain contiguous ranks. Repeated opening notifications reuse the existing binding. The fallback admits 32 envelopes within 64K UTF-16 units. Imported occurrence browser entries merge into session resources before their envelopes reduce to foreground modes, preferring the active descriptor or most recently written local occurrence. Explicit browser opening adopts each missing session's matching legacy URL; exact session entries take precedence over project-wide fallbacks independently of source order. Only the consumed source retires after successful persistence; hydration stays data-only. Native primary windows use their existing captured workspace descriptors and partition publication.
