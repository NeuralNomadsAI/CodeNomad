# External right-panel extensions — APIs 1 and 2

CodeNomad panel extensions are independently distributed right-panel **UI
addons**. Open **Customize right panel → Extensions** to browse/search installed
addons and the official catalogue together, choose an addon, review the
downloaded package and confirm installation, which applies immediately. Manual
ZIP installation serves offline/unlisted packages.

Extensions list rows carry install, version-change and removal icons beside
ZIP/refresh actions; disposal never replays a mutation.

The official index lives in
[`NeuralNomadsAI/CodeNomad-Extensions`](https://github.com/NeuralNomadsAI/CodeNomad-Extensions).
That repository may hold **multiple** official addons plus the catalogue. Other
authors can host addons in their own repositories; the curated catalogue points
to their exact release assets.

API 1 exposes context only (session ID, locale, appearance). API 2 adds the explicit
`session.assets.read` permission used by the independent **MCP Assets** addon:
bounded tool-result asset metadata and demand-only embedded bytes from the
currently displayed session, never prompts, transcript text, arbitrary URLs,
local files, credentials or a generic RPC proxy.

## Package layout

The ZIP contains exactly two UTF-8 files at its root:

```text
manifest.json
panel.html
```

`panel.html` is self-contained: inline JavaScript/CSS and optional data-URI assets.
Build with any framework outside CodeNomad, then bundle into that one HTML file.
Symlinks, extra files, nested paths, duplicate ZIP entries, encrypted entries and
invalid UTF-8 are rejected. Limits: 2 MiB ZIP, 4 KiB manifest, 2 MiB uncompressed
HTML, 32 installed extensions, 16 MiB persisted installed-extension store.

```json
{
  "id": "example.session",
  "name": "Session example",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "Example",
  "license": "MIT",
  "repository": "https://github.com/example/session",
  "permissions": ["session.context"]
}
```

- ID: lowercase `namespace.name`, each segment 2–40 characters, letters/digits/
  hyphens, starting with a letter. Use your GitHub account/organization namespace;
  maintain the same ID across releases. The namespace and all other metadata are
  unverified claims.
- Version: `major.minor.patch`, optionally `-prerelease`. Publish new code under a
  new version; never replace the bytes of an already published release asset.
- API version: the extension-host contract major, independent of the application
  version. This host supports API 1 and API 2. API 2 requires exactly
  `["session.context", "session.assets.read"]`. An unsupported major
  API or unknown permission is rejected, without executing author code.
- Author, name, license and repository are mandatory. Repository must be an HTTPS
  GitHub repository URL, without credentials/query/fragment. Use a real
  repository, SPDX license where possible, and include that license's notice in
  the source and in the self-contained panel.
- Unknown manifest fields are rejected. Additive API-1 evolution must preserve
  existing packages; breaking changes require a new API major and an explicit
  migration.

## Installation and updates

Inspection shows the manifest and SHA-256 of the exact ZIP bytes before install.
The user acknowledges trust; installation starts **disabled** until the addon's
**Customize right panel** checkbox enables it for every project on this
backend/profile; legacy per-window hide flags are ignored. State lives under the
selected profile's `panel-extensions/`, never in a repository or OpenCode
discovery/database directories; in remote access it belongs to the **server
profile**, and each profile/channel installs separately. Legacy global grants
load as enabled and folder-only grants as disabled, with installed packages kept;
reads never rewrite storage, and the next explicit mutation drops folder grants.

To update, download and inspect a new release ZIP and install it over the same ID.
Compare the displayed digest with the publisher's checksum through a trusted
channel. Replacing code revokes **all** activation grants, even when permissions
are unchanged. The old package remains intact on validation, conflict or storage
failure. Concurrent mutations compare exact digests. Removal is explicit and
removes only the installed code and its grants.

Never add an arbitrary URL installer, silent update, automatic project discovery,
signature authority or remote-code startup hook. Keep trusted source/releases
available for audit; never regard a SHA-256 or a GitHub URL alone as proof of trust.

## Public browser API

The host supplies `window.codenomad` before author scripts run:

```js
const unsubscribe = codenomad.onContext(context => {
  // { apiVersion: 1, sessionId: string | null, locale, appearance: "light" | "dark" }
  document.querySelector("#session").textContent = context.sessionId ?? "—"
})
// codenomad.getContext() returns the latest context, or null before initialization.
// unsubscribe() removes this listener.
```

Never add an instance URL, auth token, directory, prompt, transcript, credential,
filesystem handle, eval callback or native bridge to this API. Panels translate
themselves using `context.locale`. Honor appearance, keyboard navigation, accessible labels and square host chrome.
The panel can be unmounted whenever hidden, disconnected, disabled, replaced,
removed, or when the project/session changes. Treat DOM state as disposable.

Each mounting has a new one-use MessageChannel handshake bound to the injected
document; never turn parent-window messages into an RPC dispatcher. Late HTTP
results and old ports cannot initialize a different session or a
reloaded/navigated document.

## Isolation and limits

### API 2 assets

Use `apiVersion: 2` and the two permissions above. Inspection shows the additional
current-session asset permission before the trust checkbox. The injected context
advertises that package's API version.
API 2 also receives `context.colors` (`background`, `surface`, `text`, `muted`,
`border`, `focus`) from the current host palette. Palette changes republish context.
`background` matches the native panel sections (`--surface-secondary`); `surface`
is the reading canvas (`--surface-canvas`, resolved to a concrete colour). Apply
`background` to the panel document so its `color-scheme` cannot substitute a
browser-default canvas color.

```js
const page = await codenomad.assets.list() // or list(page.cursor) for older pages
// { status: "page", entries: [{ target, name, tool, mime, available }], cursor }
const image = await codenomad.assets.read(page.entries[0].target)
// { status: "asset", mime, uri: "data:...;base64,..." }
const small = await codenomad.assets.read(page.entries[0].target, { thumbnail: true })
// Raster-only, max 256px on either axis, PNG data URI.
const stop = codenomad.assets.onChanged(() => { /* refresh displayed metadata */ })
```

The host owns instance/session/package/digest selectors; the addon supplies only
a bounded cursor or exact asset target. Each server call checks enabled API 2
consent and fresh session Location ownership before and after the fixed native RPC.
The existing presence-owned history bundle validates daemon-storage identity and
session/project/workspace membership again. Reads refuse reverted, removed or
replaced assets; targets carry the URI digest.

Pages return at most 64 metadata entries, examine at most 32 assistant messages and
32 MiB of stored JSON per request (16 MiB per message), yielding between messages.
The newest-first cursor is session/location/undo-bound and fixes the upper sequence;
refresh includes later output, and listed message content may still change. One
SQLite step/JSON parse remains synchronous and bounded by those byte limits. Read
payloads are at most 8 MiB of embedded data URI; remote/local references stay
listed as unavailable, and the host never fetches a URL or opens a local file.

The host fences old ports/session transitions, caps each frame at four concurrent
reads, aborts on unmount/disconnect, and sends coalesced invalidations for tool
completion, content changes, undo, deletion and reconnect. Thumbnails are derived
only from authorized embedded raster bytes and never mount or change transcript rows.
Before host bitmap decoding, PNG/JPEG/GIF/static-WebP headers must admit at most
8,192 pixels per axis and 4,194,304 source pixels (summed across GIF frames).
Malformed/ambiguous headers, animated WebP and AVIF have no host thumbnail;
their metadata and demand-only full preview remain available to the addon.

### Sandbox

Author code runs in an iframe with `sandbox="allow-scripts"` as its only grant.
A host-inserted CSP precedes author bytes and allows only inline scripts/styles
and data/blob image assets: network APIs, external scripts/styles/images, nested
frames, base URLs, objects and form targets are blocked. Windows Tauri may inject
native bridge objects into subframes; the frame's opaque origin, CSP and native
transport restrictions must prevent their use.

A hostile approved author can still hang its renderer and attempt
self-navigation, which CSP blocks only partly; a navigated document never
acquires the context handshake and is detached on the next load. Install only
trusted authors and never pass secrets to extensions. Qualify desktop-native
command denial with the native fixture, beyond Chromium frame tests.

## Independent GitHub repository rules

Copy `examples/panel-extension/` into a separate repository, replace its example
identity/repository, and commit source, license, README, manifest and build recipe.
Publish a GitHub Release with:

1. A tag matching the manifest version, e.g. `v1.0.0`.
2. An immutable `namespace.name-1.0.0.zip` release asset and SHA-256 file.
3. Supported API major, requested permissions, changelog, maintainer and issue URL.
4. Reproducible build/test instructions and dependency licenses if bundling a UI.
5. Security reports handled by the extension author; never request credentials,
   weaken the sandbox, depend on application internals or auto-run commands.

Build the ZIP and its `.sha256` file with the commands in
`examples/panel-extension/README.md` and publish that asset (never GitHub's
source ZIP, which adds a parent directory and extra files). Submit a catalogue PR to the official
repository with the full manifest, plain-text description, exact tag/ZIP filename
and SHA-256; see its `CONTRIBUTING.md`.

## Online catalogue and download boundary

The backend fetches only the fixed public HTTPS index
`https://raw.githubusercontent.com/NeuralNomadsAI/CodeNomad-Extensions/main/catalog.json`.
Opening the manager loads catalogue metadata only. Display reads coalesce
and cache for 30 seconds; Refresh bypasses the snapshot. A failed online read never
disables installed addons or local ZIP installation. The UI shows unsupported
API/permission entries as incompatible and disables their install action.

Selecting an entry reads a fresh index and downloads that **exact** tagged asset.
The hash and full ZIP manifest must match the catalogue. Confirmation repeats the
fresh index/download verification: withdrawal, changed digest/metadata, corrupt
bytes, a changed installed target or missing consent cannot silently install a
different package.

Index schema 1 is `{ schemaVersion: 1, extensions: [...] }`. Each entry has
`manifest`, `description`, `digest` and `release: { tag, asset }`; unknown fields
and duplicate addon IDs are rejected. Limits are 128 entries and 256 KiB UTF-8.
Packages use the same existing ZIP/storage budgets and disabled-first policy.

Clients submit only the addon ID/digest; repository/tag/asset URLs are derived
from the validated index. Downloads allow only HTTPS `github.com` and its exact
public release CDN hosts `release-assets.githubusercontent.com` and
`objects.githubusercontent.com`, with at most three redirects and a 15-second
deadline. Credentials, nonstandard ports, arbitrary hosts/protocols, redirected
catalogues and oversized streamed bodies fail closed. Never send a GitHub token,
CodeNomad cookie, directory, session content or provider secret upstream.

The reviewed index is the sole integrity source. Removing an index entry blocks
only future online installation; installed copies and local ZIP installation remain.

## Checks

```sh
node --import tsx --test packages/server/src/panel-extensions/extension.test.ts
node --import tsx --test packages/server/src/panel-extensions/catalog.test.ts
node --import tsx --test packages/server/src/opencode/session-pruning/assets.test.ts packages/server/src/server/routes/panel-extension-assets.test.ts
node scripts/test-panel-extension-native.mjs # Windows, isolated Tauri/WebView2
node scripts/test-panel-extension-native.mjs --api2
node --import tsx --test packages/ui/src/components/panel-extensions/image-bounds.test.ts
node scripts/run-session-pruning-native.mjs /absolute/path/to/opencode # isolated CLI/config/database
# from packages/ui:
node --import tsx --test tests/browser/panel-extensions.test.ts
```

Server checks cover format/permission/API validation, ZIP bounds/path attacks,
durable general activation, conservative legacy consent, replacement revocation,
concurrent changes and corrupt-state preservation. Catalogue checks cover SSRF/redirect/budget rejection, manifest/hash
verification, metadata-only discovery and withdrawn selections after warm reads.
Rendered tests use the real right panel, installer, routes and event dispatcher
for online browse/search/consent, offline fallback, incompatibility and lifecycle.

## Agent conventions

- Right-panel customization keeps Extensions below a separator in a native disclosure, collapsed on each popup opening. Expanding mounts one compact searchable list combining installed and online addons, deduplicated by ID; collapse, dismissal and inactive/instance changes dispose its requests and confirmations; never add separate list modes or a floating extension window. The per-addon checkbox above the disclosure is the sole activation control, including for disabled installed addons; never add a manager switch or a per-window visibility gate. Reset changes built-in layout only, never addon consent. Keep metadata on hover/focus and technical consent details folded; retain explicit trust and digest-bound replacement/removal. Installation and activation are profile-wide. Legacy folder grants never become general consent.
- External panel extensions use `components/panel-extensions/` and `styles/panels/panel-extensions.css`. The official online catalogue is in `NeuralNomadsAI/CodeNomad-Extensions`; metadata discovery never downloads author code. Inspect/install revalidate the exact index/manifest/digest and use bounded credential-free HTTPS GitHub release downloads, never client-provided URLs. Never import author JavaScript into the main renderer or expose native/OpenCode bridges. ZIPs contain only a manifest and a self-contained HTML panel; install/replacement revokes activation. API versions cover only the public `window.codenomad` contract; never make internal Solid modules or import paths part of it.
- Extension API 1 stays context-only; API 2 requires explicit `session.assets.read` consent. `assets-channel.ts` derives session authority from the current mounted host, never author selectors, and exposes only bounded asset pages/exact digest-bound embedded reads. Use the presence-owned history bundle's fixed `assets`/`assetRead` methods, never transcript stores, generic RPC, remote downloads or filesystem fallbacks. Recheck consent and Location ownership after IO; revoke old-port/session/reconnect results. Gallery HTML belongs in the independent catalogue repository; never add it to the application renderer.
