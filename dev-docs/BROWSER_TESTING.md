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
  from `packages/ui`. Without a runner the borrower process gets its own
  daemon child, which dies with it.
- CI: each matrix shard runs `node tests/browser/shard.mjs <index 1-based> 4`
  — one interleaved serial slice per runner, wall clock divided by four.

## The fixture daemon model

One canonical Vite server serves every borrowed fixture of a run, namespaced
under the fixture's name. `tests/browser/fixture-daemon/run.ts` spawns it as
a child of the runner (run.mjs, shard.mjs): the endpoint and its secret are
announced on stdout and handed to the test processes through the
environment; nothing is written to the filesystem, there is no discovery
directory and no adoption across runs. The runner stops the daemon with an
authenticated HTTP request when its slice ends — portable, the daemon runs
its own cleanup — and the daemon watches its owner's pid, so a runner killed
without cleanup never leaks one. A test file invoked outside a runner gets
the same treatment from `borrowFixture`: one daemon child for the process,
no warmup, gone when the process is.

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
  travel from spawner to borrower through the environment — no signals by
  pid, no files to trust, so the same code runs on every platform the suite
  runs on.

## Agent conventions

- A new browser test either borrows via `borrowFixture({ name, routes })` or
  joins `fixture-exemptions.ts` with a reason that matches reality (the
  checker's failure text is the review).
- Fixture names must stay free of route fragments: borrowed URLs are
  namespaced `/<name><route>` and tests derive sibling URLs by substitution.
- Tests that need stateful middleware (SSE feeds driven by the test, custom
  Vite transform hooks, configs that diverge from the canonical daemon
  config) keep their own server and live in the heavy tier.
