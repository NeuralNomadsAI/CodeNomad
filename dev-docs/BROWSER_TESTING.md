# Browser rendering regressions

The browser suite lives in `packages/ui/tests/browser/`. Every test file
borrows its fixture page from the shared fixture daemon, or carries an
exemption with its own server — `packages/ui/tests/browser/fixture-exemptions.ts`
is the single map of who does which, and
`fixture-wiring.test.ts` enforces the split (borrow-or-exempt, owned-cache
and protected-shutdown rules for exempt servers, armed navigation budgets
for every Chromium launch).

## Commands

- Local, tiered: `npm run test:browser --workspace @codenomad/ui` runs
  `tests/browser/run.mjs` — borrowed fixtures three-wide against one
  invocation daemon, exempt fixtures serially (widths via
  `CODENOMAD_TIERED_LIGHT_WIDTH`/`CODENOMAD_TIERED_HEAVY_WIDTH`; the heavy
  tier defaults to one at a time because the Git fixtures rebuild one
  checkout-wide Monaco asset directory concurrently unsafe).
- One file: `xvfb-run -a node --import tsx --test tests/browser/<file>.test.ts`
  from `packages/ui`. Without a runner daemon the borrower gets a private
  daemon child that dies with it.
- CI: each matrix shard runs `node tests/browser/shard.mjs <index 1-based> 4`
  — one interleaved serial slice per runner, wall clock divided by four.

## The fixture daemon model

One canonical Vite server per invocation serves every borrowed fixture,
namespaced under the fixture's name. `tests/browser/fixture-daemon/orchestrate.ts`
owns the lifecycle for runners: a healthy daemon whose served source trees
have not changed since it started is adopted, a stale one is retired and
replaced, and a daemon the runner started is stopped when its slice ends.
`borrowFixture` never spawns or claims the shared discovery directory — it
attaches when a healthy daemon serves there and otherwise starts a private
daemon child in its own temporary directory, which follows its parent
process to the grave.

Staleness is keyed on source mtimes (`tests/browser/fixture-daemon/freshness.ts`):
the daemon refuses new registrations once any served tree is newer than its
start and retires itself, so a test can never pass against transforms of
code that no longer exists. Dependency installs and tsconfig edits are
accepted blind spots — every runner binds a fresh daemon per invocation, so
only an edit made while a daemon serves goes unnoticed.

## Discovery, cleanup and platform limits

- The shared discovery directory is `$(tmpdir())/codenomad-fixture-daemon-<ui-root-hash>`,
  mode `0700`: `ready` (atomic, `0600`, carries port/pid/secret/startedAt),
  `claim` (exclusive `0600`, names the owning pid) and `daemon.log` (kept
  after teardown for post-mortem). A starter waits for a live claim's owner
  and yields to it; it replaces a claim only once the owner pid is verifiably
  dead, and refuses a directory another local user owns.
- Private fallback daemons use `codenomad-fixture-private-*` directories and
  skip the startup warmup; the first fixture page pays the cold graph, like
  the old per-file owned servers.
- Per-server optimizer caches (`tests/browser/fixture-cache.ts`) land in
  `codenomad-browser-vite-*` directories and are disposed by protected
  shutdown. Never clear the checkout's shared cache to repair a fixture.
- Discovery, claiming and the HTTP control plane use only plain-Node
  primitives available on every platform the suite runs on; the one
  POSIX-only step, the discovery directory's uid ownership check, is
  skipped where `process.getuid` does not exist. If a daemon is wedged,
  delete its discovery directory — the next starter reclaims a dead claim by
  pid verification.

## Agent conventions

- A new browser test either borrows via `borrowFixture({ name, routes })` or
  joins `fixture-exemptions.ts` with a reason that matches reality (the
  checker's failure text is the review).
- Fixture names must stay free of route fragments: borrowed URLs are
  namespaced `/<name><route>` and tests derive sibling URLs by substitution.
- Tests that need stateful middleware (SSE feeds driven by the test, custom
  Vite transform hooks, configs that diverge from the canonical daemon
  config) keep their own server and live in the heavy tier.
