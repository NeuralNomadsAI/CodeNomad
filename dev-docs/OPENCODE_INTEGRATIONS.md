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
`rpc.invalid_output`. Integration packages register their definitions without `pattern` and validate their own
inputs; CodeNomad revalidates every output with `contract.ts`.

## Test fixtures

- `scripts/fixtures/fake-npm-registry.mjs`: `startFakeNpmRegistry()` serves the tarballs passed to
  `publish(name, version, tarball)` (scoped names included, the last version as `latest`) and answers 404 for
  every other name. Its `url` is the `registry` option of `withProductRuntime`.
- `scripts/fixtures/fake-integration/core.mjs`: the native contract of a fake integration, dependency-free because
  it is copied into the package. `createOfferRegistry({ now, hello, newOfferID })` implements the offer rules of
  the handshake (hello validation, 15 s lease renewed by the same announcement, replacement only after a new hello,
  16 offers, `busy`/`gone`/`refused` attachment) on the injected clock; `createFakeIntegrationRpc` adds `status`,
  `installHost` and the event relay; `sharedOfferRegistry` keeps one registry per daemon process.
- `scripts/fixtures/fake-integration/index.mjs`: `writeFakeIntegrationPackage`/`packFakeIntegration` write or
  pack `@neuralnomads/opencode-<id>` (default `fixture`) with options `markerMismatch` (`status` reports
  `<id>-other`), `hostPart` (`absent` or installed) and `installOutcome`; `startFakeHost` is a loopback host whose
  token and script handle are the `FAKE_INTEGRATION_SENTINELS` (`leaky` puts its script handle in the document and
  its port in the application version); `findSentinels`/`assertNoSentinels` scan any value for them.
- `scripts/fixtures/fake-integration/python-host.py` runs the vendored reference client (`Service.discover`, then
  `advertise_all` or `withdraw_all`) under an audit hook and reports every file and network access outside the
  Python installation.
- `writeFixtureServiceRegistration(env, registration)` (`scripts/native-product-fixture.mjs`) writes the fixture
  daemon's `service.json` under the fixture's `XDG_STATE_HOME`; `withProductRuntime` passes its `env` to `run`.

Commands:

- `node --import tsx --test packages/server/src/opencode/integrations/contract.test.ts`
- `node --import tsx --test scripts/fixtures/fake-integration/fake-integration.test.mjs`
- `node --import tsx scripts/test-integration-fixtures-native.mjs <absolute-cli>`: installs the fake package and
  its marker-mismatch variant through the fake registry, checks every output against `contract.ts`, runs the
  Python client against the fixture's own registration (advertise, attach, detach, withdraw) and proves that it
  reads, writes and reaches nothing outside the fixture, then checks the daemon log for the sentinels. In CI it
  requires Python 3.

## Agent conventions

- Never add integration types to `api-types.ts`; export them from `integration-types.ts`.
- Keep `contract.ts` equal to the vendored JSON Schemas. A stricter server check (for example refusing
  path-like strings) belongs to the code that projects a status, never to the contract schemas.
- The RPC ID of an integration comes from the catalog on the server, never from a client.
- Never expose or log a host port, token, `script_handle`, `binding_key` or `offer_key`; leak tests use
  `FAKE_INTEGRATION_SENTINELS` and the fake host's `leaky` mode.
- Every lease, expiry or rate window takes an injectable clock (`now`), so tests move time instead of waiting.
- A test whose fake host runs in its own process starts children asynchronously: a synchronous spawn blocks the
  host that must answer the plugin's hello.
- Python fixture children run `python -I -B` with the fixture environment, so they read neither the user's site
  packages nor environment and write no bytecode into the checkout.
