# Browser previews and SideCars

## Open a session browser {#session-browser}

1. In a conversation's toolbar, choose **Open web preview**.
2. Enter a credential-free `http://` or `https://` **Preview URL**, then **Open preview**. Use the toolbar to navigate, refresh and go Back/Forward.
3. Use the preview's close button to return to chat. Reopen it in that conversation to continue.

Clicking a `localhost` or `127.0.0.1` link in a conversation opens it in that session's preview automatically, on every client: the server proxies loopback previews, so they also work from a plain browser on another machine. Proxied loopback previews run same-origin with the app; external links keep opening in a new browser tab.

Each preview belongs to its project folder and session. Switching conversation, project, Info or chat hides an explicitly opened native guest without discarding its live document/history. Hidden guests are not automation targets. Closing the project/window or restarting the renderer ends the live document.

Saved history restores only when you explicitly reopen that session's browser, not at startup/session selection. It stores URLs and a cursor, not unsent forms, DOM, POST bodies or JavaScript memory. History is bounded to 32 URLs per session and a shared layout budget; older entries may be trimmed. Restoring a URL may perform a fresh page load; it is not transaction replay.

## Shared sign-ins and automation boundaries {#signins-automation}

Native previews share cookies, sign-ins and site storage across projects/sessions within the same desktop engine and profile/configuration scope, separately from the trusted CodeNomad renderer. Logging out of a site in one preview affects other previews using that store. Documents, forms, session storage, navigation histories and automation attachments remain session-owned. Iframe previews are not a full shared native browser profile.

| Client | Preview implementation | Agent browser automation | Mobile templates |
| --- | --- | --- | --- |
| Electron on supported desktop platforms | Native Chromium guest | Supported for the visible owned session preview | Android/Chromium identity, touch and density emulation |
| Windows Tauri | Native WebView2 child | Supported for the visible owned session preview | Android/Chromium identity, touch and density emulation |
| macOS/Linux Tauri | Sandboxed iframe | No native browser automation | Dimensions only |
| Plain browser/remote view | Iframe fallback | No local native preview target | Dimensions only |

Native automation is prepared at desktop startup and uses the session-bound `codenomad.browser` tool for open, navigate, snapshot, screenshot and page actions: click, type, select, hover, drag, scroll, key presses and waiting for text. Tool availability is not authorization for every window: execution checks the owning backend, native capabilities, session and visible target. An action whose page was hidden, replaced or navigated meanwhile is refused rather than sent to another page, and an action is never repeated automatically. Page contents remain untrusted. An iframe may fail because the target forbids embedding; use an external browser rather than weakening its protections.

## Choose one of six viewport templates {#templates}

1. Open the preview's viewport menu.
2. Select a template below. Use the portrait/landscape entries directly; there is no separate rotate control.
3. Expect a native reload when entering/changing mobile emulation or returning to a dimensions-only template.

| Template | CSS viewport |
| --- | --- |
| Responsive viewport | Available preview space |
| Desktop viewport | 1440 × 900 |
| Tablet viewport | 768 × 1024 |
| Tablet landscape | 1024 × 768 |
| Mobile viewport | 390 × 844 |
| Mobile landscape | 844 × 390 |

Native mobile templates set Android/Chromium identity, orientation, touch and DPR 2.75 on the owned guest only. Returning to responsive/desktop/tablet clears those overrides and reloads. Iframe fallback only resizes. These are reproducible layout references, not Safari/Firefox emulation or simulations of phone keyboards, browser/system bars or mobile OS text settings. Save page work before changing templates because reload can discard unsent page state.

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

A SideCar is a trusted extension of CodeNomad, not a sandboxed preview: its page runs with CodeNomad's own origin, so its scripts can use CodeNomad with your signed-in access. Register only services whose code you trust. CodeNomad does not forward its own sign-in cookies to the service, while the service's own cookies are kept. Remote Control does not expose SideCar application proxy traffic; use the appropriate direct-access path described in [Remote access](remote-access.md) and [Remote Control](remote-control.md).

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
