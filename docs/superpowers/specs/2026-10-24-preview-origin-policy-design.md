# Preview Origin Policy and Permissions — Design

Date: 2026-10-24 · Branch: `feature/loopback-preview-links` · Status: approved

## Intent

Preview currently hard-codes how a proxied web page relates to the CodeNomad
origin: loopback targets share the app origin, external targets are opaque.
That is a security decision the user must be able to make explicitly. The
default must be the safe choice, while deployments that understand the
trade-off can opt into app same-origin, or route previews through a separate
origin supplied by their reverse proxy.

The same Settings surface also owns the preview's sandbox capabilities and
the browser features it may request. Browser permission prompts and browser
site settings remain the final authority; CodeNomad only controls whether a
preview may ask and what its document sandbox permits.

## Goals

- Default to `opaque` **path** previews. No path preview gets
  `allow-same-origin`, app storage, app APIs, or app-scoped service workers
  unless the user explicitly selects a stronger mode. Desktop per-token
  capability-host previews remain isolated by their own origin and are not
  made opaque; see the desktop decision below.
- Offer three server-wide origin modes:
  - `opaque`: no preview shares an origin with anything; storage, service
    workers and other origin-scoped APIs are unavailable.
  - `app`: loopback targets share the CodeNomad origin; external targets
    remain opaque. This is the existing PR behavior, now opt-in and guarded by
    an explicit warning.
  - `custom`: loopback targets run at a configured independent preview origin;
    external targets remain opaque. The operator must route that origin's
    `/previews/*` path (including WebSocket upgrades) to the same CodeNomad
    server while preserving `Host`. The custom origin must not be any origin
    CodeNomad itself is served from.
- Enforce the origin mode on the server (CSP), not only in the iframe.
- Let the user choose sandbox capabilities for preview documents:
  forms, modals, popups and downloads. Scripts remain required.
- Let the user delegate browser features to previews: camera, microphone,
  clipboard read/write, geolocation, notifications and fullscreen. The browser
  still prompts and may block; CodeNomad never claims to grant them itself.
- Keep service worker consequences tied to the origin decision: unavailable
  in `opaque`, scoped to the preview origin in `custom`, and an explicit
  full-trust warning in `app`.
- Fix the security gaps found in the current implementation: the over-broad
  `127.*` host predicate, sandbox CSP only on HTML, and the comment/location
  bridge rejecting same-origin messages.

## Non-goals / anti-goals

- No pop-out preview window in this change. It is a separate follow-up.
- No per-project preview origin or per-preview permission policy. Settings are
  server-wide; browser permission grants remain per-origin and per-browser.
- No server-managed preview listener. A custom origin is an operator-provided
  reverse-proxy origin that only needs to route `/previews/*`. The app-origin
  referer fallback is not reproduced at the custom origin; root-relative
  resources that bypass the runtime bridge (notably some Workers and service
  workers) are unsupported there and are documented as a limitation.
- No attempt to replace browser site permissions, prompts or browser-level
  content settings with CodeNomad toggles.
- No change to the desktop capability-host model
  (`<token>.preview.localhost`) or to `codenomad.browser` automation.

## Current behavior

- Web/browser previews load `/previews/<token>/...` at the CodeNomad origin.
  Desktop local previews load `<token>.preview.localhost:<port>` and are
  already isolated by host.
- The iframe sandbox is `allow-scripts allow-forms allow-modals allow-popups
  allow-downloads`, plus `allow-same-origin` for loopback targets.
- The path proxy injects a CSP sandbox only on HTML responses; loopback keeps
  `allow-same-origin`, external targets are opaque. The target's own CSP is
  stripped.
- Preview request cookies are stripped; target `Set-Cookie` is stripped.
- The runtime bridge posts location and comment messages to the parent.
  `BrowserFrame` currently accepts only `event.origin === "null"`, so
  same-origin loopback previews lose location/history synchronization and
  comment mode.
- The host predicate is `/^127(?:\.|$)/`, which also matches external names
  such as `127.evil.com`.

## Approaches considered

### 1. Server-owned policy plus an operator-routed custom origin (chosen)

Store the policy in the existing server config owner. The server evaluates the
origin mode when serving preview responses and injects the matching CSP; the
UI reads the same normalized config to choose the iframe source, sandbox and
`allow` attribute. A custom preview origin is only a browser-visible base URL:
the deployment's reverse proxy forwards it to the same CodeNomad preview
routes, including WebSocket upgrades and response headers.

This keeps the security boundary on the server, needs no new listener, and
makes custom origins a deployment concern the user has explicitly accepted.
The operator provides DNS, TLS, WebSocket forwarding and header transparency.

### 2. Server-managed preview listener

The server would listen on a second host/port, serve preview routes there and
advertise the resulting origin. This removes the reverse-proxy requirement but
adds listener lifecycle, TLS, remote-access/tunnel exposure, port conflicts and
desktop/web branching. Rejected for this change.

### 3. Server enforces only opaque/app; custom origin and permissions are UI-only

The smallest server patch, but the custom origin and delegated features could
be ignored by a different client, and the server would not know which policy
to enforce. Rejected: origin mode is a security boundary, not a display
preference.

## Decisions

### 1. Server-owned preview policy

Add a `preview` block to the `server` config owner:

```yaml
server:
  preview:
    originMode: opaque        # opaque | app | custom
    customOrigin: ""          # absolute origin, no path/query/hash
    sandbox:
      forms: true
      modals: true
      popups: true
      downloads: true
    features:
      camera: false
      microphone: false
      clipboardRead: false
      clipboardWrite: false
      geolocation: false
      notifications: false
      fullscreen: false
```

Defaults are exactly the block above: `opaque`, no custom origin, the current
sandbox capabilities and no delegated browser features. `allow-scripts` is not
configurable; previews without scripts are not useful and allowing users to
disable it creates a second policy surface with little value.

The policy is server-wide. It is read through the existing
`/api/storage/config/server` API and stored in the normal YAML config. No new
endpoint is introduced. The server reads the policy when serving a preview so
a setting change does not require a server restart.

Normalization is shared in behavior, not necessarily in code, between the
server and UI:

- Unknown `originMode` values become `opaque`.
- `customOrigin` must be an absolute `http:` or `https:` origin with no
  username/password, path, search or hash. Invalid values become `""`.
- Missing or non-boolean sandbox/feature fields fall back to defaults.
- `originMode: custom` with an empty/invalid `customOrigin` is treated as
  `opaque` by the server and shown as an error in Settings.
- The custom origin must be a distinct hostname from every origin CodeNomad is
  served from. The UI rejects the current `window.location.origin`; the server
  also checks the configured origin against `serverMeta`'s local, remote and
  LAN origins and treats a match as invalid.
- The server is authoritative; a hand-edited YAML value that the UI would
  reject still falls back to a safe interpretation.

Suggested locations: `packages/server/src/previews/policy.ts` for the server
normalizer and CSP/sandbox helpers, and `api-types.ts` for the shared shape.
The UI keeps its own normalizer beside `normalizeServerConfig` in
`packages/ui/src/stores/preferences.tsx`; its tests pin the same defaults.

### 2. Server enforcement

`registerPreviewProxyRoutes` receives a policy reader backed by
`SettingsService`. The path proxy and the referer fallback use the same policy;
the capability-host route is unchanged.

The path route must be **origin-aware** in `custom` mode, because the same
`/previews/<token>/...` route is also reachable at the app origin. A
custom-origin preview knows its own token and can create a child iframe or
navigate to the app origin with that token; if the app-origin response also
carried `allow-same-origin`, the child would inherit the frame's sandbox and
escape into the app origin.

The server therefore decides the tier from both the target and the
browser-visible request origin:

- `opaque`: CSP sandbox never includes `allow-same-origin`, regardless of the
  target or request origin.
- `app`: loopback targets include `allow-same-origin`; external targets never
  do. This route is the app origin by definition.
- `custom`: only loopback targets **whose request arrived at the configured
  custom origin** include `allow-same-origin`. Every other request, including
  the same preview token served at the app origin, gets an opaque CSP. The
  request origin is derived from the incoming `Host` (host:port); the custom
  origin must use a distinct hostname from every app origin, so Host
  comparison is sufficient. A reverse proxy must preserve `Host`; if it does
  not, custom mode degrades to opaque, never to app trust. The app's
  local/remote/LAN origins are compared during config validation and a
  matching custom origin is rejected.
- The sandbox flags follow the configured `forms`, `modals`, `popups` and
  `downloads` settings. `allow-scripts` is always present.

The referer fallback remains an app-origin behavior. In `custom` mode it is
opaque (it is not at the custom origin). The custom origin contract only
requires `/previews/*` plus WebSocket upgrades; root-relative requests that
bypass the runtime bridge are unsupported there and are documented as such.

Inject the CSP on **every** path-proxied response, not only HTML. CSP sandbox
is only enforced for documents, while browsers can render `image/svg+xml`,
XML or a missing-`Content-Type` body as a document. Injecting on all responses
also covers 304 responses and unknown MIME types without a fragile MIME
allowlist. The target's CSP and `Permissions-Policy` (and legacy
`Feature-Policy`) are stripped; the injected CSP is the authoritative document
sandbox, and the Settings feature toggles are the authoritative delegation.
Browser site settings and prompts still apply.

The capability-host route keeps injecting nothing, because it is already a
separate origin. The loopback predicate in both server and UI becomes a strict
IPv4 loopback check: `net.isIP(value) === 4 && value.startsWith("127.")` on the
server, and a full numeric IPv4 regex on the client. `localhost`, `0.0.0.0`,
`::1` and `[::1]` keep their current treatment. Negative tests must include
`127.evil.com` and `127.0.0.1.example.com`.

### 3. UI frame policy

`SessionPreviewView` reads `serverSettings().preview` and passes a single
policy object to `BrowserFrame` and `getPreviewFrameSource`.

- **Frame source**
  - Desktop local capability-host behavior stays first.
  - `opaque` and `app`: use `preview.proxyUrl` (path at the app origin).
  - `custom`: use `${customOrigin}${preview.proxyUrl}`. The custom origin is
    normalized without a trailing slash and contains no path.
  - `customOrigin` is only used by browser/remote windows. Desktop local
    previews keep the capability host so native automation and the existing
    per-token origin stay unchanged.
- **Same-origin trust**
  - Desktop capability-host previews keep their current isolated per-token
    origin and same-origin behavior for loopback targets, independent of the
    web origin mode. They are not app-origin previews and must not become
    opaque just because the web default is opaque.
  - `opaque` path previews: never trusted.
  - `app` / `custom` path previews: only loopback targets are trusted;
    external targets are always opaque.
- **Sandbox**  
  Build the iframe `sandbox` string and the server CSP from the same policy:
  scripts, configured forms/modals/popups/downloads, and `allow-same-origin`
  only when trusted. Sandbox/feature toggles apply to iframe previews only;
  Electron and Windows Tauri native webviews keep their host permission,
  download and popup behavior, and the Settings copy says so. Tauri on
  Linux uses the capability-host iframe and therefore follows the iframe
  sandbox/feature settings while retaining its isolated origin.
- **Browser features**  
  Build the iframe `allow` attribute from the configured feature list. Enabled
  features are delegated to the iframe; disabled features are explicitly set
  to `'none'` so a same-origin iframe cannot inherit the `self` default. The
  UI caption must say the browser still asks and may block.
- **Comment/location bridge**  
  Replace the hard-coded `event.origin !== "null"` check with an expected
  origin supplied by the frame source and policy:
  - capability-host iframe: the capability origin;
  - opaque or external target: `"null"`;
  - app: `window.location.origin`;
  - custom: the normalized custom origin.
  Keep the existing `event.source === frameWindow` check. This fixes
  same-origin loopback comment mode, capability-host comment mode and
  history/address synchronization.
- **Policy changes**  
  When the preview policy changes, existing path preview documents must not
  keep a stale sandbox. `SessionPreviewView` forces a reload (or closes the
  preview) when the origin mode, custom origin or sandbox flags change. A
  downgrade from `app` to `opaque` must take effect immediately, not on the
  next manual navigation. Capability-host previews are not affected by the
  origin-mode part of this reload.

### 4. Settings UI

Add a dedicated **Preview** section to Settings. It is server-wide; a note in
the section says browser permission grants still belong to the browser and the
preview origin.

Suggested component:
`packages/ui/src/components/settings/preview-settings-section.tsx`.

Cards:

1. **Origin**
   - Select: Opaque (recommended), CodeNomad same-origin, Dedicated preview
     origin.
   - Custom origin input, enabled for the dedicated mode, with Save and
     validation.
   - App same-origin requires a confirmation dialog with the full trust
     warning: preview code can read/write CodeNomad storage, call APIs with the
     session, and register service workers; it is not recommended on shared or
     remote servers.
   - Opaque explains that storage, service workers and some browser features
     will not work.
   - Dedicated origin explains the reverse-proxy contract: use a distinct
     hostname from every CodeNomad origin, route `/previews/*` (including
     WebSocket) to this server, preserve `Host` and response headers/CSP, and
     use TLS for secure-context APIs. Root-relative Workers/service workers
     that bypass the rewritten preview namespace are a documented limitation.
   - A note explains that the origin mode applies to browser/remote path
     previews; desktop local previews use an isolated per-token capability
     origin, and native desktop webviews keep their host permission behavior.

2. **Sandbox**
   - Scripts shown as always required.
   - Toggles for forms, modals, popups and downloads.
   - Captions name the consequence; these are app-enforced in both the iframe
     and the server CSP for iframe previews. Native Electron/Windows Tauri
     webviews are outside these iframe toggles and keep host behavior; Tauri
     on Linux uses the capability-host iframe and follows the iframe toggles.

3. **Browser features**
   - Toggles for camera, microphone, clipboard read, clipboard write,
     geolocation, notifications and fullscreen.
   - Each row says the browser still prompts and may be blocked by site
     settings. CodeNomad only delegates the ability to ask.

4. **Service workers**
   - Read-only explanation driven by the origin mode:
     - opaque: unavailable;
     - custom: scoped to the preview origin, not CodeNomad, but a root-level
       service worker is unsupported unless it is reachable under the rewritten
       `/previews/<token>/...` namespace;
     - app: can control CodeNomad pages and persist after the preview closes;
       covered by the origin confirmation.
   - No separate service-worker toggle in this change.

Save behavior: toggles save immediately like existing settings; origin-mode
changes and the custom-origin field use explicit confirmation/Save because
they are security-sensitive. Invalid custom origins block the save and show an
inline error. The section must not leave a dirty draft behind when the
settings section changes (follow the existing dirty-guard conventions where a
draft is used).

Settings section registration:

- `packages/ui/src/stores/settings-screen.ts`: add `"preview"` to
  `SettingsSectionId`.
- `packages/ui/src/components/settings-screen.tsx`: nav item, icon and render.
- `packages/ui/src/lib/native/preferences-window.ts`,
  `packages/electron-app/electron/main/preferences-window.ts` and
  `packages/tauri-app/src-tauri/src/preferences_window.rs`: add the section to
  their allowlists.
- `packages/ui/src/lib/native-mission-preferences.test.ts` checks the section
  lists stay in sync.
- Add the nav label and all preview settings strings to every locale's
  `settings` message part. No new hard-coded user-visible strings.

### 5. Help and developer documentation

- Update `docs/help/en/browser-sidecars.md` and its nine translations with:
  the default opaque mode, the three origin modes, the custom-origin
  reverse-proxy/TLS/WebSocket/Host contract and its root-relative worker/SW
  limitation, the app same-origin trust warning, the iframe-only/native scope
  of sandbox and browser-feature toggles, and browser permission behavior.
- Add a `dev-docs/PREVIEWS.md` contract covering the token capability, the
  origin modes, the server CSP, the UI sandbox/allow mapping, the custom-origin
  deployment contract and the comment bridge origin. Add it to
  `dev-docs/INDEX.md` and the Preview area convention in `AGENTS.md`.
- Extend `dev-docs/SETTINGS.md` with the Settings → Preview section's
  server-wide/config/allowlist conventions.
- Keep help translations in the same PR per repository policy.

### 6. Tests

Server:

- `manager.test.ts`: strict loopback predicate, including
  `127.evil.com` and `127.0.0.1.example.com`.
- Preview policy normalization/defaults and custom-origin validation.
- `sidecar-proxy.test.ts` / preview proxy tests:
  - opaque default: loopback path HTML has no `allow-same-origin`;
  - app mode: loopback HTML gets `allow-same-origin`, external does not;
  - custom mode: loopback HTML gets `allow-same-origin` only when the request
    `Host` is the configured custom origin; the same token at the app origin
    gets an opaque CSP, so a custom preview cannot escape into the app origin;
  - SVG, XML and missing-`Content-Type` responses carry the tier CSP;
  - configured sandbox flags appear in the CSP exactly;
  - target `Permissions-Policy` / `Feature-Policy` is stripped;
  - capability host still injects no CSP;
  - request cookies and target `Set-Cookie` stay stripped;
  - app-origin referer fallback uses the current policy; custom origin does
    not claim the root fallback.
- Settings normalization tests for invalid custom origins and unknown modes.

UI:

- `browser-frame-security.test.ts`: frame source for opaque/app/custom,
  sandbox string, explicit `allow` policy, expected comment origin, loopback
  predicate.
- `preferences` normalization tests for defaults/validation.
- Browser fixture tests:
  - default settings render opaque frames;
  - app mode renders a loopback frame with `allow-same-origin`;
  - custom mode renders the custom-origin proxy URL;
  - sandbox/allow toggles change the iframe attributes;
  - same-origin and custom-origin comment/location messages are accepted;
  - a policy change reloads/closes a stale preview.
- Settings section browser coverage if the existing settings tests support it.
- Native Preferences section list sync test.
- Typecheck for `@codenomad/server` and `@codenomad/ui`; `npm run test:help`.

Update the existing `session-preview-sandbox` fixture, which currently assumes
the PR's unconditional same-origin loopback behavior. It must seed the server
preview policy and cover all three modes.

### 7. Migration and compatibility

- Existing configs have no `preview` block; defaults apply, so existing path
  previews become opaque. This is a deliberate, user-visible security default
  change and is documented in the help page. Desktop capability-host previews
  keep their isolated per-token origin.
- Existing stored preview records (target URL, history) need no migration. A
  newly opened preview uses the current policy. Tokens are not persisted.
- Desktop capability-host previews are unaffected by the web origin mode;
  native desktop webviews are unaffected by the iframe sandbox/feature toggles.
- Manual YAML edits are normalized to a safe interpretation; invalid custom
  origins, or custom origins matching an app origin, fall back to opaque.
- The custom origin must be served by a reverse proxy over `/previews/*`,
  preserve `Host` and response headers, and forward WebSocket upgrades. If it
  is unreachable, the preview fails and Settings shows the deployment contract.
  The server cannot test reachability. Root-relative resources that bypass the
  rewritten preview namespace are a documented custom-origin limitation.

## Security considerations

- The default is deliberately less functional: opaque previews lose storage,
  service workers and some origin-sensitive browser APIs. That is the cost of
  not letting arbitrary previewed code run as CodeNomad.
- `app` is full trust. The warning must be explicit; it covers app APIs, app
  DOM/transcript, localStorage/IndexedDB/CacheStorage, cookies that are not
  HttpOnly, and service workers that can persist and intercept future app
  requests. The origin confirmation is the consent point.
- `custom` isolates the app origin only if the server is origin-aware. The
  same preview path served at the app origin must remain opaque, or a custom
  preview can self-navigate/embed the app-origin path with its token and escape
  the sandbox. The custom origin must use a distinct hostname and the reverse
  proxy must preserve `Host`.
- The preview origin may still share a fixed origin between previews; a
  malicious preview can affect another preview's storage/service worker. This
  is acceptable for the initial design; per-token preview origins remain a
  future option.
- Custom origins on a different host avoid app cookies; a different port does
  not isolate cookies (cookies ignore ports), so deployments should prefer a
  different host/site when API/cookie isolation matters. App CORS and CSRF
  protections must not allow the preview origin. The docs state this.
- Browser feature toggles only delegate; the browser's own site settings and
  prompts are the final gate. A configured feature does not bypass a browser
  block and a browser allow does not bypass a missing delegation. The target's
  own `Permissions-Policy` is stripped so the CodeNomad delegation is
  predictable; browser site settings still win.
- The server remains authoritative for origin mode and sandbox flags. UI
  settings are a projection of server config, not a separate security layer.
- The server CSP is injected on all path-proxied responses; the target's CSP is
  still stripped. The reverse proxy for a custom origin must not strip or
  replace the injected CSP.

## Out of scope

- Pop-out/new-window preview behavior.
- Per-project preview policies.
- Server-managed preview listeners.
- Per-preview/per-token custom origins.
- Root-relative Worker/service-worker rewriting at custom origins; the custom
  origin contract currently covers the rewritten `/previews/<token>/...`
  namespace only.
- A service-worker-specific toggle; service workers follow the origin mode.
- Applying iframe sandbox/feature toggles to Electron and Windows Tauri native
  webviews, or a native desktop browser-permission UI; those hosts keep their
  existing permission, download and popup handling. Desktop capability-host
  previews keep their existing isolated origin.

## Left to the builder

- Choose the exact icon and copy for the Preview nav item and cards.
- Decide whether the custom-origin field saves on blur or via an explicit
  button; the design requires validation and an explicit security confirmation
  for app mode.
- Keep the server and UI normalizers in behavior sync and pin both with tests.
- Normalize default ports when comparing the custom origin with `Host` and
  with `serverMeta` origins; do not guess scheme from an untrusted forwarded
  header.
- Verify the iframe `allow` serialization for disabled features in the browser
  fixtures, especially the same-origin `'none'` override.
- Decide whether policy changes reload or close open previews; the design
  requires that an app-to-opaque downgrade cannot leave a live same-origin
  document.
