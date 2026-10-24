# Preview origins and permissions

Session web previews: token capabilities, origin policy, server-enforced document sandbox and the iframe frame contract.

## Agent conventions

- The server owns the preview policy. The Settings UI projects `server.preview`; it is never a separate security layer. Read the policy per request so a saved change applies without restarting the server.
- Path-proxied responses always carry the policy's CSP sandbox. Do not gate it on `Content-Type`: an SVG, XML or untyped body can be rendered as a document, and 304 responses still need the current tier.
- `allow-same-origin` is produced only by the server and UI policy resolvers. A preview target host, a screenshot fixture or a caller must not add it directly.
- Keep the server (`previews/policy.ts`) and UI (`stores/preferences.tsx`, `components/browser-frame-security.ts`) normalizers and loopback predicates behaviorally identical; both sets of tests pin the same defaults and rejections.
- Sandbox and browser-feature controls are iframe settings. Electron and Windows Tauri native webviews keep host behavior; Tauri on macOS and Linux uses an iframe (the capability host when the local window is served from loopback) and therefore follows the iframe policy.
- Browser feature toggles only delegate the ability to ask. Browser prompts and browser site settings remain the final authority; never describe a toggle as granting a permission.

## Token capability

`PreviewManager` (`packages/server/src/previews/manager.ts`) creates a random UUID token for each preview and keeps the target URL in memory; tokens are not persisted. The target must be an `http:` or `https:` URL without credentials. The server exposes two capability shapes:

- Path previews: `/previews/<token>/...` at the app origin, or at the configured custom origin. The proxy rewrites root-relative and target-origin URLs in HTML, CSS, JavaScript imports, import maps and redirects into that namespace, and the runtime bridge does the same for fetches, `XMLHttpRequest`, WebSocket, `EventSource`, history entries, links and forms, so target-origin behavior survives the proxy.
- Desktop capability host: `<token>.preview.localhost[:port]` for a local Tauri window whose parent URL is loopback, with the target path and query. The Tauri iframe renders this per-token isolated origin, which does not depend on the path origin mode. Electron and Windows Tauri use native guests instead.

The proxy strips the app's request cookies before forwarding and strips target `Set-Cookie`/`Set-Cookie2` response headers. The preview document therefore never carries the CodeNomad session cookie to the target. The referer fallback resolves a root-relative request whose referer names a preview token and applies the same resolved policy; the custom-origin contract does not include root-relative requests.

## Origin modes

`server.preview.originMode` is one value for the whole CodeNomad server:

| Mode | Loopback target | External target | Same-origin trust |
| --- | --- | --- | --- |
| `opaque` (default) | Opaque path preview | Opaque path preview | Never |
| `app` | Path preview at the app origin | Opaque path preview | Loopback only |
| `custom` | Path preview at the configured custom origin | Opaque path preview | Loopback only, and only when the request arrived at the custom origin |

`localUrl`, `remoteUrl` and the LAN addresses in `serverMeta` are the app origins. `resolvePreviewSettings` validates a stored custom origin against all of them: a matching hostname, or a loopback alias on the app's port, degrades the whole policy to the opaque default. A custom origin must be an absolute `http:`/`https:` origin with no credentials, path, search or hash. Unknown modes, invalid origins, a `custom` mode with no origin, and non-boolean sandbox/feature fields all fall back to the defaults below. The defaults are `opaque`, no custom origin, sandbox forms/modals/popups/downloads enabled, and every browser feature disabled. `allow-scripts` is always present and is not configurable.

The UI normalizer (`normalizePreviewSettings`) mirrors these defaults and validates the custom-origin shape. `PreviewSettingsSection.saveCustomOrigin` separately rejects the current `window.location.origin`; the UI does not make a stored `custom` value with no valid origin opaque, while the server's `resolvePreviewSettings` does, and Settings shows an inline error. The server remains authoritative for hand-edited YAML and for any origin the UI does not know about.

Storage is the existing `server` config owner and `/api/storage/config/server` API. No preview-specific endpoint or listener exists.

## Server enforcement

### Document sandbox

`previewDocumentSandboxForTarget` derives the CSP sandbox from the target, the resolved policy and the incoming `Host`:

- `allow-scripts` is always included.
- `allow-forms`, `allow-modals`, `allow-popups` and `allow-downloads` follow `server.preview.sandbox`.
- `allow-same-origin` is added only for `app` mode with a loopback target, or `custom` mode with a loopback target whose request `Host` matches the configured custom origin.

Only a literal loopback target qualifies: `localhost`, `0.0.0.0`, `::1`, `[::1]` and numeric `127.x` IPv4 addresses. `127.evil.com` and `127.0.0.1.example.com` are external.

### Origin-aware custom mode

A custom-origin preview knows its token and can navigate to or embed the same `/previews/<token>/...` path at the app origin. The server therefore inspects the request host on every path-proxied response. At the app origin the same token receives an opaque CSP, so a custom preview cannot create a same-origin child and escape into CodeNomad. The custom origin must use a distinct hostname and the reverse proxy must preserve `Host`; a proxy that rewrites the host degrades custom mode to opaque, never to app trust.

### Response headers

Every path-proxied response gets `Content-Security-Policy: sandbox <flags>` built from the resolved policy. Target `Content-Security-Policy`, `Content-Security-Policy-Report-Only`, `Permissions-Policy`, `Permissions-Policy-Report-Only` and `Feature-Policy` are removed, as are `X-Frame-Options` and target cookies. The injected CSP is the authoritative document sandbox and the Settings feature toggles are the authoritative delegation; a custom-origin reverse proxy must not strip or replace them.

The same responses force `Cache-Control: no-store` with `Pragma: no-cache` and drop `Expires`, `ETag` and `Last-Modified`, so a browser cache cannot replay an `allow-same-origin` document after the policy changes. The capability-host route keeps the target's cache headers because its response carries no injected tier.

The capability-host route injects no CSP because the frame already has its own origin. Both routes keep request cookies and target `Set-Cookie` stripped.

## UI frame policy

`SessionPreviewView` reads `serverSettings().preview` and passes the policy to `getPreviewFrameSource`, `previewSandboxFlags`, `previewAllowAttribute` and `getPreviewMessageOrigin`.

### Frame source

Desktop local capability hosts are resolved first: a local Electron or Tauri window whose parent URL is loopback computes `<token>.preview.localhost`, which the Tauri iframe renders. Otherwise `custom` uses `${customOrigin}${proxyUrl}`; `opaque` and `app` use the app-origin `proxyUrl`. The custom origin is only a browser-visible base URL; desktop capability hosts are unchanged.

### Sandbox and browser features

`previewSandboxFlags` emits `allow-scripts` plus the configured forms/modals/popups/downloads. `getBrowserFramePolicy` appends `allow-same-origin` only when the frame is trusted. A path preview is trusted only for a loopback target in `app` mode, or in `custom` mode with a configured origin; a capability-host preview is trusted by its own origin. Opaque and external targets are never trusted.

`previewAllowAttribute` covers camera, microphone, clipboard read/write, geolocation and fullscreen. Enabled features are delegated; disabled features are serialized as `'none'` so a same-origin frame cannot inherit the `self` default. Notification permission is not a Permissions Policy-controlled feature and cross-origin frames cannot request it, so it is not offered. The iframe `sandbox` and `allow` attributes are the only consumers: Electron and Windows Tauri native webviews are not sandboxed, while Tauri on macOS and Linux uses an iframe and follows both.

### Comment and location bridge

The runtime bridge posts location and comment messages to the parent. `BrowserFrame` accepts them only when `event.source` is the frame window and `event.origin` equals the expected origin:

- desktop capability-host iframe: the capability host's origin;
- opaque or external target: `"null"`;
- `app`: the parent origin;
- `custom`: the normalized custom origin.

A mismatch is ignored. This keeps same-origin, custom-origin and capability-host comment mode and address/history synchronization working without accepting messages from another frame.

### Policy changes

`SessionPreviewView` derives a policy key from the origin mode, custom origin, sandbox flags, `allow` attribute and trust tier, and remounts `BrowserFrame` when it changes. Lowering the trust tier therefore cannot leave a live same-origin document behind. Ordinary in-page navigation does not change the key. A capability-host preview keeps its source and isolated trust when the key changes; only its sandbox and delegated features follow the policy.

## Desktop capability hosts and native webviews

Electron and Windows Tauri local previews use native guests. They keep host permission, download and popup handling and are outside the iframe sandbox/feature policy. Tauri on macOS and Linux uses an iframe: when the local window is served from loopback it renders the capability host, otherwise it uses the selected path origin, and it always follows the sandbox and feature toggles. The path origin mode is irrelevant to the capability host.

## Custom-origin deployment contract

The operator supplies DNS, TLS and a reverse proxy; CodeNomad does not start a preview listener and cannot test reachability.

- Use a hostname distinct from every CodeNomad origin, not another port: cookies ignore ports.
- Route `/previews/*` and WebSocket upgrades for it to the same CodeNomad server.
- Preserve `Host`; custom mode compares it with the configured origin before granting `allow-same-origin`.
- Preserve response headers, specifically the injected `Content-Security-Policy`; do not overwrite it with the target's policy.
- Serve the origin over TLS when previews need secure-context APIs such as camera, clipboard or service workers.
- Root-relative Workers and service workers that bypass the rewritten `/previews/<token>/...` namespace are unsupported. The contract covers the rewritten namespace only.
- App CORS and CSRF protections must not allow the preview origin. The server rejects the resolved custom origin in its CORS callback and returns 403 for `/api/`, `/workspaces/` and `/sidecars/` requests whose `Origin` or `Referer` names it; `/previews/` remains reachable. A custom origin on another host avoids app cookies; another port does not isolate cookies.
- A sibling-subdomain custom origin is still same-site, so the browser attaches the `SameSite=Lax` CodeNomad session cookie to requests and forms sent to the app origin. Use a different site when strict cookie isolation is required.
- If the origin is unreachable or its route is broken, previews fail; the server has no fallback listener.

Previews on one custom origin share that origin with each other, so a malicious preview can affect another preview's storage or service worker; per-token custom origins are not provided.
