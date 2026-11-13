# OpenCode integrations

An OpenCode integration connects OpenCode to an application (Blender, Gaffer, Microsoft 365...). Its public
specification lives in [NeuralNomadsAI/opencode-integrations](https://github.com/NeuralNomadsAI/opencode-integrations)
under `spec/`; CodeNomad consumes draft 0.2 of it. Each integration is one OpenCode plugin package that carries:

- a static marker under the `opencodeIntegration` key of its `package.json` (`spec`, `id`, `displayName`,
  `family`, `plugin`, `rpc`, and `host` for the `native` family or `vendor` for `vendor-mcp`);
- the RPC status contract 1 under its RPC ID `neuralnomads.<app>`: `status` and the payload-free event
  `status_changed` for every family; `installHost`, `hosts`, `attachHost`, `detachHost`, `bindingRead`, `advertise`, `withdraw`
  and `hosts_changed` for `native` integrations, whose application part announces itself to the plugin.

The three families are `native` (an authenticated loopback host inside the application, reached through
`<app>_context`/`<app>_apply` tools), `vendor-mcp` (a plugin that declares the editor's official MCP server) and
`api` (direct calls to a web API).

## Contract

- `packages/server/src/opencode/integrations/contract.ts` holds the zod schemas of the marker, the reviewed
  catalog and every RPC definition (`integrationRpcSchemas`, keyed `<method>.input`, `<method>.output` and
  `<event>.event` like `rpc.schema.json`), with the constants of the draft (spec 0, contract 1, 16 offers,
  256 KiB and 64 entries per catalog).
- Each schema accepts exactly what its JSON Schema accepts. `contract.test.ts` runs a corpus of valid and invalid
  samples, including the conformance package's cases, through both the zod schema and the vendored JSON Schema
  (Ajv, draft 2020-12) and fails on any disagreement or missing definition. Lengths count code points, as JSON
  Schema does.
- Inputs are strict. Outputs accept and drop unknown fields, and unknown `notices`, except `bindingRead`:
  its input and every output branch, authority and binding object are closed, with all patterns validated locally.
- `integrationCatalogDocumentSchema` is `catalog.schema.json` exactly; readers use `integrationCatalogSchema`,
  which also refuses two entries sharing an `id`, `package`, `plugin` or `rpc`.
- Shared types are exported from `packages/server/src/integration-types.ts`.

### Vendored specification

`packages/server/src/opencode/integrations/vendor/` holds `marker`, `catalog`, `rpc` and `host` `.schema.json` of
the pinned revision, and `VENDORED.json` records the repository, the revision and the Git blob ID of every
vendored file, including the reference Python discovery client used by the fixtures. The parity test checks each
file against its blob ID. To move the pin, copy the files of the new revision unchanged, update `revision` and the
blob IDs (`git rev-parse <revision>:<source>`), adapt `contract.ts` and extend the corpus with every new rule.

### OpenCode RPC definitions

Headless host discovery prepares each candidate Location through its payload-free
`status` RPC before `advertise` or `withdraw`. Only registration-unavailable status
reads repeat within the Location deadline; the mutation uses its remaining budget
and is sent once. Directory fallback belongs to preparation. The Python reference
and Blender host carry the same implementation; native fixture qualification checks
cold advertisement, attachment and withdrawal against the real runtime.

OpenCode imports RPC definitions through Effect's JSON Schema import, which refuses `pattern` ("Patterns may block
validation and are disabled"; OpenCode 2.2.5): a call whose declared output schema has a pattern fails with
`rpc.invalid_output`. Integration packages (spec/rpc-contract.md §4) register their definitions without
`pattern` and validate themselves every input whose definition loses a pattern, as well as the opaque `advertise`
and `withdraw` inputs. OpenCode therefore lets through outputs the specification forbids (a path as a document, a
malformed version or ID, a control character): CodeNomad reads every RPC output through
`readIntegrationRpcOutput(name, value)`, the full schema with its patterns and bounds. A non-conforming output is
an integration error (`{ ok: false, error: "non-conforming" }`), never trusted or partially used, and the refused
value is never echoed. `contract.test.ts` checks that every sample the pattern-free definitions accept but the
specification refuses is refused by the reader.

## Catalog

`opencode/integrations/catalog.ts` (`IntegrationCatalogSource`, one per backend, shared by every listener) reads the
reviewed catalog from `INTEGRATION_CATALOG_RELEASES_URL`, the only remote source: the GitHub release list of
`NeuralNomadsAI/opencode-integrations`, never its "latest" release. The newest published `catalog-v<n>` release
(highest `n`; drafts, prereleases and other tags ignored) gives the `catalog.json` asset, downloaded through the API
origin only. The list is read newest first, following `Link: rel="next"` on the API origin up to
`INTEGRATION_CATALOG_MAX_PAGES` (5) pages of 100 until a page holds a catalog release. Each page is read within
1 MiB, the asset within 256 KiB (the transfer is cancelled past it), the whole refresh within 10 s; the asset must be
UTF-8 JSON within `integrationCatalogSchema`.

- Two reads within 30 s (`INTEGRATION_CATALOG_CACHE_MS`) share one remote request, whatever its outcome, and a
  refresh runs alone, so an older answer never replaces a newer one. The first list page is requested with
  `If-None-Match`; an unchanged list reuses the selected release. The catalog is downloaded again only for a new
  revision: release tag, asset ID and asset update time (a re-uploaded asset is a new revision).
- Requests are unauthenticated (60 per hour per address, 304 answers included). A 403 or 429 rate-limit answer
  defers the next refresh to its `retry-after` or `x-ratelimit-reset` time (at most one hour), while the last valid
  catalog is served as `stale`.
- `fresh`: the last read succeeded. `stale`: it failed (unreachable, refused status, oversized, not JSON, outside the
  schema, no catalog release) and the last valid catalog is served with its `fetchedAt`. `unavailable`: no valid
  catalog is known, with an empty list. No catalog is bundled; the last valid one persists in
  `integrations-catalog.json` of CodeNomad's configuration folder. Failures are logged by reason only.

## Recognition and state

`opencode/integrations/recognition.ts` recognises a configured integration from the authoritative plugin snapshot
(`PluginControls.read`), enabled or not, without reading OpenCode's cache. A source is the catalog integration `X`
when its registry package (or the target of an `npm:` alias) is `X.package`, when the runtime loaded it as
`X.plugin`, or when its spec starts with a prefix of `X.sources.git`; a disabling rule for `X.plugin` (the snapshot
normalizes `-X.plugin` to `{ selector: X.plugin, enabled: false }`) also designates it, since `plugin.list` omits
disabled plugins. A package that failed before exporting its plugin ID is `X`'s runtime entry when exactly one
recognised source has its exact package target. A source that designates two integrations, one that loaded under
another plugin ID, a failure shared by several sources, or two runtime candidates make the integration ambiguous:
it keeps its recognition ways, but neither those shared or foreign sources nor a runtime entry are attributed to it
(no `plugin` fact, `configuredSources` or version from them), and no RPC is called.

`GET /api/workspaces/:id/integrations?directory=[&workspaceID=]` (`server/routes/integrations.ts`,
`IntegrationsReader`) answers every catalog entry for an owned Location, without the catalog's `rpc`,
`sources` and `package`. `docs` is present only when `isIntegrationDocsUrl` (`opencode/integrations/docs-url.ts`)
accepts it: the raw canonical `https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/<id>`
or `…/blob/main/integrations/<id>/plugin/README.md` of the same ID. Each entry carries the installation facts
`plugin: { declared, runtime? }` (`declared`: at least one recognised source; `runtime`: `loaded` or `failed` from
the native inventory, absent otherwise; a retained `id`/`-id` rule alone sets neither), `ambiguous: true` for an
ambiguous recognition (distinct from a marker mismatch, which keeps its attribution), and one `state`
(`IntegrationRuntimeState`):

- `absent` (not configured), `inactive` (configured, not loaded: disabled or not installed yet), `failed`;
- for a loaded one, the fixed `status` method under the catalog's RPC ID, at most 4 calls in flight and 8 s each
  (`INTEGRATION_STATUS_*`): `unsupported` (`rpc.unavailable`, `rpc.method_not_found`), `unknown` (timeout or
  another failure; the route still answers), `non-conforming` (ambiguous source, `rpc.invalid_output`, an output
  `readIntegrationRpcOutput` refuses, a marker mismatch, meaning another integration `id` or `family`, or a
  path-like `appVersion`: separator, drive letter or `~`, `looksLikePath`), or `ok` with the projected
  `host`, `connection` and `notices`.

The query is strict, so a client never names an RPC ID or method. Ownership is checked by the plugin snapshot read,
then again with `assertCurrent` after the calls (403, or 503 for a replaced connection).

Adding a plugin source (`opencode/plugin-sources.ts`) uses the same catalog: a recognised `native` integration is
refused in Project (`global-only`, D18), and specs of one recognised integration, or of one whose plugin already
loaded, are duplicates whatever their form (registry or Git). With the catalog unavailable nothing is recognised.

`IntegrationView.configuredSources` and `configuredRules` associate an integration with writable rows by `scope`,
`entryIndex` and the existing opaque document `expectedRevision`. The UI correlates only matching nonempty revisions
and rows whose path belongs to that scope's exact write target. Independent display responses can therefore arrive
in either order safely: a mismatch leaves correlated actions unavailable until reconciliation. Inherited and inline
declarations retain their read-only state. Correlation lives in `lib/integration-rows.ts`.

### Installation by catalog ID

`POST /api/workspaces/:id/integrations/:integrationId/install?directory=` (`server/routes/integration-install.ts`,
`IntegrationInstaller` in `opencode/integrations/install.ts`) takes the strict body `{ scope: "global" | "project" }`
and the strict query `{ directory }`; any other field is 400. The server builds the spec `<package>@<range>` from
the current catalog (a valid `stale` one included) and writes it with `PluginSources.add` and its serialized queue,
without `expectedRevision`. It answers `{ scope, spec, reloadPending: true }` or `{ error, code }`:

- 503 `unavailable`: no valid catalog, no service connection, or a replaced connection; 503 `timeout`: the add
  deadline passed before any write;
- 404 `not-found`: an ID outside the catalog; 422 `global-only`: a `native` integration in Project;
- 409 `ambiguous`: an ambiguous recognition; 409 `duplicate`: a recognised declaration or runtime entry, or a
  duplicate found by `PluginSources.add` in either scope (its `conflict`/`duplicate` refusal), including a write the
  daemon has not reloaded yet; retained `id`/`-id` rules of an earlier removal never block;
- 409 `stale`: the configuration document changed during the write; 422 `refused`: the document layer refused the
  spec or the Location;
- 403 `forbidden`: a Location the workspace does not own, checked by the snapshot read before any catalog-derived
  answer.

Ownership and `assertCurrent` are checked before the write and again after it. Every code above means nothing was
written. A refusal after the write answers 503 `uncertain`: the client reconciles through a new read and never
replays the request. Logs carry only the fixed code: never the spec, a path or a native error.

`lib/integrations-api.ts` `installIntegration` sends the request once and checks the answer's shape.
`pluginSourcesStore.installIntegration` (`stores/plugin-sources.ts`) reserves the attempt before transmission and
shows its hint only once the server confirms the returned spec: that Plugins row is `pending` for
`PLUGIN_SOURCE_PENDING_TIMEOUT_MS` (120 s), then `unconfirmed`. A refused or lost answer leaves no hint. Either way it
invalidates the plugin snapshot and refreshes the demanded integrations reads. `installation(instance, location,
integration)` derives `active`/`failed` from `plugin.runtime`, otherwise the hint or `unconfirmed` for a declaration.

## Application attachment

`opencode/integrations/attachments.ts` owns the native attachment actions. The authenticated workspace routes in
`server/routes/integration-attachments.ts` expose:

- `GET /api/workspaces/:id/integrations/:integrationId/hosts?directory=` → `{ offers }`;
- `GET /api/workspaces/:id/integrations/:integrationId/binding?directory=&sessionID=` →
  `{ state: "attached", label } | { state: "none" } | { state: "unknown" }`;
- `POST /api/workspaces/:id/integrations/:integrationId/attach?directory=` with `{ offerID, sessionID }` →
  `{ outcome: "attached" | "busy" | "gone" | "refused" }`;
- `POST /api/workspaces/:id/integrations/:integrationId/detach?directory=` with `{ sessionID }` →
  `{ outcome: "detached" | "none" }`.

The query and bodies are strict. Native session IDs require the `ses` prefix before any native IO. The integration must be native, recognised unambiguously and active in the owned
Location's plugin snapshot. The server derives its RPC ID from the catalog and calls only the fixed methods
`status`, `hosts`, `attachHost`, `detachHost` and `bindingRead`. Hosts and attach check the status marker and refuse an
`unsupported` host. Detach remains usable when the application has gone. Every RPC output passes through
`readIntegrationRpcOutput`; display labels, document names and application versions also pass `looksLikePath`.
Unknown output fields are stripped except for `bindingRead`, whose extra fields invalidate the whole answer.
Failures expose only fixed codes, including in logs.

`IntegrationAttachments.bindingRead` calls the catalog's fixed method for the one exact native session, with
the same before/after session, Location, connection and ownership checks and global deadline as attachment actions.
It validates the full closed output, including required authority for `attached` and `none`, before projecting
only state and the safe display label. Generations, revision and offer ID remain backend-only. Only a conforming
authoritative `none` produces `none`; inactive or missing methods, errors, malformed outputs, missing sessions,
timeouts and superseded connections produce `unknown`. Ownership refusals may return 403, which display readers
must treat as `unknown`. A moved session is readable at its newly verified Location; its old Location is refused.
The read uses native `session.get` by exact ID; never read or write Q8 or enumerate sessions for binding authority.

`server/request-logging.ts` projects integration requests to fixed route templates at debug and trace levels.
Completion diagnostics keep the method, status and duration; the integration namespace uses a fixed fallback
for unmatched or malformed requests. Never log integration request paths, parameters, query/body values or raw
errors. Route warnings use fixed codes or numeric status. Other routes retain their existing diagnostics.

Before and after each session-scoped RPC and metadata write, native `session.get` must return the exact session in
the exact requested canonical Location. Another owned worktree still fails this equality check. Workspace
ownership and the pinned connection's `assertCurrent` are checked around IO and at dispatch; superseded work
fails closed. An action has one `INTEGRATION_ATTACHMENT_TIMEOUT_MS` (8 s) deadline, propagated to native reads and
mutations; expired continuations check cancellation before further dispatch. Reads and mutations have `no-store`.
Shared route types live in `integration-types.ts`.

After an `attached` outcome, the session's `metadata["codenomad.integrationAttachment"]` is exactly
`{ integration, label, attachedAt }`: catalog ID, offer's `label` for reattach matching and Unix milliseconds.
The server reads the session afresh immediately before native `session.update`, whose whole metadata object
replaces the stored object, retaining all unrelated keys from that read. Attach and detach serialize per session
within the backend. Both `detached` and `none` remove the hint. The plugin's live bindings retain authority. Concurrent writers in other
clients share native whole-object replacement semantics.

### Confirmed source removal

Every plugin uses `PluginSources.remove` and the shared configuration-document primitive. The native Plugins
surface warns of interrupted availability and connections, with an additional other-projects warning for Global,
then requires explicit scoped confirmation after 600 ms with Cancel initially focused. Pending consent expires
after 120 s and is revoked on navigation, invalidation or disconnect. The captured document revision binds full
declarations/options, content, native mode, destination and connection; changed authority requires a fresh selection
and confirmation ([source mutation contract](PLUGIN_CONTROLS.md#mutation-guarantees)).

Catalog availability, recognition, family and zero/nonzero/unknown binding counts leave ordinary exact-source
removal available. Removal performs zero integration status, binding, session census, detach, reattach or metadata
calls. Saved Q8 hints, application/host/user files, package cache, activation rules and other declarations remain.
Success describes the removed declaration; effective runtime/binding displays follow native reload and existing
events/reads. A response lost after submission leaves an uncertain outcome: reconcile the actual configuration,
then require a new explicit action if needed. Reinstallation may restore availability, with reload or reattachment
sometimes needed; interrupted operations retain their own completion state.

### Application installation

`POST /api/workspaces/:id/integrations/:integrationId/install-host?directory=` in
`server/routes/integration-attachments.ts` requires the strict body `{}` and returns only
`{ outcome: "installed" | "updated" | "unchanged" | "refused" | "failed" }`. `IntegrationAttachments.installHost`
uses the owned Location's fresh plugin snapshot to recognise one active native integration and derives its RPC ID
from the reviewed catalog. It validates `status`, then calls the fixed `installHost` method with
`{ target: "default" }`. Every output passes through `readIntegrationRpcOutput` in full, including optional detail,
before projecting the outcome; raw detail and native errors must never reach HTTP responses or logs. Installation
uses the pinned connection, ownership checks, cancellation and bounded deadline of the attachment service.
Its catalog read uses `read({ refresh: false })`: the catalog already loaded by the UI read demand or persisted
on disk, with network refresh and persistence excluded from installation authorization. An unavailable catalog
refuses recognition until the normal read surface has loaded it.

WSL is refused unconditionally with `unsupported` before catalog reads that can persist a refresh, installer RPCs
or installation writes. The refusal covers a selected WSL service distro and a Linux backend running inside WSL,
detected through `WSL_DISTRO_NAME` or the Microsoft kernel marker. Failure to establish the Linux kernel identity
fails closed. A mirrored compatible application offer must never bypass this check.

Installation is Location-scoped and works independently of sessions and offers. The installer acts on the OpenCode
machine, including a remote machine. Its outcome describes that request; application status establishes application availability, and the integration
attaches a conversation at its first use. Never retry or replay an installation
request after an uncertain result: check the application, then require a fresh action and confirmation if needed.

## UI read model

`createIntegrationsStore` (`stores/integrations-store.ts`, reading through `lib/integrations-api.ts`) is the read
model for UI surfaces that show integrations. `demand(instance, directory)` reads that Location until its release;
releasing its last demand aborts the read. A surface retains its demand across session navigation within the same
active Location. `applyEvent(instance, type)` takes the instance's native event types:
`rpc.neuralnomads.<app>.status_changed`/`hosts_changed`, `plugin.updated` and `config.updated` schedule one read of
the instance's demanded Locations 300 ms after the first of them, with one trailing follow-up while a read runs;
`refreshDemanded` re-reads after a reconnect and `clearInstance` forgets a stopped instance. It has no timer of its
own. `stores/integrations.ts` owns the production singleton and forwards `instance.event`, reconnect, stream-open
and workspace-stop notifications. The event relay projects only the two payload-free integration notifications,
retaining the native Location for ownership routing and dropping plugin-authored envelope fields.

Integrations are managed only from their row in **Status → Plugins** (`components/plugin-activation-controls.tsx`).
A row whose plugin ID or declared target correlates with an unambiguous catalog entry is that integration's single
row. `integrationDisplayPlugin` uses the writable `integrationPlugin` correlations or the projected `plugin.runtimeId`
of one exact native inventory entry. Inherited, virtual and runtime-only declarations retain their integration
display and native actions; source mutations keep their writable document/revision checks.

- its `displayName` and installed version (every package row shows its version beside the name);
- Global/Project switches in the accent colour of Yolo and the settings switches (`ACCENT_SWITCH_SX`,
  `var(--accent-primary)`): `PluginActivationSwitch`'s `integration` flag replaces the green variant that plain
  plugin and MCP rows keep. A native integration's Project switch is locked to Global;
- the name tooltip's first line reads **Integration: <plugin ID>** where a plain plugin's reads **Plugin: <ID>**;
- for a loaded native integration, a chain icon (`components/integration-row-indicators.tsx`) for the displayed
  conversation: linked with **Attached to: <label>**, broken with **No conversation attached** (also without a
  conversation of this Location), dimmed with **Attachment unknown** when the integration cannot tell. Its text is
  its accessible name and its keyboard-openable tooltip;
- a warning icon only when the application part is `absent`, `outdated` or `incompatible`
  (`lib/integration-row-state.ts`).

The row's menu (`components/plugin-row-actions.tsx`) is labelled by the connection state (open document count,
application closed, unsupported machine, or the other families' server/connection state) and lists **Install in
application…**/**Update application…** for a fresh `host.action`, **Detach the conversation** for an `attached`
binding, then the ordinary package check/update, removal per scope and refresh. Integrations attach a conversation
themselves at its first use; CodeNomad offers no attach control.

`createIntegrationBindingsStore` (`stores/integration-bindings-store.ts`) shares reads for the exact instance,
Location, displayed session and native integration of each shown row (`components/integration-row-binding.ts`).
Binding reads carry only the session selector and receive only the projected state/label. The store uses the
shared secondary HTTP budget. Relevant integration/plugin/configuration events (`status_changed`, `hosts_changed`)
and exact-session updates, moves or deletions revoke authority immediately and coalesce reads over 300 ms, with one
trailing follow-up. Reconnect, native stream-open and renderer stream-open reconcile demanded bindings; disconnect
revokes them. Explicit Plugins header or row refresh reconciles only demanded bindings of the displayed
instance/Location/conversation. Errors publish `unknown`; releasing the last demand aborts and drops its state. Detach sends one
`detach` request for the displayed conversation, then invalidates and reconciles its captured target in `finally`,
including uncertain outcomes, which show a fixed error toast and are never replayed.

`components/integration-host-installation.ts` owns the application part's trusted shared confirmation for a fresh
active native integration reporting `host.action: "install" | "update"`: application name, integration package
version and the OpenCode-machine warning, with Cancel initially focused. The captured instance, Location,
session-navigation identity, action, version and integration epoch fence consent. Navigation, reconnects and
relevant native invalidations cancel pending confirmation; dispatch rechecks the captured identity. An admitted
request runs once, and receipts use only the projected outcome or a localized fixed error.

The Plugins Add menu opens **Add an integration…**: the reviewed catalog's installable entries, family label,
summary Popover, Documentation, scope and Install. Native integrations lock scope to Global. Catalog availability
and the last valid fetch date appear here. Installation uses the shared guarded confirmation and
`pluginSourcesStore.installIntegration`, preserving its pending/reconciliation semantics. Activation and plugin
package updates use ordinary native mutations without confirmation. UI strings live in each locale's
`integrations.ts`, and public instructions in `docs/help/<locale>/integrations.md#integration-rows`.

## Test fixtures

- `scripts/fixtures/fake-npm-registry.mjs`: `startFakeNpmRegistry()` serves the tarballs passed to
  `publish(name, version, tarball)` (scoped names included, the last version as `latest`) and answers 404 for
  every other name. Its `url` is the `registry` option of `withProductRuntime`.
- `scripts/fixtures/fake-integration/core.mjs`: the native contract of a fake integration, dependency-free because
  it is copied into the package. `createOfferRegistry({ now, hello, newOfferID })` implements the offer rules of
  the handshake (hello checked against `host.schema.json`, 15 s lease renewed by the same announcement, replacement
  only after a new hello, 16 offers and one per offer key under concurrent announcements, validated
  `attachHost`/`detachHost` IDs, `busy`/`gone`/`refused` attachment, at most 10,000 bindings) on the injected clock;
  host part compatibility is derived for the fake's own range `^0.1.0` only, prereleases included.
  `createFakeIntegrationRpc` adds `status`, `installHost`, closed `bindingRead` with generations/revision and the event relay; `sharedOfferRegistry` keeps one
  real-clock registry per daemon process.
- `scripts/fixtures/fake-integration/index.mjs`: `writeFakeIntegrationPackage`/`packFakeIntegration` write or
  pack `@neuralnomads/opencode-<id>` (default `fixture`) with options `markerMismatch` (`status` reports
  `<id>-other`), `hostPart` (`absent` or installed) and `installOutcome`; `startFakeHost` is a loopback host whose
  token and script handle are the `FAKE_INTEGRATION_SENTINELS` (`leaky` puts its script handle in the document and
  its port in the application version, `helloOverride` rewrites its hello); `findSentinels`/`assertNoSentinels`
  scan any value for them.
- `scripts/fixtures/fake-integration/python-host.py` runs the vendored reference client (`Service.discover`, then
  `advertise_all` or `withdraw_all`) under an audit hook. It reports every written path, every opened or listed path
  outside the Python installation and the script folder, every name resolution and connection, and any child
  process, raw socket, `ctypes`, `shutil` or Windows registry use, which escapes the hook and fails the check.
  Metadata reads (`os.stat`, `os.path.exists`) raise no audit event; the fixture environment keeps the home, profile
  and XDG folders they resolve inside the fixture.
- `writeFixtureServiceRegistration(env, registration)` (`scripts/native-product-fixture.mjs`) writes the fixture
  daemon's `service.json` under the fixture's `XDG_STATE_HOME`; `withProductRuntime` passes its `env` to `run`.

Commands:

- `node --import tsx --test packages/server/src/opencode/integrations/contract.test.ts`
- `node --import tsx --test scripts/fixtures/fake-integration/fake-integration.test.mjs`
- `node --import tsx --test packages/server/src/opencode/integrations/catalog.test.ts` (local release server:
  selection, 30 s cache, conditional list, refusals keeping the previous catalog, persistence, re-uploaded asset,
  later pages, rate-limit wait, timeout),
  `recognition.test.ts` (three ways, ambiguity, every state, timeout and concurrency), `server/routes/integrations.test.ts`
  and `packages/ui/src/stores/integrations-store.test.ts` (event coalescing, no polling).
  `packages/ui/src/stores/integration-bindings-store.test.ts` checks shared exact-target demand, immediate authority
  revocation, generation fences, trailing reads, native/renderer disconnect suspension and captured mutation cleanup.
  `catalog-fixture.ts` builds conforming catalog entries and plugin snapshots; `catalog-pinned-fixture.ts` reads
  `fixtures/catalog-54d6e5d.json`, the published catalog of revision `54d6e5d`, checked against its Git blob ID.
- `node --import tsx --test packages/server/src/opencode/integrations/docs-url.test.ts
  packages/server/src/server/routes/integration-install.test.ts`: the documentation link check against the pinned
  catalog and URL attacks; installation through the real route, `PluginSources` and configuration documents on disk
  (every refusal code without writing, `stale` catalogs, the queue's duplicate in either scope, reinstall over retained
  rules, strict inputs, ownership and connection before and after the write, and captured logs free of paths and specs).
- `node --import tsx scripts/test-integrations-recognition-native.mjs <absolute-cli>`: the fake integration loaded
  (`ok`), its marker-mismatch variant (`non-conforming`), a third disabled by its exact rule (`inactive`, recognised)
  and an absent entry, against a real daemon; only loaded integrations are called, under catalog RPC IDs; a
  Project add of a native integration and a second spec of a loaded one are refused without writing.
- `node --import tsx --test packages/server/src/server/routes/integration-attachments.test.ts
  packages/server/src/opencode/plugin-sources.test.ts`: real route/service checks for strict inputs, ownership and
  connection changes, missing/moved sessions, full output validation, path refusal, sanitized failures, bounded
  calls and exact Q8 metadata preservation/removal. Source removal tests cover D25 independently of attachment authority.
  Binding qualification covers full closed output validation before projection, authoritative none versus unknown,
  strict query parsing, two sessions/Locations, moved sessions, exact native identity, cancellation and late replies.
  Installation qualification covers the strict empty body, catalog-derived fixed `installHost({ target: "default" })`,
  full output validation with outcome-only projection, sessionless calls and unconditional WSL refusal before catalog
  persistence or installer calls, including a mirrored compatible offer.
- `node --import tsx --test packages/server/src/server/__tests__/integration-request-logging.test.ts`: actual
  Fastify completion hooks and Pino capture at debug/trace, rejected/malformed paths, query/body values and keys,
  native error data, concurrent requests and error recovery, with positive ordinary-route diagnostics checks.
- `packages/ui/tests/browser/integration-plugin-row.test.ts` (fixture `fixtures/integration-plugin-row.tsx`, HTTP
  model `integration-plugin-row-model.ts`) renders the real right panel: one row per integration with its name,
  version, accent switches equal to the Yolo accent and tooltip kind; the chain icon across `hosts_changed`/`status_changed`,
  conversation changes and `unknown`; the attention icon per host state; the menu's connection line, guarded
  application installation, one-click detach with a lost answer read again and never replayed, removal; French
  and Hebrew labels; and the catalog window's install by ID and consent revocation.
  `packages/ui/src/lib/integration-row-state.test.ts` covers the link, attention and connection derivations.
- `node --import tsx scripts/test-integrations-attachments-native.mjs <absolute-cli> [pilot-checkout] [blender-executable]`:
  A supported OpenCode runtime (at or above the minimum) with actual Fastify attachment/read/SSE routes, native sessions and metadata, a loopback
  `IntegrationCatalogSource`, and the real relay feeding `createIntegrationsStore` through SSE. Checks a 60-second
  event-free demand and ten native plugin events inside 300 ms, strict inputs and cross-Location refusals. The
  Blender pilot extracts the immutable pin recorded in `VENDORED.json` from the supplied checkout read-only,
  verifies the RPC SHA-256 and builds the real plugin/kit inside the private fixture (esbuild, existing semver 7.8.5).
  Its add-on installer and `serve.py` run with factory startup, private home/temp/XDG/user resources, private copies
  of the executable's shipped `BLENDER_SYSTEM_*` resources, and an explicit fixture config directory/registration.
  Binding reads exercise external native attach/detach, two sessions/Locations, native move with old-Location
  refusal, and consent-off withdrawal against the pinned real kit. Sentinel scans cover
   HTTP, native and relayed events, SSE, metadata and fixture logs, including the production debug/trace completion
   logger and an adversarial opaque session ID.
  Every child uses the fixture environment. Manual AC-B4 has its own acceptance run.
- `node --import tsx scripts/test-integrations-host-install-native.mjs <absolute-cli> [integration-checkout]`:
  actual Fastify installation route and a supported OpenCode runtime's RPCs using the real built integration kit. Environment and
  kernel WSL detections run with and without authenticated validated offers; selected/backend WSL refuses before
  catalog or native RPC reads. Mirrored-offer kit refusals preserve every protected fixture file, including the
  preloaded catalog. A Linux positive control invokes exactly one installer callback and private sentinel write.
  HTTP, native events, raw SSE and debug/trace logs are sentinel-scanned; every child has a private fixture environment.
- `node --import tsx scripts/test-integration-fixtures-native.mjs <absolute-cli>`: installs the fake package and
  its marker-mismatch variant through the fake registry, checks every output against `contract.ts`, runs the
  Python client against the fixture's own registration (advertise, attach, detach, withdraw), checks that its
  audited accesses stay inside the fixture and reach only the fixture daemon and that it prints neither the host
  token nor the daemon password, then checks the daemon log for the sentinels. In CI it requires Python 3; a
  local run without Python 3 skips that part and says so.

## Agent conventions

- Never add integration types to `api-types.ts`; export them from `integration-types.ts`.
- Read every integration RPC output through `readIntegrationRpcOutput`; never use a raw `rpc.call` output, and
  report a non-conforming one as an integration error without its content.
- Keep `contract.ts` equal to the vendored JSON Schemas. A stricter server check (for example refusing
  path-like strings) belongs to the code that projects a status, never to the contract schemas.
- The RPC ID of an integration comes from the catalog on the server, never from a client.
- Read the catalog only through `IntegrationCatalogSource`; never add another remote URL, a bundled catalog or a
  timer that refreshes it. Integration displays read on demand and on events, never by polling.
- Never gate an integration call on `features.rpc`: OpenCode does not report it for plugins that register their RPC
  in `setup`. The native RPC error decides `unsupported`.
- Never expose or log a host port, token, `script_handle`, `binding_key` or `offer_key`; leak tests use
  `FAKE_INTEGRATION_SENTINELS` and the fake host's `leaky` mode.
- Every lease, expiry or rate window takes an injectable clock (`now`), so tests move time instead of waiting.
- A test whose fake host runs in its own process starts children asynchronously: a synchronous spawn blocks the
  host that must answer the plugin's hello.
- Python fixture children run `python -I -B` with the fixture environment, so they read neither the user's site
  packages nor environment and write no bytecode into the checkout.
