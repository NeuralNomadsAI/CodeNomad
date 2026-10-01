# Issue #824: HTTP preflight cancellation

## Scope and result

Baseline: `366830f6`; original red diagnostic retained in commit `1ece148c`.
This fixes **orphaned HTTP preflight observers**, not the original global freeze.
Initial implementation is in `issue-824-transport`; the seven paths are now
integrated uncommitted in `issue-824-performance`. No shared daemon, database,
profile, desktop restart or deployment is used.

When prompt/compact waits on a native ownership read, disconnecting the desktop
previously left that read active because disconnect tracking began only after
authorization. The original HTTP fixture failed for both operations while an
independent session answered in 12/3 ms. This shows a cancellation defect, not
proof that native compaction stalls that read in the user's environment.

## Small correction

- `server/request-admission.ts` observes request `aborted` and incomplete
  response `close` from the start of the instance proxy handler. It does not
  observe ordinary request `close`, which can mean a completely read POST body.
- `http-server.ts` propagates the signal to profile negotiation, session,
  project, PTY/Shell and supported location-ownership native reads. Waiting on
  shared acquisition or non-cancellable filesystem/inventory work races only
  this observer against cancellation; it neither cancels nor invalidates the
  shared service. Late continuations cannot advance admission.
- The scope is disposed on every return/error. Mutation fence acquisition and
  environment/native dispatch have abort guards. The existing 15-second
  environment deadline and two-second advisory Git-context deadline remain;
  there is no new timeout on prompts, compaction or execution.
- The existing forwarding scope installs its response-close handler before
  dispatch, without an asynchronous gap; the early scope remains until that
  handoff settles. `compatibility/proxy.ts` now refuses dispatch when its initial
  downstream check already found a disconnected response.
- No interrupt, replay or daemon cancellation is added. Disconnect after an
  accepted prompt/compact continues to abandon its HTTP response as before;
  an upstream operation already admitted can finish independently.
- `WorkspaceManager.ownsLocation` accepts an optional signal for its native
  location check. Existing directory and identity authorization is unchanged.

## Executed validation

Windows, Node 25.2.1, private ephemeral loopback listeners. The junction created
for the earlier diagnosis was removed with `cmd /c rmdir node_modules` (junction
only), followed by a clean `npm ci` in this worktree. The prior missing-dependency
typecheck was an installation-state limitation, not a demonstrated source defect.
`npm ci` reports 49 dependency vulnerabilities; no out-of-scope upgrade is made.

Commands:

```powershell
npm ci
npm run typecheck --workspace @neuralnomads/codenomad
node --unhandled-rejections=strict --import tsx --test packages/server/src/server/__tests__/instance-proxy-disconnect-diagnostic.test.ts packages/server/src/server/request-admission.test.ts packages/server/src/server/__tests__/instance-proxy.test.ts packages/server/src/server/__tests__/instance-proxy-legacy.test.ts packages/server/src/opencode/compatibility/proxy.test.ts
$env:TEMP='C:\Users\Admin\AppData\Local\Temp\opencode'
$env:TMP=$env:TEMP
node --unhandled-rejections=strict --import tsx --test "packages/server/src/**/*.test.ts"
git diff --check
```

- Server typecheck passes after clean installation.
- Focused run: **65/65 pass**, natural exit. Twelve real-HTTP regressions and
  three scope tests include actual Promise SDK HTTP cancellation for prompt and
  compact, independent-session response while a preflight is held, delayed
  connection/profile/ownership, pre-environment snapshot, environment write,
  no forwarding after abort, no connection invalidation/replay, admitted
  operation completion, deletion-fence release and listener disposal.
- Timing thresholds were removed from the independent-session assertion: it
  must finish while the first read is causally held. Descriptive final aggregate
  latencies are **22/12 ms**, not a performance guarantee.
- Entire server gate: **782 tests, 776 pass, 0 fail, 6 declared skips**, natural
  exit in ~34.7 s. Skips: four opt-in native WSL write tests and two POSIX file
  permission/symlink tests. This count includes the focused cases, not additional
  distinct coverage. Full log: `sh_0f8691e64001fwNIml1REbA1tC.out` in the harness's
  managed shell storage.
- No full desktop/UI build or native Linux-to-Windows qualification is claimed.

## Remaining limits

Shared service acquisition and shared inventory work may continue after one
observer leaves; cancelling those would harm other consumers. The local route
retires immediately and refuses any late mutation admission. A buffered request
body is parsed before the route handler; this patch does not change parser cost.

Next: independent review of cancellation/forwarding ownership, followed by
integration validation. Separately measure real compaction, native session-read
latency and Chromium HTTP/1 connection occupancy using a private runtime. This
patch alone does not establish or eliminate the reported application-wide freeze.

Touched oversized sources: `server/http-server.ts` ~2346 lines,
`workspaces/manager.ts` ~1240 lines. No unrelated size-driven refactor is made.

## Integration validation

Source: `d9598e42` on `fix/issue-824-transport`, including the original diagnostic
from `1ece148c`. Destination:
`D:\CodeNomad\.codenomad\worktrees\issue-824-performance` at baseline `366830f6`.
All seven paths were applied with the patch tool, without cherry-pick, commit or
push. The three modified production files matched the untouched destination
baseline before integration. All seven Git blob hashes then matched the source
commit exactly; only this report was subsequently extended with integration
evidence. No neighboring concurrent changes were rewritten.

Integrated paths:

- `packages/server/src/server/http-server.ts`
- `packages/server/src/workspaces/manager.ts`
- `packages/server/src/opencode/compatibility/proxy.ts`
- `packages/server/src/server/request-admission.ts`
- `packages/server/src/server/request-admission.test.ts`
- `packages/server/src/server/__tests__/instance-proxy-disconnect-diagnostic.test.ts`
- `dev-docs/issue-824-http-admission-fix.md`

The existing clean integration dependencies were reused without installation.
Executed from the destination, Windows / Node 25.2.1:

```powershell
node --unhandled-rejections=strict --import tsx --test packages/server/src/server/__tests__/instance-proxy-disconnect-diagnostic.test.ts packages/server/src/server/request-admission.test.ts
node --unhandled-rejections=strict --import tsx --test packages/server/src/server/__tests__/instance-proxy-disconnect-diagnostic.test.ts packages/server/src/server/request-admission.test.ts packages/server/src/server/__tests__/instance-proxy.test.ts packages/server/src/server/__tests__/instance-proxy-legacy.test.ts packages/server/src/opencode/compatibility/proxy.test.ts
npm run typecheck --workspace @neuralnomads/codenomad
git diff --check -- packages/server/src/server/http-server.ts packages/server/src/workspaces/manager.ts packages/server/src/opencode/compatibility/proxy.ts
```

Results: **15/15** scope/disconnect and **65/65** focused pass with natural exits;
server typecheck and scoped diff-check pass. The 15 cases are included in the
65-case run, not distinct extra coverage. Descriptive witness latencies are
12/9 ms in the first run and 10/9 ms in the focused run. No full integration
server gate was rerun here; the coordinator's fresh aggregate validation follows
the remaining integrations.

Guard verification: the outer entry checks abort before acquisition begins;
`wait()` checks again after each resolved boundary before the caller continues;
`clientForRequest()` checks before allocating shared-client work. Explicit guards
precede mutation-fence entry, environment write, fetch acquisition handoff and
forward dispatch. There is no asynchronous gap between the final forwarding
guard and installation of its close listener. Late shared completion is exercised
by held connection/profile/ownership/environment tests and cannot advance to a
later effect. Work already admitted to the upstream remains outside this local
observer's interruption authority.
