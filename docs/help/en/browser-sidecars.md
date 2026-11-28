# Browser previews and SideCars

Iframe previews and SideCars refuse connections to CodeNomad's own listening addresses and ports, including DNS aliases. Use your application's separate server port.

## Open a session browser {#session-browser}

1. In a conversation's toolbar, choose **Open web preview**.
2. Enter a credential-free `http://` or `https://` **Preview URL**, then **Open preview**. Use the toolbar to navigate, refresh and go Back/Forward.
3. Use the preview's close button to return to chat. Reopen it in the same tab and conversation to continue.

Service workers stay disabled in remote previews.

Clicking a `localhost` or `127.0.0.1` link in a conversation opens it in that session's web preview, on every client where previews are available. Through Remote Control when the host keeps web previews off, or on a client where previews are otherwise unavailable, such links keep their normal browser behavior. Ctrl+click (⌘-click on macOS) or middle-click opens the link in your browser instead.

The native preview keeps its live page when you return to chat or move it to another tab in the same window.

Each tab saves its chat/preview choice; the session saves its shared URL, viewport template and history. Saved pages load only when you explicitly reopen the session browser. Persistence keeps URLs and a cursor; live forms, DOM, POST bodies and JavaScript memory end with the document. History is bounded to 32 URLs per session and a shared window budget; older entries may be trimmed. Restoring a URL may load a fresh page.

Remote project previews use the project’s server and show the application URL. Closing the preview or its tab, disconnecting the server, or quitting ends the live page. Reopening loads the saved address and history, not unsaved page work. Keep internal loading addresses private.

Preview controls appear once the host and the remote project server confirm that previews are available.

Native remote previews suppress context menus, clipboard export, link dragging, printing, pop-ups, downloads, page dialogs and permission prompts to keep internal loading addresses private. Save page work before closing.

For Remote Control, **Web previews** is on by default under **Settings → Remote Access → Remote Control** on the host. Turning it off ends previews and their WebSockets; reloading hides **Open web preview**. Signing out or revoking a paired device ends that client's previews and their WebSockets.

## Shared sign-ins and automation boundaries {#signins-automation}

On Electron and Windows Tauri, the desktop automation restart (`codenomad.act`, `restart`) relaunches the inspected profile, configuration and build. It inspects the original window again if restored; otherwise it reports the missing window and leaves other windows uninspected. A successful inspection during reconnection takes precedence.

If the restart is cancelled, use `codenomad.inspect` with `targets: true` to list the open windows, then inspect the window you want by its `target`.

Native previews share cookies, sign-ins and site storage across projects/sessions within the same desktop engine and profile/configuration scope, separately from the trusted CodeNomad renderer. Logging out of a site in one preview affects other previews using that store. Documents, forms, session storage, navigation histories and automation attachments belong to each session.

Each session has one native preview. If a duplicate tab shows **Preview open in another tab**, choose **Go to tab** to find it, or **Open here** to move it within the same window. The previous tab then shows the same message. Closing the owning tab frees the preview for another tab.

While a desktop window shows a conversation, its agents can control the conversation's preview with OpenCode's browser tools (OpenCode 2.4 or later); running page scripts is refused, and in the Tauri app on macOS and Linux they cannot go back, forward or reload. In Electron and the Windows Tauri app they can also read the preview's console messages and network requests; they see request and response headers and text bodies while the preview still holds them, except cookie and authorization header values. An agent opens the preview in its owning tab or, if there is none, the last tab used for the session. Page actions target the visible native preview. Pages load over this computer's network, as in the preview you see, so `localhost` is this computer even when OpenCode runs in WSL.

The agent takes a snapshot before acting on or capturing the preview. If the preview changes, the command stops instead of using a different preview.

| Client | Preview implementation | Agent browser automation | Mobile templates |
| --- | --- | --- | --- |
| Electron on supported desktop platforms | Native Chromium guest; OAuth pop-ups, downloads and dialogs | Supported for the visible owned session preview | Android/Chromium identity, touch and density emulation |
| Windows Tauri | Native WebView2 child; OAuth pop-ups, downloads and dialogs | Supported for the visible owned session preview | Android/Chromium identity, touch and density emulation |
| macOS Tauri (14+) | Native WKWebView child; OAuth pop-ups, downloads and dialogs | Supported for the visible owned session preview | WebKit mobile identity and CSS viewport; native input limits |
| Linux Tauri | Native WebKitGTK child; OAuth pop-ups, downloads and dialogs | Supported for the visible owned session preview | WebKit mobile identity and CSS viewport; native density/input limits |
| Plain browser/remote view | Iframe fallback | No local native preview target | Dimensions only |

Element comments are unavailable in native mode. GTK clipboard reads require explicit Ctrl+V; clipboard writes and native copy/paste work. For sites blocking iframe embedding, use an external browser.

Native pop-ups share preview sign-ins, preserve `opener`/`postMessage` and close with their opener. Typed/restored addresses accept credential-free HTTP(S); sites can also open blank and same-origin blob documents. File and app schemes are blocked. Downloads save to Downloads with sanitized unique names, never overwrite files and never auto-open. Camera, microphone, location and notifications are denied; classified permissions use consent, unknown requests show an error. Tauri and Electron support `alert`/`confirm`/`prompt`; Electron's prompt dialog covers top-level preview pages, pop-ups and subframes.

Sites can ask for confirmation when closing a native pop-up. WebKitGTK builds affected by [WebKit 323277](https://bugs.webkit.org/show_bug.cgi?id=323277), including 2.52.6, require the page's file input for uploads because dropped-file access is blocked for security. Save page work before closing or reloading the owning CodeNomad window.

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

On Electron and Windows Tauri, mobile templates set Android/Chromium identity, orientation, touch and DPR 2.75 on the owned guest only. Returning to responsive/desktop/tablet clears those overrides and reloads. Tauri macOS/Linux apply a generic WebKit mobile identity to HTTP and JavaScript and fit CSS viewports independently of app zoom/DPI, reloading on template/profile changes and reset. macOS uses native DPR 2.75 when available; GTK density follows the fitted zoom and monitor. The iframe fallback resizes only. These profiles provide layout references; phone keyboards, system bars and mobile OS text settings stay outside their scope. Save page work before changing templates because reload can discard unsent page state.

## Register a SideCar {#register-sidecar}

1. Start the web tool separately on the CodeNomad backend host, listening on `127.0.0.1:<port>`.
2. Open **Settings → SideCars**. Enter **Name** and **Port**; check the derived **Base path** (`/sidecars/<id>`).
3. Set **Protocol** to match the upstream service, and choose **Prefix mode**.
4. Choose **Add SideCar**, then open it from **Browse**. [project tabs](projects.md#open-project).

A running SideCar stays in Recent tabs after its tab closes.

| Choice | Exact effect |
| --- | --- |
| HTTPS (form default) | CodeNomad connects to the upstream as `https://127.0.0.1:<port>`. |
| HTTP | CodeNomad connects to the upstream as `http://127.0.0.1:<port>`. This does not change the public CodeNomad connection's TLS setting. |
| Strip prefix (default) | `/sidecars/<id>/path` is forwarded upstream as `/path`. |
| Preserve prefix | `/sidecars/<id>/path` is forwarded upstream unchanged. Configure the service's own base path to match. |

Registration is server configuration, shared by its clients; it neither installs nor starts the service. The port is on the backend host, not your viewing laptop or phone. Removing registration does not stop the separately launched process. Closing its tab does not stop it either.

If unreachable, check the process and port on the backend. If HTML loads but assets/WebSockets fail, check the tool's base path and prefix mode. Recreate a wrong registration with the intended settings; do not expose the upstream publicly just to work around a proxy error. SideCar applications can expose a terminal or files with the server account's authority; trust their users and configuration.

A SideCar is a trusted extension of CodeNomad, not a sandboxed preview: its page runs with CodeNomad's own origin, so its scripts can use CodeNomad with your signed-in access. Register only services whose code you trust. CodeNomad does not forward its own sign-in cookies to the service, while the service's own cookies are kept.

SideCar content (`/sidecars/`) and SideCar WebSockets require a loopback connection on the host. To open them from other devices too, turn on **Open SideCars over HTTPS** in **Settings → SideCars** on the host: browsers signed in through this server's HTTPS addresses or an HTTPS origin in `CODENOMAD_ALLOWED_ORIGINS`, such as a TLS reverse proxy, can then open SideCars. Plain HTTP, `localhost` addresses and Remote Control stay host-only. Registration through `/api/sidecars` is available to paired devices and authenticated direct LAN clients. Live preview content (`/previews/`) is available over direct LAN access with a valid capability token; [Remote Control](remote-control.md#remote-surface) web previews remain available with their capability token while enabled. See [Allowed origins](remote-access.md#upgrading) for direct-access requirements.

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
