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
`X.plugin`, or when its spec starts with a prefix of `X.sources.git`; an exact disabled `X.plugin` rule also designates it,
since `plugin.list` omits disabled plugins. A source that designates two integrations, or that loaded under another
plugin ID, is ambiguous. Native rules carry the normalized selector and `enabled: false`. An ID-less failed package
correlates only through one exact recognized source target; conflicting or multiple inventory candidates are ambiguous.

`GET /api/workspaces/:id/integrations?directory=[&workspaceID=]` (`server/routes/integrations.ts`,
`IntegrationsReader`) answers every catalog entry for an owned Location, without the catalog's `plugin`, `rpc`,
`sources` and `package`, with one `state` (`IntegrationRuntimeState`):

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

`IntegrationView.configuredSources` associates an integration with its writable plugin-source rows by `scope` and
`entryIndex` only. The source must belong to that scope's exact write target; inherited declarations stay read-only.

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
within the backend. Both `detached` and `none` remove the hint. Q8 is a display hint for a confirmed reattach to a
matching integration and label; the plugin's live bindings retain authority. Concurrent writers in other clients
share native whole-object replacement semantics.

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

The `bundles.manage` bridge requests removal of a catalogue integration through the
same `PluginSources.remove(workspaceId, request, authority?)` service. A valid fresh or
stale catalogue and exactly one unambiguous writable source are required. Its scope,
path, source, index and HMAC revision come from the same `PluginControls.read`; the
confirmation binds the full document/options, destination, mode and connection. Missing,
multiple, inherited or non-preferred-target declarations are refused. The bridge keeps
native integration removal Global-only; ordinary Plugins removal also supports exact
native Project sources. Each action has its own trusted confirmation and the shared
interruption/Global/recovery warnings. Success requires observing removal in the exact
bound document; a lost response or post-dispatch failure yields a fixed uncertain
`failed` event and requires a configuration read before any fresh explicit action.

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
machine, including a remote machine. Its outcome describes that request; application status and a separate explicit
attachment action establish application availability and conversation access. Never retry or replay an installation
request after an uncertain result: check the application, then require a fresh action and confirmation if needed.

### Internal mutation admission

`IntegrationAttachments.attach`, `detach` and `installHost` accept an optional final
trusted `NativeMutationAuthority` argument after `signal`. It is an in-process seam
for the trusted bundles adapter; existing native routes retain their ordinary call
contract. See [mutation authority](PLUGIN_CONTROLS.md#internal-mutation-authority)
for its asynchronous revalidation and synchronous live assertion requirements.
Never deserialize this argument from an HTTP body or frame message.

Authority is revalidated after session-queue waits and asynchronous ownership,
session and RPC prerequisites, and synchronously asserted immediately before each
mutation RPC and metadata update. Revalidation also precedes success. One action's
submission state covers both its binding RPC and hint write; a later failure is
`NativeMutationUncertainError`, including timeout, revocation, invalid native output
or a metadata failure after binding submission. A late response cannot authorize
further writes. Cancellation may release the existing session queue while submitted
native work still runs; callers must reconcile rather than replay. Authority-bearing
actions use a non-refreshing catalogue read; WSL host-install refusal precedes even
that read and installer dispatch.

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

The conversation header (wide and overflow layouts) and each associated Plugins row offer a trusted application
picker. The picker initially focuses Cancel, names its captured target conversation and the daemon machine, and
requires explicit selection and confirmation. Navigation discards the captured target; reconnect and relevant
native invalidations discard offers. Admitted action receipts remain readable for their unchanged target across
native echoes. WSL-unsupported status shows help.
Plugins shows an unavailable catalog or the last
valid catalog's fetch time. Saved Q8 hints offer confirmed reattachment only for matching integration and label.
Action receipts describe the completed request.

`createIntegrationBindingsStore` (`stores/integration-bindings-store.ts`) shares reads for the exact instance,
Location, session and native integration shown by the conversation header or its Plugins picker. The header keeps
the application name and safe binding label outside the action overflow at every width; labels use isolated text,
ellipsis and a full accessible title. An authoritative `none` renders no indicator, while `unknown` is explicit.
Only a fresh `attached` binding offers Detach, including in the picker. Q8 supplies matching confirmed-reattach
suggestions. Binding reads carry only the session selector and receive only the projected state/label.

The store uses the shared secondary HTTP budget. Relevant integration/plugin/configuration events and exact-session
updates, moves or deletions revoke authority immediately and coalesce reads over 300 ms, with one trailing follow-up.
Reconnect, native stream-open and renderer stream-open reconcile demanded bindings; disconnect revokes them.
Every read checks its demand identity and generation before publication. Errors publish `unknown`; releasing the last
demand aborts and drops its state. Attach and detach run once, then invalidate and reconcile their captured target
in `finally`, including uncertain outcomes, while navigation leaves reads scoped to the latest shown target.

The existing Plugins row menu also offers **Install application integration…** or **Update application integration…**
only for its exact `configuredSources` association and a fresh active native integration reporting
`host.action: "install" | "update"`. `components/integration-host-installation.ts` owns the trusted shared
confirmation: application name, integration package version and the OpenCode-machine warning, with Cancel initially
focused. The captured instance, Location, session-navigation identity, action, version and integration epoch fence
consent. Navigation, reconnects and relevant native invalidations cancel pending confirmation; dispatch rechecks the
captured identity. An admitted request runs once, and receipts use only the projected outcome or a localized fixed
error. Uncertain errors require checking the application before a fresh action. UI strings live in each locale's
`integrations.ts`, and public instructions in `docs/help/<locale>/integrations.md#application-installation`.

### Draft panel-extension reads

The API 4 `bundles.read` capability uses the existing catalogue, integration reader and attachment service
through three fixed routes in `server/routes/panel-extension-bundles.ts`:
`POST /api/panel-extensions/:id/bundles/catalog`, `bundles/state` and `bundles/hosts` under the same prefix.
The frame's MessageChannel API is `codenomad.bundles.catalog()`, `state()`, `hosts({ integration })`,
`openDocs({ integration })` and `onChanged(listener)`; the trusted host supplies the instance, exact installed digest and conversation
captured at mount. Dedicated strict input/output schemas live in `panel-extensions/bundles-contract.ts`.
Enabled `bundles.read` consent, exact native session/Location ownership and pinned connection identity are
checked before and after IO. Keep this adapter on the fixed service methods and catalogue-derived RPC IDs;
never accept an author-selected session, Location, RPC method, package spec or URL.

The catalogue projection is `{ state, fetchedAt?, integrations }`, with only
`id`, `displayName`, `family`, `summary`, `app`, `docs` and `catalogStatus` per integration.
State is `{ catalog: { state, fetchedAt? }, integrations }`; each integration carries only
`id`, `family`, `configured`, `scopes`, `activation: { global, project, effective }`, optional `version`/`outdated`,
the runtime `state`, optional `status` and exact-conversation `attachment`. Status projects only `version`,
host `state`/`partVersion`/`expectedRange`/`appVersion`/`action`, a family-specific connection and
`legacy_install` notices. Native connections expose only `offers`; other families expose only `state`.
`attachment` comes exclusively from `bindingRead` and projects `attached` with its safe label, `none` or
`unknown`. Keep aggregate binding state/counts, foreign sessions, Q8 authority, sources/options, RPC IDs,
paths, credentials, generations and revisions outside the extension payload. Runtime state comes from
the existing reader; never invent a `pending` state without a local operation tracker.
Hosts return `{ offers: [{ offerID, label, document?, appVersion?, protocol }] }` after full native validation
and safe-display projection.

The read budget is 60 calls per extension in a sliding minute, four in flight and a 19.5 s channel deadline;
the fifth in-flight call and HTTP 429 report `busy`. Integration/plugin/configuration and exact-session events
and reconnects coalesce over 300 ms into `{ kind: "state" }` notifications. Navigation, moves/deletion,
disconnect and unmount invalidate old reads; never poll. `bundles.manage` requires `bundles.read` in the
manifest. Its fixed `request` (install/update/remove), `setActive`, `installHost` and `attach`
methods use the shared trusted confirmation lifecycle through an owner-authenticated
mount. Request ACKs precede preparation. Removal's terminal `confirmed` follows
observed exact-document source removal; other methods' `confirmed` events denote
native submission, with actual state supplied by subsequent authoritative reads.
The development bridge returns `invalid` for detach. Direct local detach
awaits a trustworthy explicit-action boundary for an opaque frame.
See [Panel extensions](PANEL_EXTENSIONS.md#draft-integration-reads) for the boundary.
The trusted internal confirmation lifecycle and revocable store leases are described in
[Internal integration confirmation lifecycle](PANEL_EXTENSIONS.md#internal-integration-confirmation-lifecycle).
The vendored source remains `54d6e5d0f4c22e74d228822fcaaa0912818a8b46`, draft 0.2, spec 0, RPC contract 1.

`panel-extensions/bundles-actions.ts` derives package ranges, activation IDs and
native targets from the reviewed catalogue and current native inventory. Removal resolves
one exact writable source and its HMAC revision from the same plugin snapshot, without
status/binding/census/detach calls or Q8/cache/application-file cleanup. Plans bind
the exact write target and source declaration bytes/destination/mode, runtime
provenance, selected offer and installation action. Native operations require Global;
host installation requires an explicit inspected `absent/install` or versioned
`outdated/update` status. WSL preflight precedes catalogue/native preparation reads.
Expected self-authored configuration bytes and native update versions have narrow
post-submission normalization; all other consent, session, catalogue and target
checks remain live through subsequent metadata writes and success reconciliation.

The additive optional `plugin` object carries `declared` (a recognized configuration source) and
`runtime: active | failed | unloaded | unknown` (native inventory, with unknown attribution on ambiguity).
`configured`, `activation.effective` and RPC `state` retain their separate meanings. An activation rule or runtime
alone can establish `configured`; a missing version leaves known runtime loading unchanged.
The trusted renderer adds `progress: pending | unconfirmed` only to declared, unloaded, effectively enabled entries.
The shared Plugins source tracker reserves before transmission, requires actual declaration plus a submission
receipt, and bounds pending to 120,000 ms from that reservation. Late receipts retain the original start.
Runtime observation, observed removal, mount revocation/reload and instance stop consume hints permanently.
Reloaded or externally declared sources use unconfirmed. Expiry emits a local display invalidation; reads remain
demand/event-driven. Exact connection/document/source correlation stays in authenticated host HTTP/private SSE;
the public port strips directory, opaque targets and confirmation context. Older DTOs may omit `plugin`.
Private tracking includes complete configured-source token presence separately from catalogue mappings, so a
catalogue-only read preserves unrelated Plugins hints. Native Add pins connection/document context before sending;
the first source observation and all subsequent observations must retain it.
Catalogue documentation opens through the fixed unpublished API 4
`bundles.openDocs({ integration })` action under `bundles.read`. The authenticated
parent resolves only fresh or valid stale catalogue entries through the existing
source, with before/after consent, mount, session/Location and connection checks.
Its raw URL must exactly match the ID-bound HTTPS GitHub path
`/NeuralNomadsAI/opencode-integrations/tree/main/integrations/<integration-id>`;
only implicit port 443 is canonical, with no credentials, encoding, query or fragment.
Only the parent receives that URL and invokes the existing external opener.
Results are `requested`, `unavailable`, `busy` or `invalid`; `requested` describes
the handoff, subject to browser popup policy. Shared read limits and the API 4
deadline apply, with one window-wide opening and a persistent one-second interval.
See [the documentation action contract](PANEL_EXTENSIONS.md#draft-integration-reads).

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
  `catalog-fixture.ts` builds conforming catalog entries and plugin snapshots.
- `node --import tsx scripts/test-integrations-recognition-native.mjs <absolute-cli>`: the fake integration loaded
  (`ok`), its marker-mismatch variant (`non-conforming`), a third disabled by its exact rule (`inactive`, recognised)
  and absent and ID-less failed entries, against a real daemon; normalized activation and separate declaration/runtime
  facts are checked. Only loaded integrations are called, under catalog RPC IDs; a
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
- `packages/ui/tests/browser/integration-attachment.test.ts`: real Solid entry points and native dispatcher with
  all renderer logger namespaces enabled. Every console level's text and structured arguments, nested Error
  messages/stacks and page errors are captured before navigation and sentinel-scanned before teardown. Adversarial
  HTTP/JSON/transport failures exercise read, hosts, attach, detach, retry and late navigation.
  Binding qualification covers external authority, Q8/receipt separation, unknown versus none, wide/narrow durable
  labels with isolation/truncation/accessibility, strict projected-response bounds, moved sessions, late replies,
  expiry/revocation hints and native/renderer disconnects with pending trailing work.
  Installation qualification exercises the existing row's source association and fresh `host.action`, sessionless
  visibility, Cancel-first shared confirmation with machine/package-version text, preconsent navigation/event fences,
  all projected outcomes, unsupported WSL and uncertain errors without automatic replay.
- `node --import tsx scripts/test-integrations-attachments-native.mjs <absolute-cli> [pilot-checkout] [blender-executable]`:
  OpenCode 2.2.5 with actual Fastify attachment/read/SSE routes, native sessions and metadata, a loopback
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
  actual Fastify installation route and OpenCode 2.2.5 RPCs using the real built integration kit. Environment and
  kernel WSL detections run with and without authenticated validated offers; selected/backend WSL refuses before
  catalog or native RPC reads. Mirrored-offer kit refusals preserve every protected fixture file, including the
  preloaded catalog. A Linux positive control invokes exactly one installer callback and private sentinel write.
   HTTP, native events, raw SSE and debug/trace logs are sentinel-scanned; every child has a private fixture environment.
- `node --import tsx scripts/test-panel-extension-bundles-management-native.mjs <absolute-cli> [integration-checkout] [blender-executable]`:
  exercises actual authenticated owner SSE lanes, HTTP mount/ACK/start/confirmation,
  configuration writers, native package updates, installation and attachment with
  authoritative bindings/Q8. Private registry/runtime and optional immutable Blender
  kit resources stay fixture-owned. It checks stale plans, cancellation, revocation,
  concurrency, Project/WSL refusals, uncertain updates without replay and confidentiality
  across foreign streams, extension projections, metadata and structured diagnostics.
  Its final output names any native-platform or installer cases requiring separate qualification.
  `--installation-state` runs the bounded install/activation/update/read projection slice and its private exact-source
  correlation and sentinel checks, leaving full management attachment qualification to the complete command.
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
