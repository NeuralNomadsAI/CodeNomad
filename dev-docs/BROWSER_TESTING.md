# Browser rendering regressions

The browser suite lives in `packages/ui/tests/browser/`. Every test file
borrows its fixture page from a runner-owned fixture daemon, or carries an
exemption with its own server — `packages/ui/tests/browser/fixture-exemptions.ts`
is the single map of who does which, and
`fixture-wiring.test.ts` enforces the split (borrow-or-exempt, owned-cache
and protected-shutdown rules for exempt servers, armed navigation budgets
for every Chromium launch).

## Commands

- Local, tiered: `npm run test:browser --workspace @codenomad/ui` runs
  `tests/browser/run.mjs` — one file at a time in both tiers by default (the
  Git fixtures rebuild one checkout-wide Monaco asset directory that is
  concurrently unsafe, and wide runs grow load-sensitive failures on slow
  machines), with the daemon serving the borrowed tier.
  `CODENOMAD_TIERED_LIGHT_WIDTH`/`CODENOMAD_TIERED_HEAVY_WIDTH` raise the
  widths for braver machines.
- One file: `xvfb-run -a node --import tsx --test tests/browser/<file>.test.ts`
  from `packages/ui` (without `xvfb-run -a` on Windows and macOS). Without a
  runner the borrower process gets its own daemon child, which follows it.
- CI: each matrix shard runs `node tests/browser/shard.mjs <index 1-based> 4`
  — one interleaved serial slice per runner, wall clock divided by four.

## The fixture daemon model

One canonical Vite server serves every borrowed fixture of a run, namespaced
under the fixture's name. `tests/browser/fixture-daemon/run.ts` spawns it as
a child of the runner (run.mjs, shard.mjs): the endpoint and its secret are
announced as one stdout line and handed to the test processes through the
environment; `daemon.log` records the endpoint without its secret, and there
is no discovery directory and no adoption across runs. The runner stops the
daemon with an authenticated HTTP request when its slice ends — portable, the
daemon runs its own cleanup — and fails the run when that cleanup fails or
has to be forced. The daemon also watches its owner's pid and cleans up after
an owner that ended without stopping it (on Windows it is spawned detached,
so the owner's exit does not end it first). Detached, it has no console, so
`fixture-daemon/hide-console-windows.mjs`, imported first, makes the console
programs it starts (Vite's `net use`) hide their windows; otherwise each would
open a visible console that takes the user's keyboard focus. A test file invoked outside a
runner gets the same treatment from `borrowFixture`: one daemon child for the
process, no warmup, stopping shortly after the process ends.

Edits made while a daemon is serving are an accepted blind spot: every run
binds a fresh daemon, so only a mid-run edit can be missed, and mid-run
edits are the developer's own signal to restart the run.

## Logs, cleanup and platform limits

- A daemon's `daemon.log` lives in `$(tmpdir())/codenomad-fixture-run-*`
  (runners) or `codenomad-fixture-standalone-*` (bare files) and outlives
  the daemon for post-mortem; CI uploads those directories as artifacts on
  shard failure. Per-server optimizer caches (`tests/browser/fixture-cache.ts`)
  land in `codenomad-browser-vite-*` directories and are disposed by
  protected shutdown. Never clear the checkout's shared cache to repair a
  fixture.
- The control plane is plain HTTP over loopback with endpoint secrets that
  travel from spawner to borrower through the environment, so the same code
  runs on every platform the suite runs on.

## Native fixtures

Native product fixtures (`scripts/test-*-native.mjs`) run an isolated OpenCode daemon through
`withProductRuntime` in `scripts/native-product-fixture.mjs`: a private home, profile, temp, XDG and npm tree,
an allowlisted environment (`fixtureEnvironment`) that every fixture-owned child also receives, and a loopback
synthetic provider.

- Package installs go to a loopback fake npm registry, `scripts/fixtures/fake-npm-registry.mjs`, passed as the
  `registry` option (`npm_config_registry`); it serves what a test publishes and answers 404 for every other name.
- The fake OpenCode integration, `scripts/fixtures/fake-integration/`, is an installable plugin package with the
  integration marker, the native RPC contract on an injectable clock, a marker-mismatch mode and a fake host with
  sentinel secrets; its Python driver runs the reference discovery client against the fixture's own service
  registration (`writeFixtureServiceRegistration`). [OpenCode integrations](OPENCODE_INTEGRATIONS.md#test-fixtures)
  describes their options and commands.

## Agent conventions

- A new browser test either borrows via `borrowFixture({ name, routes })` or
  joins `fixture-exemptions.ts` with a reason that matches reality (the
  checker's failure text is the review).
- Fixture names must stay free of route fragments: borrowed URLs are
  namespaced `/<name><route>` and tests derive sibling URLs by substitution.
- Tests that need stateful middleware (SSE feeds driven by the test, custom
  Vite transform hooks, configs that diverge from the canonical daemon
  config) keep their own server and live in the heavy tier.
- Before pointer/keyboard selection in a Monaco diff, wait for its computed
  diff decoration (`.line-insert` in the Git fixture), then locate the line.
  Plain model text can paint before the worker result inserts deleted-code view
  zones. `git-history.test.ts` holds a real worker reply and defers Monaco's
  repaint to exercise that geometry change with native pointer checks intact.
  Its main-world DOM readiness probe releases the reply and repaint; a direct
  native click instead receives the reply at pointer movement and releases
  repaint on pointer-up, keeping the stale geometry through mouse-down.
- Fixtures importing the production event transport serve `/api/events` with
  `text/event-stream`, including when native frames enter through the real
  dispatcher directly. Keep network-failure collectors strict for failed streams
  and unrelated cancelled requests.
- Shell fixtures share `tests/browser/panel-read-fixture.ts` to observe optional
  panel-extension list cancellations: the exact request identity, its owning
  aborted signal and its native `AbortError` receipt must agree. Drain pending
  classifications before asserting; retain raw failures alongside the classified
  cancellations. Same-URL network aborts and missing, unknown or reused identities
  remain failures. Hold a controller-owned read across a native SSE open to
  exercise supersession with the navigation ownership assertions intact.
- Fixtures consuming EventSource serve a persistent `text/event-stream` response
  and let the real connection close with its page. Never answer that path with
  the generic JSON fallback. Composer bootstrap awaits DOM readiness and its
  explicit rendered-fixture signal; stream headers are observed before navigation.
- A fixture entry with top-level asynchronous restoration exposes its ready signal
  after instance registration. Tests await that signal before connecting its native
  client: the document load event can precede module continuation, and a later
  `addInstance` publishes the fixture's initial client value.
- Fixture owners use `runWithDiagnosticCleanup` from allocation through bootstrap,
  test body and teardown, preserving the primary error and distinct observation and
  cleanup failures. Failed setup closes owned contexts before rejecting. Attachment
  failure snapshots and resource receipts stay in an owned TEMP directory; runner
  output uses fixed phase/category labels. Never print raw observer snapshots.
- Attachment diagnostics use `fixture-console.ts` before bootstrap: each native
  console notification carries its original arguments and a synchronous JSON copy
  with Error message/stack, document nonce and sequence. Callback and string init
  scripts explicitly compose the idempotent capture before application code.
  A single ordered Chromium CDP channel owns console previews, browser network
  logs, exceptions and context retirement. Completion follows native page closure,
  requires both target retirement receipts, detaches its observer and reconciles
  every received packet, context and message/copy association. Missing, duplicated,
  malformed or unserializable diagnostics fail closed, as do workers, OOPIFs and
  related application targets outside this fixture's coverage. Never substitute a
  silence delay, a string-only copy or Playwright event completion for these receipts.
  Playwright console events serve only as refusal/format witnesses; the test-only
  preview/error adapter follows the installed Playwright Chromium contract and its
  native text/type/cardinality regression must pass on dependency updates. Keep raw
  values and rejection details in owned private TEMP evidence; public assertions
  report fixed categories or sentinel names.
