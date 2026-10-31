# OpenCode integrations

An OpenCode integration connects OpenCode to an application (Blender, Gaffer, Microsoft 365...). Its public
specification lives in [NeuralNomadsAI/opencode-integrations](https://github.com/NeuralNomadsAI/opencode-integrations)
under `spec/`; CodeNomad consumes draft 0.1 of it. Each integration is one OpenCode plugin package that carries:

- a static marker under the `opencodeIntegration` key of its `package.json` (`spec`, `id`, `displayName`,
  `family`, `plugin`, `rpc`, and `host` for the `native` family or `vendor` for `vendor-mcp`);
- the RPC status contract 1 under its RPC ID `neuralnomads.<app>`: `status` and the payload-free event
  `status_changed` for every family; `installHost`, `hosts`, `attachHost`, `detachHost`, `advertise`, `withdraw`
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
- Inputs are strict. Outputs are reader schemas: they accept and drop unknown fields, and unknown `notices`.
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
origin only. The list is read within 1 MiB, the asset within 256 KiB (the transfer is cancelled past it), the whole
refresh within 10 s; the asset must be UTF-8 JSON within `integrationCatalogSchema`.

- Two reads within 30 s (`INTEGRATION_CATALOG_CACHE_MS`) share one remote request, whatever its outcome, and a
  refresh runs alone, so an older answer never replaces a newer one. Later list requests are conditional
  (`If-None-Match`); an unchanged release is not downloaded again.
- `fresh`: the last read succeeded. `stale`: it failed (unreachable, refused status, oversized, not JSON, outside the
  schema, no catalog release) and the last valid catalog is served with its `fetchedAt`. `unavailable`: no valid
  catalog is known, with an empty list. No catalog is bundled; the last valid one persists in
  `integrations-catalog.json` of CodeNomad's configuration folder. Failures are logged by reason only.

## Recognition and state

`opencode/integrations/recognition.ts` recognises a configured integration from the authoritative plugin snapshot
(`PluginControls.read`), enabled or not, without reading OpenCode's cache. A source is the catalog integration `X`
when its registry package (or the target of an `npm:` alias) is `X.package`, when the runtime loaded it as
`X.plugin`, or when its spec starts with a prefix of `X.sources.git`; an exact `-X.plugin` rule also designates it,
since `plugin.list` omits disabled plugins. A source that designates two integrations, or that loaded under another
plugin ID, is ambiguous.

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

The UI reads through `stores/integrations-store.ts` (`lib/integrations-api.ts`): demand reads; the instance's
`rpc.neuralnomads.<app>.status_changed`/`hosts_changed`, `plugin.updated` and `config.updated` events are
coalesced over 300 ms into one read per demanded Location, with one trailing follow-up while a read runs. Nothing
reads on a timer.

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
  `createFakeIntegrationRpc` adds `status`, `installHost` and the event relay; `sharedOfferRegistry` keeps one
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
  selection, 30 s cache, conditional list, refusals keeping the previous catalog, persistence, timeout),
  `recognition.test.ts` (three ways, ambiguity, every state, timeout and concurrency), `server/routes/integrations.test.ts`
  and `packages/ui/src/stores/integrations-store.test.ts` (event coalescing, no polling).
  `catalog-fixture.ts` builds conforming catalog entries and plugin snapshots.
- `node --import tsx scripts/test-integrations-recognition-native.mjs <absolute-cli>`: the fake integration loaded
  (`ok`), its marker-mismatch variant (`non-conforming`), a third disabled by its exact rule (`inactive`, recognised)
  and an absent entry, against a real daemon; only loaded integrations are called, under catalog RPC IDs; a
  Project add of a native integration and a second spec of a loaded one are refused without writing.
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
