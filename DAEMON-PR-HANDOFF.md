# Shared Fixture Daemon — Follow-up PR Handoff

Branch: `feat/shared-fixture-daemon` (13 commits, reworked from the #1139 review).
Read with: PR #1139's review thread (pascalandr's P1 list) and the design doc in
this branch's history (`docs/superpowers/specs/2026-10-25-shared-fixture-server-design.md`,
later dropped from the tree per review — `git show` it from the earlier commits).

## Status

Everything builds and passed local validation when shelved: daemon core + borrow
helper + tiered runner + checker v2 + ~70 migrated files. The branch is based on
the pre-merge dev; **rebase onto current dev first** (upstream landed #1140/#1141
touching reveal/desktop-update tests we also touched).

## The P1 rework list (from review, with what we learned)

1. **Stale code across runs**: daemon outlives an invocation with `watch: null`
   → serves a stale module graph on the next local run. Rework to per-invocation
   lifecycle (the shard runner already starts/stops one per shard — make that the
   ONLY mode, or add staleness detection keyed on file mtimes).
2. **Off-Linux server leak**: migrated files drop the handle `borrowFixture`
   returns; the win32 fallback embeds a server per borrower. Either keep and
   close handles, or make the fallback a shared per-process server.
3. **SSE middleware lost** — the reviewer caught what we mis-triaged as product
   flake: `mission-native-family` and `mission-current-passage` had their
   `/api/events` middleware dropped by the codemod while assertions stayed.
   **Immediately exempt both files back to their own servers**; their "flaky"
   10/11 failures were this bug.
4. **Concurrent-start races + secret file perms**: claim directory is removed
   while its owner may still be starting; ready file/secret default perms.
   Claim should be pid+health verified before replacement; chmod 0600/0700.
5. **AGENTS.md optimizer wording**: the daemon's shared optimizer output vs the
   "never make parallel tests share mutable optimizer output" rule — one daemon
   process is a single-writer, but the rule text needs an explicit sanctioned
   shape amendment in the same PR.
6. Smaller: keep daemon.log on teardown, runner exit codes, diagnostics upload,
   wire `run.mjs` into package.json (or drop run.mjs until it earns its place).

## Hard-won lessons (do not relearn these)

- Playwright timeout precedence: `page.setDefaultTimeout` BEATS
  `context.setDefaultNavigationTimeout`. A tight page action default silently
  kills the armed navigation budget (fixed for reveal in #1139's merge).
- Direct `transformRequest` "warmup" cancels in-flight esbuild builds
  ("The build was canceled") — only browser-driven warmup settles Vite 5.
- Vite treats `port: 0` as "5173 + auto-increment", not ephemeral.
- DOM scroll stability ≠ app settle: the app registers scroll asynchronously;
  wait for `fixture.snapshot().scroll` to sync with the DOM, then a 5×100ms
  quiescence streak. Fixed waits race; weak conditions race too.
- `git checkout -- <dir>` during codemod iterations also reverts UNCOMMITTED
  unrelated work (we lost the checker v2 rewrite once). Commit stage results
  before iterating.
- `pgrep -f`/`pkill -f` patterns match your own shell's command line — use
  `daemon[.]mjs` bracket escapes.
- This dev machine (Xeon E5-2680 v2) is ~2× slower per-core than CI runners;
  local wall numbers are directional only, CI is authoritative.
- gh api to api.github.com from this environment has intermittent
  `198.18.0.45 i/o timeout`s — retry with backoff; job logs need
  `--allow-escape-sequences` or curl (escape-sequence refusal otherwise).

## Working setup

- Worktree: `/home/wan/.local/share/opencode/worktree/d508ce/browser-test-parallelism`
  (daemon branch checked out there; host-managed, use its tools to remove).
- Local validation: `xvfb-run -a node --import tsx --test tests/browser/<file>.test.ts`
  serially; full daemon-mode suite via `node tests/browser/run.mjs`.
- Reviewer preference (from #1139): narrow explicit timeouts over global
  budgets, cold navigation only for the armed budget, no process docs in-tree,
  exemption map reasons must match reality.
