# External right-panel extensions — APIs 1 and 2

CodeNomad panel extensions are independently distributed **UI addons**, not
OpenCode plugins. Open **Customize right panel → Extensions** to browse/search
installed addons and the official catalogue together, choose an addon, review the
downloaded package and confirm installation. No manual ZIP download, CodeNomad
rebuild or shared OpenCode service restart is involved. Manual ZIP installation
remains available for offline/unlisted packages.

Extensions is a collapsed-by-default disclosure below a separator in customization.
It expands to one compact searchable list, deduplicated by addon ID, with install,
version-change and removal icons, ZIP/refresh actions, metadata on hover/focus,
and explicit trust/removal confirmations. There are no separate list modes or
floating manager window. Collapse, popup dismissal, project changes and leaving
the view dispose the manager; no automatic mutation replay.

The official index lives in
[`NeuralNomadsAI/CodeNomad-Extensions`](https://github.com/NeuralNomadsAI/CodeNomad-Extensions).
That repository may hold **multiple** official addons plus the catalogue. Other
authors can host addons in their own repositories; the curated catalogue points
to their exact release assets. Separate means separate from the main CodeNomad
application repository, not a mandatory repository per addon.

API 1 preserves its session-identity-only contract. API 2 adds the explicit
`session.assets.read` permission for the independent **MCP Assets** addon (#801).
It exposes bounded tool-result asset metadata and demand-only embedded bytes from
the currently displayed session, never prompts, transcript text, arbitrary URLs,
local files, credentials or a generic RPC proxy. Existing API 1 packages keep
working without migration or additional permissions.

## Package layout

The ZIP contains exactly two UTF-8 files at its root:

```text
manifest.json
panel.html
```

`panel.html` is self-contained: inline JavaScript/CSS and optional data-URI assets.
Build with any framework outside CodeNomad, then bundle into that one HTML file.
There are no install scripts, npm installation, dependency fetching, Node modules,
server entrypoints or native binaries. Symlinks, extra files, nested paths,
duplicate ZIP entries, encrypted entries and invalid UTF-8 are rejected. Limits:
2 MiB ZIP, 4 KiB manifest, 2 MiB uncompressed HTML, 32 installed extensions,
16 MiB persisted catalogue.

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
  maintain the same ID across releases. The namespace is **not** verified ownership.
- Version: `major.minor.patch`, optionally `-prerelease`. Publish new code under a
  new version; never replace the bytes of an already published release asset.
- API version: compatibility with the extension host, **not** the exact application
  version. This host supports API 1 and API 2. API 2 requires exactly
  `["session.context", "session.assets.read"]`. An unsupported major
  API or unknown permission is rejected, without executing author code.
- Author, name, license and repository are mandatory. Repository must be an HTTPS
  GitHub repository URL, without credentials/query/fragment. Metadata is a claim,
  not a signature. Use a real repository, SPDX license where possible, and include
  that license's notice in the source and in the self-contained panel.
- Unknown manifest fields are rejected. Internal Solid interfaces/import paths are
  not public compatibility promises. Additive API-1 evolution must preserve old
  packages; breaking changes require a new API major and an explicit migration.

## Installation and updates

Inspection shows the manifest and SHA-256 of the exact ZIP bytes before install.
The user acknowledges trust; installation starts **disabled**. A single activation
control, the addon's checkbox in **Customize right panel**, enables it for every
opened project on this CodeNomad backend/profile. Disabled installed addons remain
listed there. The Extensions manager has no activation control. Legacy per-window
addon hide flags are ignored rather than retaining a second gate; Reset changes
built-in layout only and never grants or revokes addon consent.
Installation and activation live under the selected profile's `panel-extensions/`,
not inside a repository or the OpenCode discovery/database directories. In remote
access, installation affects that **server profile**, not the viewer's device.
Profiles/channels remain separate; a ZIP can be installed in each desired profile.
There is no folder-specific installation or activation. Legacy global grants remain
enabled; legacy folder-only grants remain disabled rather than broadening consent.
Installed packages are preserved. Reads do not rewrite storage; the next explicit
mutation drops obsolete folder grants.

To update, download and inspect a new release ZIP and install it over the same ID.
Compare the displayed digest with the publisher's checksum through a trusted
channel. Replacing code revokes **all** activation grants, even when permissions
are unchanged. The old package remains intact on validation, conflict or storage
failure. Concurrent mutations compare exact digests. Removal is explicit and
removes the installed code plus its grants, not sessions or project data.

There is no arbitrary URL installer, silent update, automatic project discovery,
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

There is no instance URL, auth token, directory, prompt, transcript, credential,
filesystem handle, eval callback or native bridge in this API. Translate your panel
using `context.locale`; CodeNomad does not accept injected translation keys.
Honor appearance, keyboard navigation, accessible labels and square host chrome.
The panel can be unmounted whenever hidden, disconnected, disabled, replaced,
removed, or when the project/session changes. Treat DOM state as disposable.

Each mounting has a new one-use MessageChannel handshake bound to the injected
document. Parent window messages are not an RPC dispatcher. Late HTTP results and
old ports cannot initialize a different session or a reloaded/navigated document.

## Isolation and limits

### API 2 assets

Use `apiVersion: 2` and the two permissions above. Inspection shows the additional
current-session asset permission before the trust checkbox. Code replacement still
revokes activation. The injected context advertises that package's API version.
API 2 also receives `context.colors` (`background`, `surface`, `text`, `muted`,
`border`, `focus`) from the current host palette. Palette changes republish context.
`background` matches the native panel sections (`--surface-secondary`); `surface`
is the inset base canvas. Apply `background` to the panel document so its
`color-scheme` cannot substitute a browser-default canvas color.

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
session/project/workspace membership again. There is no mass-loading fallback.
Reverted, removed or replaced assets are not readable; targets carry the URI digest.

Pages return at most 64 metadata entries, examine at most 32 assistant messages and
32 MiB of stored JSON per request (16 MiB per message), yielding between messages.
The newest-first cursor is session/location/undo-bound and fixes the upper sequence;
refresh includes later output. It is not an immutable snapshot of mutable message
content. One SQLite step/JSON parse remains synchronous and bounded by those byte
limits. Read payloads are at most 8 MiB of embedded data URI; remote/local references
remain listed but unavailable. No URL is fetched and no local file is opened.

The host fences old ports/session transitions, caps each frame at four concurrent
reads, aborts on unmount/disconnect, and sends coalesced invalidations for tool
completion, content changes, undo, deletion and reconnect. Thumbnails are derived
only from authorized embedded raster bytes; no transcript rows mount or change.
Before host bitmap decoding, PNG/JPEG/GIF/static-WebP headers must admit at most
8,192 pixels per axis and 4,194,304 source pixels (summed across GIF frames).
Malformed/ambiguous headers, animated WebP and AVIF have no host thumbnail;
their metadata and demand-only full preview remain available to the addon.
The addon keeps one page, lazily requests two visible thumbnails at a time and
revokes object URLs as images leave the viewport or the page/session changes.
Click opens a keyboard-dismissable image/text lightbox. Binary or inaccessible
attachments keep their metadata with an explicit unavailable preview. It does not
change transcript image visibility or claim to fix transcript scrolling.

### Sandbox

Author code is never imported into the main renderer. It runs in an iframe with
`sandbox="allow-scripts"`: no same-origin, forms, popup, download or top-navigation
grant. A host-inserted CSP precedes author bytes and disallows network APIs,
external scripts/styles/images, nested frames, base URLs, objects and form targets.
Only inline scripts/styles and data/blob image assets are allowed. Windows Tauri
may inject native bridge objects into subframes; their presence is not permission.
The frame's opaque origin, CSP and native transport restrictions must prevent
their use. No app-native capabilities are passed through the extension API.

This is **not** a process/CPU isolation guarantee or an offline/safe-code guarantee.
A hostile approved author can hang its renderer and can try self-navigation;
browser navigation is not comprehensively blocked by CSP. A navigated document
cannot acquire the context handshake; it is detached on the next load. Install
only trusted authors and do not pass secrets to extensions. Desktop-native command
denial needs its own native qualification, not merely Chromium frame tests.

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

From the package folder, Python's standard library is enough:

```sh
python -m zipfile -c example.session-1.0.0.zip manifest.json panel.html
python -m zipfile -l example.session-1.0.0.zip
```

Publish this built asset, **not** GitHub's repository source ZIP (which has a parent
directory and other files). Author-owned repositories remain supported. Submit a
catalogue PR to the official repository with the full manifest, plain-text
description, exact tag/ZIP filename and SHA-256; see its `CONTRIBUTING.md`.

## Online catalogue and download boundary

The backend fetches only the fixed public HTTPS index
`https://raw.githubusercontent.com/NeuralNomadsAI/CodeNomad-Extensions/main/catalog.json`.
Opening the manager loads metadata only, not every addon. Display reads coalesce
and cache for 30 seconds; Refresh bypasses the snapshot. A failed online read never
disables installed addons or local ZIP installation. The UI shows unsupported
API/permission entries as incompatible and disables their install action.

Selecting an entry reads a fresh index and downloads that **exact** tagged asset.
The hash and full ZIP manifest must match the catalogue. Confirmation repeats the
fresh index/download verification: withdrawal, changed digest/metadata, corrupt
bytes, a changed installed target or missing consent cannot silently install a
different package. Updates remain explicit version changes, never automatic.

Index schema 1 is `{ schemaVersion: 1, extensions: [...] }`. Each entry has
`manifest`, `description`, `digest` and `release: { tag, asset }`; unknown fields
and duplicate addon IDs are rejected. Limits are 128 entries and 256 KiB UTF-8.
Packages use the same existing ZIP/storage budgets and disabled-first policy.

Clients submit addon ID/digest, **not a URL**. Repository/tag/asset URLs are derived
from the validated index. Downloads allow only HTTPS `github.com` and its exact
public release CDN hosts `release-assets.githubusercontent.com` and
`objects.githubusercontent.com`, with at most three redirects and a 15-second
deadline. Credentials, nonstandard ports, arbitrary hosts/protocols, redirected
catalogues and oversized streamed bodies fail closed. No GitHub token, CodeNomad
cookie, directory, session content or provider secret is sent upstream.

The reviewed index is the integrity source, not a cryptographic author signature.
Removing an index entry blocks future online installation, not installed copies
or explicit local ZIP installation. A compromised approved author/index is not
made safe by a checksum: user trust, minimal permissions and isolation still apply.

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
durable general activation, conservative legacy consent, replacement revocation, concurrent changes and corrupt-state
preservation. Catalogue checks cover SSRF/redirect/budget rejection, manifest/hash
verification, metadata-only discovery and withdrawn selections after warm reads.
Rendered tests use the real right panel, installer, routes and event dispatcher
for online browse/search/consent, offline fallback, incompatibility and lifecycle.
