# OpenCode 2.0.11 alignment and qualification

Date: 2026-09-20. Published baseline: CodeNomad `dev` at `a1e929fd`.

## Decision and boundaries

Pin the server/UI `@opencode/client` and bundled `@opencode/plugin` to **2.0.11**
together. Treat 2.0.11 as the current qualification reference, independently of
the CLI selected by the user and the version of the already-running daemon.
Updating a dependency or CLI does not restart or replace that daemon.

Retain the existing connection-scoped compatibility seam and historical storage
acceptance. This increment does not raise the minimum runtime or retire an old
contract family. Those are explicit support-policy decisions for the post-beta
register (#696). Preserve authenticated discovery, generation fences, native
location authority/cursors, session/global Forms scope, separate Shell/PTY
resources, and the restrictive proxy allowlist.

## Published contract evidence

- Reference: <https://opencode.ai/v2/docs/build/client> and the published client
  declarations/generated paths, rather than V1 SDK examples or unpublished PRs.
- npm SHA-512 verification was performed for the downloaded 2.0.9/2.0.11 client
  and plugin packages and the isolated Windows x64 2.0.11 CLI.
- All 30 client declaration files are identical between 2.0.9 and 2.0.11.
  Among 60 plugin declarations, the observed change is `ToastOptions.sessionID`.
  This is static evidence only; acceptance below exercises the running daemon.
- The 2.0.4 to 2.0.11 update includes `server.info()`, hidden Forms fields,
  explicit step start timestamps, provider/model settings schema changes, and
  native reducer changes including reconciliation of unsettled tools.

## Implemented adaptations

1. **Service information:** canonical `server.info()` maps to the authenticated
   discovery result (`status`, `health`, or `info`). Discovery keeps its bounded
   status → health → info, 404-only sequence. No operation probes or retries a
   mutation. Older health responses retain normalized version/PID/URLs; absent
   `paths.tmp` is not invented from the backend's filesystem. No consumer uses
   that newer path on older runtimes.
2. **Step timing:** only when `session.step.started.data.started` is absent,
   normalize it from the native event's creation time, matching the old reducer.
   Preserve explicit start times (including zero) and durable event identity.
3. **Forms:** both session and provider-auth controls omit hidden inputs from the
   rendered/focusable UI. Shared answer construction preserves hidden protocol
   defaults and explicit values while omitting inactive conditional and external
   fields. An unset hidden boolean is not silently converted to false.
4. **Tool settlement:** after authoritative terminal-state reconciliation,
   an unsettled tool in the visible store triggers the existing fenced message
   loader. The new native reducer's private-cache refresh alone does not update
   CodeNomad's bounded transcript. Existing load epochs and mutation/location
   authority remain responsible for rejecting stale responses. Idle/status-idle
   events perform the same reconciliation if they supersede a pending terminal
   check; a newer execution still invalidates that check.
5. **Continuous qualification:** add 2.0.11 to the Windows runtime-contract CI
   matrix, including isolated environment and message-fork fixtures. Retain the
   existing earlier-version matrix and legacy-pruning checks.

Provider/model schemas come from the upgraded client. Current CodeNomad UI reads
native catalogs and supports authentication/model selection; it does not write
the removed `ProviderSettings` or legacy compaction-mode shape. A new settings
editor and per-account credential UX require their own feature acceptance.

## Native acceptance

All runs use an explicit CLI executable, synthetic sessions, private home/config
roots and fixture databases. No shared service, user database or real provider
was used. The unmodified baseline was exercised first with client/plugin 2.0.4;
the aligned branch was then exercised with client/plugin 2.0.11. The latter
runs use the repository's Node 24.20.0 on Windows x64.

| Client/plugin | Runtime | Result and scope |
| --- | --- | --- |
| 2.0.4 | 2.0.11 | Native proxy/pruning/location suite; automation discovery and heartbeat stability; per-send environment; forks pass |
| 2.0.11 | 2.0.11 | Native proxy/pruning/location suite, automation, environment and forks pass |
| 2.0.11 | 2.0.5 | Native proxy/pruning/location suite passes, covering the earlier modern contract |
| 2.0.11 | 2.0.3 | Native proxy/pruning/location suite with `--legacy-pruning` passes |
| 2.0.11 | beta-19271 | Native proxy/pruning/location suite with `--legacy-pruning` passes |

The combined proxy/pruning fixture covers native cursors, instructions, inbox
queue/steer/cancel, voice prompts, commands, session/background Shells, Forms,
permission replies and Yolo rejection, worktree families/rollback, inventory
cache invalidation, and event relay ordering with blocked recipients. Pruning
exercises active-claim refusal, idempotent retry, competing prompts, multiple
subscribers, next-model-payload checks, fork isolation, pre-compaction history,
bundle discovery, backend leases and daemon restart using fixture data only.

Automation additionally exercises connection-derived discovery despite a
backend environment mismatch, late discovery on Windows, heartbeat stability,
native target fences, independent leases, final close and reopening.

### Local code and rendering validation

- Server and UI TypeScript checks pass; production server build (including UI
  and both bundled plugins) passes.
- Focused compatibility/event-relay/shared-service suite: 62 tests pass.
- UI projection, authority, status/actions, pruning, Forms and auth suite:
  166 tests pass. After the gatekeeper race fix, 23 focused lifecycle/status
  tests pass, including the three additional deferred-terminal cases.
- Hidden Forms browser fixture: passes against the real session/provider
  components with the full stylesheet; checks non-rendering and reply payloads.
- Full server suite: 599 pass, 2 skip, one unrelated Windows spawn timeout
  assertion exceeds its 1-second wall-clock budget under parallel load.
  The unchanged spawn file passes all 21 tests when rerun alone.
- Gatekeeper review identified the idle-event race and a browser-condition CI
  placement error; both were fixed and re-reviewed with no remaining blockers.

### Related #723 history acceptance

Separately, published #723 at `5b988eca` was tested with its unchanged 2.0.4
dependencies and the isolated 2.0.11 daemon. Its full native fixture passed:

- 241-message counts/search/technical cleanup with batch retry receipts;
- 1,501-message outline, distant anchor windows, overlap and exact native
  payload/restore parity;
- the surrounding proxy/pruning/location suite described above.

This is evidence for that exact head, not acceptance of unpublished changes or
of a combined merge with this dependency update. Re-run the combined native
fixture after the branches converge.

## Reproduction

After installing the lockfile and selecting Node from `.node-version`:

```powershell
npm run build:pruning --workspace @neuralnomads/codenomad
npm run build:automation --workspace @neuralnomads/codenomad
# Explicit absolute CLI path; never service discovery against user storage.
$cli = 'C:/isolated-runtime/bin/opencode.exe'
node scripts/test-session-pruning-native.mjs $cli
node scripts/test-automation-native.mjs $cli
node scripts/test-session-environment-native.mjs $cli
node scripts/test-session-fork-native.mjs $cli
```

For the earlier supported identity family, run the pruning fixture also with
`--legacy-pruning`. Focused regressions include `compatibility/transport.test.ts`,
`stores/runtime-contract.test.ts` (browser condition), `lib/provider-auth.test.ts`
and rendered `tests/browser/hidden-forms.test.ts`.

## Remaining qualification boundaries

- Minimum supported runtime and removal of legacy wire translations remain
  distinct from imported-history/storage compatibility.
- WSL mounted-config late discovery and aliased/symlinked roots are not certified
  by these Windows-native runs. Neither are Linux/macOS native acceptance or an
  installed Electron/Tauri release smoke test.
- Native compaction/payload history is covered by the existing synthetic
  fixture; real-provider native compaction strategies and WebSocket fallback
  behavior need provider-specific acceptance.
- Code Mode child-call presentation, per-account management and optional `/btw`
  remain separate functional increments. No proposed upstream schema is treated
  as a released contract here.
