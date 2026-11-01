# External right-panel extensions — APIs 1 to 4

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
local files, credentials or a generic RPC proxy. API 3 adds the explicit
`repository.workItems.read` permission: bounded issue and pull request pages of
the project's GitHub, GitLab or Gitea/Forgejo repository, read by the host, and
opening one item's page in the browser. API 4 carries `session.context` plus any
non-empty subset of a finite permission set used by the independent **Design**
image companion ([API 4](#api-4)): read-back images of the displayed conversation, their prompts,
composer prefill, the Images conversation, the Design agent and panel preferences.
Its integration capabilities add bounded catalogue, state and application-offer reads plus authenticated, host-confirmed management requests.

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
  version. This host supports APIs 1 to 4. API 2 requires exactly
  `["session.context", "session.assets.read"]` and API 3 exactly
  `["session.context", "repository.workItems.read"]`; API 4 takes
   `session.context` plus a non-empty subset of its eight permissions, each at most
   once, in any order; `session.images.prompts` requires `session.images.read` and
   `bundles.manage` requires `bundles.read`. An unsupported major API or unknown permission is
  rejected, without executing author code, and the catalogue shows it incompatible.
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
are unchanged, and drops the record's API 4 preferences. The old package remains
intact on validation, conflict or storage failure. Concurrent mutations compare
exact digests. Removal is explicit and removes only the installed code, its grants
and its preferences.

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
replaced assets; targets carry the URI digest. Tool files stored as OpenCode media
refs list and read as the inline data URIs native reads return (digest of the stored
ref, sizes from the blob without loading it); a ref whose blob is gone is no asset.

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

### API 3 work items

Use `apiVersion: 3` and its two permissions. Inspection shows the repository
permission before the trust checkbox; the context also carries `colors` (API 2).

```js
const page = await codenomad.workItems.list({ kind: "pullRequest", query: "", page: 1 })
// { status: "ok", repository: { provider, host, path, webUrl, access }, items, page, hasMore, total }
// or { status: "unavailable", reason: "no_remote" | "unsupported_host" | "sign_in" | "rate_limited" }
// items: [{ kind, number, title, state: "open" | "closed" | "merged", draft, author, labels, updatedAt, url }]
await codenomad.workItems.open("pullRequest", page.items[0].number) // { opened: boolean }
```

`kind` is `issue` or `pullRequest` (GitLab merge requests). `query` holds words
(a search among open items: literal quoted terms on GitHub, whose search
qualifiers and operators are stripped) or `#number`/`number` (that item in any
state, or none); pages hold at most 20 items, up to page 50, and never advertise
a later one; `fresh` bypasses the 30-second cache. Addons choose only kind,
query, page or number: the host (`server/src/forge/`) reads the project folder's
`upstream` remote, else `origin`, else any forge remote (strictly validated host,
HTTPS port and path segments), and never shows the addon the folder, the remote
URL or credentials. Only items whose page lies under the repository's web
address are published.

github.com, gitlab.com, codeberg.org and gitea.com are read through the user's
signed-in `gh api`, `glab api` or `tea api` (tea ≥ 0.12, with the login matching
the exact host and port, its stderr status checked), falling back to their
anonymous REST API (public repositories, low rate limits). Any other host is
identified and read only through a CLI signed in to it, never contacted
anonymously. CLIs run without a shell, with prompts, pagers, colour, update
checks and telemetry disabled, a 15-second limit and a 4 MiB output budget;
anonymous bodies are bounded to 4 MiB while streaming. CodeNomad stores no token.
Private repositories without a sign-in report `sign_in`.

Repository discovery and page reads are shared loads (`forge/shared-loads.ts`):
identical callers join one load, which is cancelled (CLI process or fetch) once
every caller has gone; a caller already gone starts nothing, a cancelled load is
never joined and cache eviction never drops a running one. Every CLI process or
fetch, discovery included, runs within one host-wide budget: four at once,
sixteen waiting, further reads refused. The
routes cancel a read whose caller disconnects, recheck consent before and after
each read and drop the result when the project closed meanwhile. `open` asks the
server for the item's page on the repository's own forge (`forgeWebUrl`), never
an addon URL, and opens it through the host's external link opener: one open at
a time, at most once a second measured at the opener. The channel caps four
requests per frame and aborts on unmount and transport loss.

### API 4

Use `apiVersion: 4`, `session.context` and at least one of the permissions below.
Each permission is one capability with fixed methods and one install sentence
(`panelExtensions.api4.<permission>` in every locale); inspection lists them before
the trust checkbox, activation grants the whole set and replacement revokes it. The
bridge defines only the objects of declared permissions, and every server route
(`server/routes/panel-extension-api4.ts`, `server/routes/panel-extension-bundles.ts`) checks its own permission on the enabled
exact package before and after IO. Never add a permission registry, generic RPC or partial grant.

| Permission | Frame API | Host authority |
|---|---|---|
| `session.images.read` | `images.status()`, `images.list(cursor?)`, `images.read(target, { thumbnail })`, `images.onChanged(listener)` | displayed conversation; session-pruning `images`/`imageRead` ([gallery](SESSION_PRUNING_RPC.md#image-gallery)) |
| `session.images.prompts` (requires the above) | adds `prompt`, `promptTruncated`, `model` to generations and proven images | only in a root session marked `codenomad.companion: images`, enforced by the plugin |
| `composer.prefill` | `composer.prefill({ text, refs? })` | displayed conversation's composer; `imageReference` per target |
| `images.conversation` | `conversation.status()`, `conversation.open()`, `conversation.startNew()` | the displayed conversation's Location (else the instance's), `images-conversation.ts` |
| `opencode.designAgent` | none | while enabled, this backend's leases request the Design agent (`opencode/design/demand.ts`) |
| `panel.preferences` | `preferences.get()`, `preferences.set(object)` | the server profile's store, per extension |
| `bundles.read` (draft) | `bundles.catalog()`, `bundles.state()`, `bundles.hosts({ integration })`, `bundles.openDocs({ integration })`, `bundles.onChanged(listener)` | the conversation captured by the mounted host; fixed integration readers, exact-session `bindingRead` and canonical catalogue documentation |
| `bundles.manage` (requires `bundles.read`) | `bundles.request({ action, integration, scope })`, `bundles.setActive({ integration, scope, enabled })`, `bundles.installHost({ integration })`, `bundles.attach({ integration, offerID })`, `bundles.detach({ integration })` | authenticated parent-owned mount and backend confirmation lifecycle; `request` supports install/update/remove; `detach` returns `invalid` |

```js
const status = await codenomad.images.status()
// { generation: "available" | "disabled" | "unsupported", imageModels, designAgent: "present" | "absent" | "user",
//   contentVersion, chatModelSeesImages: boolean | null }
const page = await codenomad.images.list() // { status: "page", entries, cursor } or { status: "blocked", reason }
const image = await codenomad.images.read(page.entries[0].target, { thumbnail: true })
// { status: "asset", mime, uri } | { status: "not-previewable" } | { status: "blocked", reason }
codenomad.images.onChanged(({ gallery, status }) => { /* gallery: restart from page 1; status: read it again */ })
await codenomad.composer.prefill({ text: "Refine {{1}}", refs: [target] }) // "added" | "busy" | "no-session" | "too-long" | "invalid"
await codenomad.conversation.status()
// { lookup: "found" | "absent" | "unknown", imageCount: number | null, lastUsed: number | null, displayedIsImages,
//   gitExclusion: "excluded" | "missing" | "not-repository" | "unavailable" | null }
await codenomad.conversation.open() // { opened, created }; codenomad.conversation.startNew() → { opened }
await codenomad.preferences.get() // object, or "unavailable"
await codenomad.preferences.set({ imagesPerTurn: 3 }) // "saved" | "too-large" | "invalid" | "unavailable"
```

- **Status** reads the session's Location (without a displayed conversation, the
  instance's current Location): generation from `experimental.image_generate` in the
  daemon schema and its effective value, on unless `false` (`opencode/image-settings.ts`), image models
  from the Location's image catalog, the Design agent's content mark
  (`opencode/design/status.ts`), and whether the effective chat model (session,
  else its agent's when available, else the native default) lists an `image*`
  input. No provider name or key leaves the host.
- **Gallery** pages are the plugin's own, with `blocked` reasons passed through
  (`conflict` restarts from the first page). Full-size reads and thumbnails both pass
  `assertThumbnailBounds` first; outside the bounds the answer is `not-previewable`,
  which AVIF always is, since its grids cannot be bounded before decoding. Without a
  displayed conversation the list is empty.
- **Invalidations** reuse native events, coalesced over 300 ms into one
  `images:changed`, delivered to each `images.onChanged` listener as a frozen
  `{ gallery, status }`: the displayed session's tool calls and results, synthetic
  notices, updates, moves, deletion, reverts, compaction and prunes set `gallery`
  (restart from the first page); agent, skill, configuration, plugin, model, provider,
  integration and credential events set `status` (read `images.status()` again);
  reconnects set both. Never poll.
- **Prefill** (`components/panel-extensions/composer-prefill.ts`, [Composer](COMPOSER.md)):
  `{{n}}` markers (1 to 16) must match `refs` exactly; each reference is revalidated by
  its own `imageReference` call, in that call's own read transaction, when the request
  arrives, and cited as a backtick-quoted Location-relative path, never substituted;
  any refused reference makes the whole prefill `invalid`. The added text is at most
  2,048 UTF-8 bytes after substitution; the resulting draft is refused when its trimmed
  text starts with `/` or when the picker's own `findMentionStart` finds an open
  mention at its end. One write of the draft captured at mount, rechecked just before.
  At most one request a second per extension and window: every request accepted past
  the session, shell and rate checks counts, including one that then answers `invalid`
  (malformed input and more than 16 references are refused before counting); shell
  mode answers `busy`. Desktop focuses the composer and retakes focus once a frame
  later; a phone answers, then closes the floating panel and requests composer focus.
  Prefill only writes the draft: never send, attach or run anything from it.
- **Conversation**: `open`/`startNew` resolve title, agent and model as the host's own
  action (`stores/images-conversation.ts`), answer the frame, then show the
  conversation (closing the phone panel); they alone append the `.codenomad/design/`
  exclusion. `status` never writes. For a found conversation it adds its last update
  (`lastUsed`), `imageCount` (its read-back images when the whole gallery fits the one
  page read, i.e. no further cursor; otherwise `null`, never a partial total) and
  `gitExclusion` from a read-only check (`checkDesignFolderExclusion`): the execution
  host's Git resolves the exclude file as for the append, and its lines, compared as Git
  reads them, give `excluded` or `missing`; `not-repository` and `unavailable` as for
  the append.
- **Preferences**: one plain JSON object per installed record, replaced whole, at most
  4 KiB serialized; written through the store's queue and atomic write without a
  catalogue change event. Disabling keeps them; replacement and removal drop them. Only
  the enabled exact package declaring the permission reads or writes them; a corrupt
  store, another digest or a missing package answers `unavailable`, never rewriting the
  file. An invalid stored entry alone reads `{}`. Panels keep only their own display
  settings there; never treat preferences as a security boundary.
- **Channel** (`api4-channel.ts`): one dispatcher per mounting. Frame-supplied capability
  and method names select only own entries of `Map`s; never index an object with frame
  data (inherited names such as `constructor` would run). Inputs are validated per
  method, and deferred host actions are host functions only (`typeof after === "function"`). The bridge refuses a
  fifth pending request and the host refuses one too, so the cap holds for any sender on
  the port. Each request is answered or failed within 19.5 s (the bridge's own limit is
  20 s), its fetch aborted so the route cancels the plugin call. Results after unmount, a
  session change or the deadline are dropped. Host actions that remove the frame
  (showing the conversation, closing the phone panel) run one task after the answer is
  posted, so the frame handles its answer first; showing the conversation then selects
  it only if the mount's conversation is still the selected one after hydration (a
  conversation the user picks meanwhile wins; the phone panel still closes).
- **Server routes** settle on their 19 s deadline or the caller's departure even while a
  read still waits: the answer races the abort, and the signal reaches every daemon read
  the route makes (each also bounded to 8 s), image settings included. The conversation
  helper (`resolveImagesConversationAt`) unwinds on abort too, so its worktree-deletion
  fence is released at once. Each read registers a fence; after the last
  read the route re-reads the session (same Location, still owned) or the Location's
  ownership, then the extension's consent, then asserts every connection it read through
  as current, synchronously, before answering. Any change fails the request.

Prompts reach the frame only with their separate permission; an approved author can
exfiltrate them like API 2 bytes, which the install sentence and the help state.

### Draft integration reads

`bundles.openDocs({ integration })` implements the catalogue's documentation action
under the unpublished `bundles.read` permission. Its strict input accepts only the
integration ID; its public result is `{ outcome: "requested" | "unavailable" | "busy" | "invalid" }`.
The authenticated parent owns the stream, mount, digest and exact conversation.
The backend revalidates consent, session/Location ownership and connection before
and after resolving the existing catalogue, including valid stale entries.
Only the parent receives the validated URL and rechecks its live mount before handoff.
`requested` means handed to the existing external opener; browser popup policies
may prevent display. Explicit opener failure answers `unavailable`, with no retry.
Malformed input or an unknown ID answers `invalid`; unavailable/unsafe catalogue
documentation answers `unavailable`. Shared read admission, four pending requests
and the 19.5-second deadline apply. One window-wide opening slot and a one-second
dispatch interval survive every remount; pending opener completion retains the slot.

The opening policy parses the original raw URL and requires exact equality with
`https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/<integration-id>`.
Only the implicit HTTPS port is canonical. Never accept credentials, alternate
hosts/ports, encodings, normalization, queries, fragments or arbitrary repository
paths; never fetch documentation, probe redirects or synthesize fallback URLs.
The same raw policy guards backend and parent; native adapters check the resulting
destination. Remote Tauri navigation admits this exact repository path family
through its owned external-navigation policy, keeping remote IPC unchanged.
Read-only mounts carry revocable read consent; each management entry/control
requires its separately captured management grant, including trusted reload.
The parent-only `POST /api/panel-extensions/:id/bundles/openDocs` takes
`{ owner, mountID, integration }` and returns `{ outcome: "ready", url }` or a
fixed refusal outcome. The parent validates and consumes that private response;
the frame receives only its final public outcome. Remote Tauri opener failure
shows the canonical destination in an OS dialog for manual opening.
Method requests convey documentation intent; never claim verified clicks or grant
direct detach authority through this method.

`bundles.read` defines `codenomad.bundles` through the API 4 MessageChannel.
The read surface consists of `catalog()`, `state()`, `hosts({ integration })`,
`openDocs({ integration })` and `onChanged(listener)`. Declaring `bundles.manage` also defines the five fixed management methods above on the frozen object.
Installation shows both permissions' full consent sentences when declared. Management
covers requests to install, update, remove, enable or disable a catalogue integration, install its
application component and attach an application to the displayed conversation; each
action has its own CodeNomad confirmation. Each manifest permission is unique and belongs
to the finite set; APIs 1 to 3 retain their exact tuples.

Management inputs use the backend's strict discriminated schemas. ACKs are
`{ outcome: "confirming", requestID }`, `{ outcome: "busy" }` or `{ outcome: "invalid" }`.
Admission uses the existing in-memory catalogue snapshot: unknown integrations and
native Project-scoped requests/activation, including removal, answer `invalid` and count toward the shared budget.
This bridge-local Global restriction leaves exact native Project sources removable through Plugins.
The existing shared four-request cap and 19.5-second method deadline apply to the ACK;
the human wait continues independently. `api4-channel.ts` posts the ACK to the captured
port before its deferred host function sends `start` to the backend.
The parent `control:confirm` call consumes the plan before awaiting fresh admission reads.
Stale admission answers HTTP 409 and closes the plan with its single terminal event;
accepted admission answers `{ ok: true }` while native completion follows the private event lane.

`lib/bundles-private-events.ts` holds the authenticated SSE owner in parent memory and
routes each private event to its captured mount. Open, disconnect and explicit stream
close invalidate ownership. `ExtensionPanel` creates a backend mount after authenticating
its one-use frame handshake and renders `BundlesConfirmationView` as a trusted sibling.
Disposal, navigation and native disconnect revoke management and close its modal.
The existing right-panel toolbar offers **Reload extension** for the active managing
extension; only its trusted click invokes `userRemount`. Automatic mounting preserves
rate/cancellation history and never replays actions.

Removal preparation accepts a valid fresh or stale catalogue and resolves exactly one
recognised writable declaration in the requested scope's preferred write target. Missing,
ambiguous, multiple, inherited or non-target sources are refused; never select the first
candidate. The scope, path, source, entry index and HMAC `expectedRevision` come from the
same `PluginControls.read` before confirmation. The plan also binds the full document and
source options, physical destination, mode and authenticated connection. Confirmation
revalidates that capture and calls the shared `PluginSources.remove` with genuine mutation
authority. Removal performs no integration status, binding, session census, detach or Q8
IO and leaves package cache, application/user files, activation rules and other declarations intact.

The trusted removal dialog reuses
`instanceServiceStatus.plugins.sources.removeWarning`, `removeGlobalWarning` and
`removeRecovery`: availability and connections may be interrupted, Global may affect
other projects and conversations, and recovery may require reinstalling, reloading or
reattaching; interrupted operations may not resume. Its Cancel-first focus, 600-ms guard
and two-minute expiry follow the shared confirmation lifecycle.

The modal awaits the `displayed` response before starting its own 600-ms guard, keeps
Cancel initially focused and retains Kobalte's modal trap. On management invocation,
the document bridge privately captures the exact active HTMLElement. A confirming ACK
keys that reference by request ID in a bounded, expiring map; after modal close, the
parent sends only `bundles:focus` and that request ID. The same captured document then
restores that exact connected element. Owner, mount, plan, digest and native targets
stay parent/backend-side; only validated `BundlesChange` projections reach listeners.
`tests/browser/panel-extension-bundles-management.test.ts` exercises the actual panel,
bridge, MessagePort, authenticated SSE, Fastify routes, lifecycle and native service
adapters, with exact iframe-button focus assertions and deterministic native-client IO.

The dedicated strict schemas in `panel-extensions/bundles-contract.ts` bound inputs
and projected outputs on both sides of the trusted HTTP adapter. Only these fixed
routes serve the reads: `POST /api/panel-extensions/:id/bundles/catalog`,
`POST /api/panel-extensions/:id/bundles/state` and
`POST /api/panel-extensions/:id/bundles/hosts`.
The mounted host supplies the instance, installed digest and captured session;
the frame supplies only the integration ID for `hosts`. Before and after IO, the
server verifies enabled exact-digest consent, the exact native session in its
canonical Location, workspace ownership and the pinned connection's current identity.
Navigation, session movement/deletion, disconnect and unmount fence late results.

```js
const catalog = await codenomad.bundles.catalog()
// { state, fetchedAt?, integrations: [{ id, displayName, family, summary, app, docs, catalogStatus }] }
const state = await codenomad.bundles.state()
// { catalog: { state, fetchedAt? }, integrations: [{ id, family, configured, scopes,
//   activation: { global, project, effective }, plugin?: { declared, runtime, progress? }, version?, outdated?, state, status?, attachment? }] }
const hosts = await codenomad.bundles.hosts({ integration: "blender" })
// { offers: [{ offerID, label, document?, appVersion?, protocol }] }
const stop = codenomad.bundles.onChanged(({ kind }) => { /* kind: "state"; re-read on demand */ })
```

Catalogue state is `fresh`, `stale` or `unavailable`; `fetchedAt` belongs to the
last valid catalogue. State reads use the integration read model's available
runtime states. Each `status` contains only `version`, safe host fields
(`state`, `partVersion`, `expectedRange`, `appVersion`, `action`), the family-specific
connection projection and `notices` restricted to `legacy_install`. A native
connection contains only `offers`; other families expose only `state`.
Attachment is solely the exact conversation's `bindingRead` projection:
`{ state: "attached", label }`, `{ state: "none" }` or `{ state: "unknown" }`.
Authoritative `none` comes from a conforming binding read; read failures give
`unknown`. Session metadata remains a display hint. Keep plugin sources/options,
RPC IDs, paths, credentials, binding authority, aggregate attachment state/counts
and foreign sessions outside these projections. Use only actual runtime states;
never synthesize `pending` without a local operation tracker.
The optional `plugin` facts separate recognized source declaration from native `active`, `failed`, `unloaded`
or ambiguously attributed `unknown` runtime. `activation.effective` describes activation; `state` describes RPC
availability/conformance. The parent-only tracker adds `pending` after both exact declaration and local native
submission are observed, for at most 120,000 ms from before confirmation transmission; otherwise declared/unloaded
entries use `unconfirmed`. Disabled and ambiguous entries carry no progress. Runtime/removal observation and
revocation/reload/stop consume the hint; late receipts cannot recreate it. Host HTTP state includes optional
private `tracking` correlation, and private confirmation views include an installation target; both are stripped
before MessagePort delivery. Older hosts may omit the additive plugin facts.

Reads share a sliding limit of 60 calls per extension per minute. The API 4 channel
allows four in flight, refuses the fifth with `busy` and settles within 19.5 s;
HTTP 429 becomes `busy`. Relevant integration/plugin/configuration and exact-session
events plus reconnects coalesce into `{ kind: "state" }` invalidations over 300 ms.
Readers refresh on demand and notifications; never poll. The integration contract
pin remains draft 0.2, spec 0, RPC contract 1, as recorded in
`opencode/integrations/vendor/VENDORED.json`.

### Internal integration confirmation lifecycle

`panel-extensions/bundles-lifecycle.ts` owns a backend/profile's in-memory confirmation
arbiter. All its mounts and windows share that instance and its `BundlesBudget`; the read
routes accept the same budget. Management routes bind the authenticated stream's owner to
the mounted exact package. Operation-specific preparation and dispatch use trusted in-process callbacks.

- `mount()` mints an opaque mount identity and combines mount disposal with the consent
  lease's abort signal. `PanelExtensionStore.captureReadAuthority()` authorizes the
  exact enabled digest and `bundles.read`, capturing its immutable management grant for
  management entries and controls. Installation, activation and removal revoke
  existing leases synchronously at write admission. Preferences preserve the lease.
- `request()` reserves the shared slot synchronously and returns an ACK and `afterAck`.
  ACKs are `{ outcome: "confirming", requestID }`, `{ outcome: "busy" }` or
  `{ outcome: "invalid" }`. The trusted renderer posts the ACK to the captured port
  before its deferred `start` control begins preparation. The human wait has its own lifetime; every
  API 4 channel request retains its 19.5-second deadline.
- The trusted builder supplies the server-derived instance, exact session/Location,
  connection, integration, scope, catalogue range and exact document digest. Its fresh
  `readTarget()` must re-read every binding. Plans copy those values, remain in memory,
  use separate cryptographic 128-bit request/plan IDs, expire in five minutes and are
  consumed synchronously before the first dispatch await. Confirmation uses the exact
  owner object and plan ID. Never deserialize a builder, authority or display payload
  from author data.
- `BundlesConfirmationView` uses Kobalte's modal focus trap and shared `.window-*`
  primitives, initially focuses Cancel, and displays the trusted action, integration,
  version, scope, conversation, document and execution-machine warning. Both the button
  and lifecycle handler enforce 600 ms from display. An unanswered view expires after
  two minutes. Its owner closes it on consent revocation or mount disposal.
- The callback receives genuine `NativeMutationAuthority`: asynchronous revalidation
  reads consent and the complete captured target, and synchronous assertions enforce
  live disposal/revocation/expiry at dispatch. The callback calls `submitted()` exactly
  at native transmission while retaining that authority across subsequent prerequisites.
  For removal, `confirmed` follows observed deletion of the captured source from the
  exact bound document. ACKs and runtime disappearance never settle removal success.
  A lost response or any post-dispatch failure emits the fixed uncertain `failed`
  result; re-read configuration and require a fresh explicit action, never automatic replay.
  For the other methods, `confirmed` means admitted transmission; actual state follows authoritative reads.
  A refusal emits `failed`. Cancellation and expiry have their own outcomes. Each accepted
  request emits one terminal event on its captured port, independently of 300-ms state
  invalidations. Submitted work requires reconciliation and fresh consent for a fresh action.
- Sliding budgets are 60 reads and 10 management attempts per extension per minute,
  independent of digest and mount. The channel and bridge keep their shared four-call cap.
  Three cancellations/expirations in 60 seconds trigger five minutes of management `busy`.
  `resetCutoffForUserRemount()` is reserved to a trusted explicit user-remount action;
  automatic mounts preserve strikes/cutoff and every remount preserves rate history.

The draft public transport returns `invalid` for `detach()`, whose opaque-frame
explicit-action boundary remains unqualified. The internal local detach builder remains
a trusted in-process entry point. `request({ action: "remove", ... })` uses the confirmed
exact-source removal adapter above.

Checks: `bundles-lifecycle.test.ts` exercises live store leases, target conflicts, expiry,
quota/cutoff boundaries and revocation across awaits. `tests/browser/bundles-confirmation.test.ts`
uses the actual Solid modal, document bridge, MessagePort and channel with a parent-only
admission driver: ACK ordering, 30-second human wait, guarded activation, terminal events,
state coalescing and disposed/revoked owners. Malformed and undeclared raw-management rejection stays covered
by `panel-extension-bundles.test.ts`.

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
node scripts/test-panel-extension-native.mjs # isolated Tauri: WebView2, WKWebView or WebKitGTK
node scripts/test-panel-extension-native.mjs --api2
node scripts/test-panel-extension-native.mjs --api3
node scripts/test-panel-extension-native.mjs --api4
node scripts/test-panel-extension-electron.mjs # real preload, createWindow webPreferences; Linux may add --no-sandbox
node --import tsx --test packages/server/src/forge/forge.test.ts packages/server/src/server/routes/panel-extension-work-items.test.ts
node --conditions=browser --import tsx --test packages/ui/src/components/panel-extensions/work-items-channel.test.ts
node --import tsx --test packages/ui/src/components/panel-extensions/image-bounds.test.ts
node --import tsx --test packages/server/src/panel-extensions/api4.test.ts packages/server/src/server/routes/panel-extension-api4.test.ts packages/server/src/remote-control/panel-extension-remote.test.ts
node --conditions=browser --import tsx --test packages/ui/src/components/panel-extensions/composer-prefill.test.ts packages/ui/src/components/panel-extensions/api4-messages.test.ts
node scripts/run-session-pruning-native.mjs /absolute/path/to/opencode # isolated CLI/config/database
# from packages/ui:
node --import tsx --test tests/browser/panel-extensions.test.ts
node --import tsx --test tests/browser/panel-extension-api4.test.ts # real composer beside the real panel
```

Server checks cover format/permission/API validation, ZIP bounds/path attacks,
durable general activation, conservative legacy consent, replacement revocation,
concurrent changes and corrupt-state preservation. Catalogue checks cover SSRF/redirect/budget rejection, manifest/hash
verification, metadata-only discovery and withdrawn selections after warm reads.
Rendered tests use the real right panel, installer, routes and event dispatcher
for online browse/search/consent, offline fallback, incompatibility and lifecycle.
The native runners share `scripts/panel-extension-native-probe.mjs`: the frame is
built from `PANEL_EXTENSION_SANDBOX` and `panelExtensionDocument` (the real panel
must use that constant as its only sandbox), and must report `self.origin === "null"`,
an unreachable `parent.document`, no native line besides the host's positive
control, no request to the loopback leak counter (fetch, XHR, beacons, sockets,
event streams, workers, images, scripts, styles, fonts, media, frames, objects,
forms, popups) and exactly one port answer per declared method. Each run also hosts
the same frame with `allow-same-origin` added and with the CSP meta removed, and
fails unless the probe detects both.

The macOS (WKWebView) and Linux (WebKitGTK) runs are manual, on the macOS and
Ubuntu test VMs, after each change to the frame document, bridge, panel iframe or
desktop hosts. Each host needs a checkout of the change with `npm ci` (Electron's
binary included), Node 22, Rust's `cargo` on `PATH` and Tauri 2's platform
prerequisites (Xcode Command Line Tools; WebKitGTK 4.1 and libsoup 3 development
packages). Both webviews need the desktop session of a logged-in user:

- **Ubuntu (GNOME Wayland)**: with the user logged in at the console, a shell over
  SSH reaches that session by exporting
  `WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus XDG_SESSION_TYPE=wayland`,
  then runs `node scripts/test-panel-extension-native.mjs` with no option and with
  `--api2`, `--api3` and `--api4`, and `node scripts/test-panel-extension-electron.mjs`.
  Electron's OS sandbox needs `node_modules/electron/dist/chrome-sandbox` owned by
  root with mode 4755; otherwise Electron refuses to start, and
  `--no-sandbox` runs the probe without that OS layer.
- **macOS**: log in to the desktop at the VM console (after resuming, correct the
  clock with `sudo sntp -sS time.apple.com`), open Terminal in that session, and run
  the same five commands. Over SSH without a desktop login the WKWebView host
  never loads its page and the runner fails on its 60-second limit.

A run counts only when every command prints its summary and exits 0; record the
host, OS version and each summary's `real` line in the review.

## Agent conventions

- Right-panel customization keeps Extensions below a separator in a native disclosure, collapsed on each popup opening. Expanding mounts one compact searchable list combining installed and online addons, deduplicated by ID; collapse, dismissal and inactive/instance changes dispose its requests and confirmations; never add separate list modes or a floating extension window. The per-addon checkbox above the disclosure is the sole activation control, including for disabled installed addons; never add a manager switch or a per-window visibility gate. Reset changes built-in layout only, never addon consent. Keep metadata on hover/focus and technical consent details folded; retain explicit trust and digest-bound replacement/removal. Installation and activation are profile-wide. Legacy folder grants never become general consent.
- External panel extensions use `components/panel-extensions/` and `styles/panels/panel-extensions.css`. The official online catalogue is in `NeuralNomadsAI/CodeNomad-Extensions`; metadata discovery never downloads author code. Inspect/install revalidate the exact index/manifest/digest and use bounded credential-free HTTPS GitHub release downloads, never client-provided URLs. Never import author JavaScript into the main renderer or expose native/OpenCode bridges. ZIPs contain only a manifest and a self-contained HTML panel; install/replacement revokes activation. API versions cover only the public `window.codenomad` contract; never make internal Solid modules or import paths part of it.
- Extension API 3 requires explicit `repository.workItems.read` consent. `work-items-channel.ts` takes only kind/query/page/number from addons; the project folder, remote, provider and credentials stay host-side in `server/src/forge/` (CLI sign-ins or anonymous REST on the public forges only, never stored tokens, never `--paginate`, never addon text inside forge query syntax, never anonymous requests to other hosts). Opening uses the server-built forge page through `openExternalUrl`, rate-limited; never open addon-supplied URLs. Each API version carries exactly its own capability.
- Extension API 4 is a finite permission set (`PANEL_EXTENSION_API4_PERMISSIONS` in `panel-extensions/contract.ts`): one permission = one capability, fixed methods, one install sentence in every locale and its own server-side check. Adding a permission means a new contract entry, schema case, bridge object, route and sentence together; never a registry, a pass-through method or an author-chosen session/Location. `api4-channel.ts` owns the 19.5 s deadline, four-request cap and mount/session fencing for every API 4 method; keep APIs 1 to 3 on their exact tuples and channels.
- Extension API 1 stays context-only; API 2 requires explicit `session.assets.read` consent. `assets-channel.ts` derives session authority from the current mounted host, never author selectors, and exposes only bounded asset pages/exact digest-bound embedded reads. Use the presence-owned history bundle's fixed `assets`/`assetRead` methods, never transcript stores, generic RPC, remote downloads or filesystem fallbacks. Recheck consent and Location ownership after IO; revoke old-port/session/reconnect results. Gallery HTML belongs in the independent catalogue repository; never add it to the application renderer.
