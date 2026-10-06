# External right-panel extensions — API 1

CodeNomad panel extensions are independently distributed **UI addons**, not
OpenCode plugins. Open **Customize right panel → Panel extensions → Available
online** to browse/search the official catalogue, choose an addon, review the
downloaded package and confirm installation. No manual ZIP download, CodeNomad
rebuild or shared OpenCode service restart is involved. Manual ZIP installation
remains available for offline/unlisted packages.

The official index lives in
[`NeuralNomadsAI/CodeNomad-Extensions`](https://github.com/NeuralNomadsAI/CodeNomad-Extensions).
That repository may hold **multiple** official addons plus the catalogue. Other
authors can host addons in their own repositories; the curated catalogue points
to their exact release assets. Separate means separate from the main CodeNomad
application repository, not a mandatory repository per addon.

This first distribution contract intentionally exposes only session identity and
appearance. It does **not** implement #801's gallery or grant transcript/image/file
reads. The later assets example must add a narrowly authorized, bounded image-read
capability; importing application stores or opening the generic RPC proxy is not
an extension API.

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
16 MiB persisted catalogue, 128 explicit folder grants per extension.

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
  version. API 1 extensions work on hosts supporting API 1. An unsupported major
  API or unknown permission is rejected, without executing author code.
- Author, name, license and repository are mandatory. Repository must be an HTTPS
  GitHub repository URL, without credentials/query/fragment. Metadata is a claim,
  not a signature. Use a real repository, SPDX license where possible, and include
  that license's notice in the source and in the self-contained panel.
- Unknown manifest fields are rejected. Internal Solid interfaces/import paths are
  not public compatibility promises. Additive API-1 evolution must preserve old
  packages; breaking changes require a new API major and an explicit migration.

## Installation, updates and scope

Inspection shows the manifest and SHA-256 of the exact ZIP bytes before install.
The user acknowledges trust; installation starts **disabled**. Enable with either:

- **All projects:** every opened project on this CodeNomad backend/profile.
- **This folder:** the exact server-owned physical folder opened as the project.
  It persists across closing/reopening, but does not infer sibling worktrees,
  ancestor folders, another WSL distribution or a native project-ID family.

Both scopes live under the selected CodeNomad profile's `panel-extensions/`, not
inside a repository or the OpenCode discovery/database directories. In remote
access, installation affects that **server profile**, not the viewer's device.
Profiles/channels remain separate; a ZIP can be installed in each desired profile.
Global grants take precedence; turn off All projects before limiting to folders.

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
node scripts/test-panel-extension-native.mjs # Windows, isolated Tauri/WebView2
# from packages/ui:
node --import tsx --test tests/browser/panel-extensions.test.ts
```

Server checks cover format/permission/API validation, ZIP bounds/path attacks,
durable scopes, replacement revocation, concurrent changes and corrupt-state
preservation. Catalogue checks cover SSRF/redirect/budget rejection, manifest/hash
verification, metadata-only discovery and withdrawn selections after warm reads.
Rendered tests use the real right panel, installer, routes and event dispatcher
for online browse/search/consent, offline fallback, incompatibility and lifecycle.
