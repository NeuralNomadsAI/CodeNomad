# Browser previews and SideCars

## Open a session browser {#session-browser}

1. In a conversation's toolbar, choose **Open web preview**.
2. Enter a credential-free `http://` or `https://` **Preview URL**, then **Open preview**. Use the toolbar to navigate, refresh and go Back/Forward.
3. Use the preview's close button to return to chat. Reopen it in that conversation to continue.

Service workers stay disabled in remote previews.

Clicking a `localhost` or `127.0.0.1` link in a conversation opens it in that session's web preview, on every client where previews are available. Through Remote Control when the host keeps web previews off, or on a client where previews are otherwise unavailable, such links keep their normal browser behavior. Ctrl+click (⌘-click on macOS) or middle-click opens the link in your browser instead. Inside the sandboxed preview frame, where real storage is unavailable, the page gets an in-memory `localStorage`, `sessionStorage` and `document.cookie` jar for the current page load; a per-token preview host opened on its own keeps its real storage.

Each preview belongs to its project folder and session. Switching conversation, project, Info or chat hides an explicitly opened native guest without discarding its live document/history. Hidden guests are not automation targets. Closing the project/window or restarting the renderer ends the live document.

Saved history restores only when you explicitly reopen that session's browser, not at startup/session selection. It stores URLs and a cursor, not unsent forms, DOM, POST bodies or JavaScript memory. History is bounded to 32 URLs per session and a shared layout budget; older entries may be trimmed. Restoring a URL may perform a fresh page load; it is not transaction replay.

Remote project tabs load previews through that project's CodeNomad server. The address bar and saved history show the application URL. Closing the preview or project tab, disconnecting/removing the server, or quitting ends its live page and connections; reopening loads the saved address with its history. Server sign-in credentials stay on the backend; proxied application cookies are filtered. Keep internal preview loading addresses inside CodeNomad.

Native remote previews suppress context menus, link dragging, printing, pop-ups, downloads, page dialogs and permission prompts to keep internal loading addresses private. Save page work before closing.

## Shared sign-ins and automation boundaries {#signins-automation}

Native previews share cookies, sign-ins and site storage across projects/sessions within the same desktop engine and profile/configuration scope, separately from the trusted CodeNomad renderer. Logging out of a site in one preview affects other previews using that store. Documents, forms, session storage, navigation histories and automation attachments remain session-owned. Iframe previews are not a full shared native browser profile.

| Client | Preview implementation | Agent browser automation | Mobile templates |
| --- | --- | --- | --- |
| Electron on supported desktop platforms | Native Chromium guest; OAuth pop-ups, downloads and dialogs | Supported for the visible owned session preview | Android/Chromium identity, touch and density emulation |
| Windows Tauri | Native WebView2 child; OAuth pop-ups, downloads and dialogs | Supported for the visible owned session preview | Android/Chromium identity, touch and density emulation |
| macOS Tauri (14+) | Native WKWebView child; OAuth pop-ups, downloads and dialogs | Supported for the visible owned session preview | WebKit mobile identity and CSS viewport; native input limits |
| Linux Tauri | Native WebKitGTK child; OAuth pop-ups, downloads and dialogs | Supported for the visible owned session preview | WebKit mobile identity and CSS viewport; native density/input limits |
| Plain browser/remote view | Iframe fallback | No local native preview target | Dimensions only |

On every native desktop host, the session-bound `codenomad.browser` tool opens, navigates, snapshots and screenshots the preview, and performs click, type, select, hover, drag, scroll, key and text-wait actions. Execution checks the owning backend, native capabilities, session and visible target. Hidden, replaced or navigated targets fail safely; actions are never retried automatically. Page content stays untrusted. For sites blocking iframe embedding, use an external browser.

Native previews open manually or through the agent, retain shared sign-ins across restarts and use native Back/Forward history. Local menus and dialogs hide the preview. Element comments are unavailable in native mode. WebKit snapshots capture script-created closed shadow roots; declarative closed roots stay opaque. On macOS, the first hover can omit pointerenter and ⌘A selects through the native responder without an A keydown. GTK clipboard reads require explicit Ctrl+V; clipboard writes and native copy/paste work.

Native pop-ups share preview sign-ins, preserve `opener`/`postMessage` and close with their opener. Typed/restored addresses accept credential-free HTTP(S); sites can also open blank and same-origin blob documents. File and app schemes are blocked. Downloads save to Downloads with sanitized unique names, never overwrite files and never auto-open. Camera, microphone, location and notifications are denied; classified permissions use consent, unknown requests show an error. Tauri and Electron support `alert`/`confirm`/`prompt`; Electron's prompt dialog covers top-level preview pages, pop-ups and subframes. Device and screen selectors scroll through the available entries. Other APIs depend on the engine and hardware.

Sites can ask for confirmation when closing a native pop-up. Linux pointer-lock consent appears at the top of its owning window. WebKitGTK builds affected by [WebKit 323277](https://bugs.webkit.org/show_bug.cgi?id=323277), including 2.52.6, require the page's file input for uploads because dropped-file access is blocked for security. Save page work before closing or reloading the owning CodeNomad window.

On Tauri macOS/Linux, focus the preview to zoom it with ⌘/Ctrl +, − or 0, or the app's zoom menu. With focus elsewhere, these menu actions zoom the app.

## Choose one of six viewport templates {#templates}

1. Open the preview's viewport menu.
2. Select a template below. Use the portrait/landscape entries directly; there is no separate rotate control.
3. On Electron and Windows Tauri, expect a native reload when entering/changing mobile emulation or returning to a dimensions-only template.

| Template | CSS viewport |
| --- | --- |
| Responsive viewport | Available preview space |
| Desktop viewport | 1440 × 900 |
| Tablet viewport | 768 × 1024 |
| Tablet landscape | 1024 × 768 |
| Mobile viewport | 390 × 844 |
| Mobile landscape | 844 × 390 |

On Electron and Windows Tauri, mobile templates set Android/Chromium identity, orientation, touch and DPR 2.75 on the owned guest only. Returning to responsive/desktop/tablet clears those overrides and reloads. Tauri macOS/Linux apply a generic WebKit mobile identity to HTTP and JavaScript and fit CSS viewports independently of app zoom/DPI, reloading on template/profile changes and reset. macOS uses native DPR 2.75 when available; GTK density follows the fitted zoom and monitor. Screen, platform, pointer/hover media and maximum touch points keep native desktop values. GTK mobile clicks deliver native touch with mouse compatibility events; macOS keeps mouse input. The iframe fallback resizes only. These profiles provide layout references; phone keyboards, system bars and mobile OS text settings stay outside their scope. Save page work before changing templates because reload can discard unsent page state.

## Register a SideCar {#register-sidecar}

1. Start the web tool separately on the CodeNomad backend host, listening on `127.0.0.1:<port>`.
2. Open **Settings → SideCars**. Enter **Name** and **Port**; check the derived **Base path** (`/sidecars/<id>`).
3. Set **Protocol** to match the upstream service, and choose **Prefix mode**.
4. Choose **Add SideCar**, then **Open SideCar** from the home page to open its tab.

| Choice | Exact effect |
| --- | --- |
| HTTPS (form default) | CodeNomad connects to the upstream as `https://127.0.0.1:<port>`. |
| HTTP | CodeNomad connects to the upstream as `http://127.0.0.1:<port>`. This does not change the public CodeNomad connection's TLS setting. |
| Strip prefix (default) | `/sidecars/<id>/path` is forwarded upstream as `/path`. |
| Preserve prefix | `/sidecars/<id>/path` is forwarded upstream unchanged. Configure the service's own base path to match. |

Registration is server configuration, shared by its clients; it neither installs nor starts the service. The port is on the backend host, not your viewing laptop or phone. **Running** indicates reachability, not that the tool's application/authentication is healthy. Removing registration does not stop the separately launched process. Closing its tab does not stop it either.

If unreachable, check the process and port on the backend. If HTML loads but assets/WebSockets fail, check the tool's base path and prefix mode. Recreate a wrong registration with the intended settings; do not expose the upstream publicly just to work around a proxy error. SideCar applications can expose a terminal or files with the server account's authority; trust their users and configuration.

A SideCar is a trusted extension of CodeNomad, not a sandboxed preview: its page runs with CodeNomad's own origin, so its scripts can use CodeNomad with your signed-in access. Register only services whose code you trust. CodeNomad does not forward its own sign-in cookies to the service, while the service's own cookies are kept.

SideCar content (`/sidecars/`) and SideCar WebSockets require a loopback connection on the host. Registration through `/api/sidecars` is available to paired devices and authenticated direct LAN clients. Live preview content (`/previews/`) is available over direct LAN access with a valid capability token; [Remote Control](remote-control.md#remote-surface) web previews remain available with their capability token while enabled. See [Upgrading](remote-access.md#upgrading) for direct-access requirements.

## OpenVSCode Server recipe {#openvscode}

1. On the backend host, run Docker with the service bound to loopback:

```sh
docker run -it --init -p 127.0.0.1:8000:3000 -v "${HOME}:${HOME}:cached" -e HOME=${HOME} gitpod/openvscode-server --server-base-path /sidecars/vscode
```

2. Register **Name** `VSCode`, **Port** `8000`, **Protocol** `HTTP`, **Prefix mode** **Preserve prefix**.
3. Verify the displayed base path is `/sidecars/vscode`, then open the SideCar.

This shell recipe mounts your home directory into the container; use a narrower mount if that is all the editor should access. The service's `--server-base-path` must exactly match the registration. Stop the container separately when finished; deleting the SideCar does not remove it or its files.

## ttyd terminal recipe {#ttyd}

1. On the backend host, start a writable shell terminal bound to loopback:

```sh
ttyd --interface 127.0.0.1 --writable zsh
```

2. Register **Name** `Terminal`, **Port** `7681`, **Protocol** `HTTP`, **Prefix mode** **Strip prefix**.
3. Open the SideCar at its displayed `/sidecars/terminal` base path.

The terminal runs with the privileges of the account that started ttyd. Choose a different shell if `zsh` is unavailable. Use the actual port if you changed ttyd's default, and stop ttyd separately when finished. Authenticate and protect CodeNomad access; a writable terminal is not a sandbox.
