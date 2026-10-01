# Issue #824 — freeze investigation

Mission baseline: `366830f6` (`origin/dev`, 2026-10-01). Integration worktree:
`D:\CodeNomad\.codenomad\worktrees\issue-824-performance`, branch
`fix/issue-824-performance`. Confirmed corrections are integrated and independently
reviewed, but final acceptance is not green. On 2026-10-02 the user authorized
committing/pushing the mission changes and opening a draft PR to `dev` for review.
Publication does not imply acceptance, merge, installation, deployment or a shared
daemon restart.

## Scenarios and evidence policy

- Issue report: Electron Linux `0.20.0-dev-20260930-47f9e43e`, OpenCode 2.0.19,
  remote Windows backend over HTTP. Submitting a prompt often locks the UI;
  reopening the client and reconnecting to the same server/session does not help.
- Additional user report: native compaction makes the UI and other sessions
  unresponsive, despite earlier optimization work.
- Distinguish renderer CPU, HTTP connection occupancy, backend event-loop work,
  shared native/plugin work and provider waiting. Compaction and technical-content
  pruning are different operations.
- Use synthetic databases, loopback fixtures and separately launched native
  runtimes. Never test against the user's OpenCode database or mutate their
  sessions. A local fixture reproduction is not proof of the reporter's exact
  root cause or Linux/Electron qualification.

## Parallel investigations

1. Prior audit continuity and broader unaddressed performance risks.
2. Compaction events, transcript hydration and renderer responsiveness.
3. HTTP/SSE, prompt admission and shared backend responsiveness.
4. Coordinator: plugin history/index reads and event-loop fairness.

The previous audit's reports remain in the separate `audit-resume-integration`
worktree. Its changes must be checked against this baseline before reuse.

## Confirmed: structural-index batches monopolize their event loop

`packages/server/src/opencode/session-pruning/outline-index.ts` originally read
512 checkpoint headers synchronously with `.all()`, then projected assistant JSON
for 128 rows before yielding. A row count is not a time budget: tool output size
varies considerably, and SQLite evaluates nested assistant JSON synchronously.
The routine is invoked by the bundled plugin's `outline` RPC.

### Reproduction

`scripts/profile-outline-responsiveness.mts` creates only an in-memory SQLite
database. It runs the real structural-index reader with 512 assistant messages,
each holding one 1 MiB textual tool result. The heartbeat is a separate
`setImmediate` callback on the same loop. Its maximum observed gap includes
synchronous SQL/JS work and host scheduling, not remote-client paint latency.

```powershell
node --import tsx scripts/profile-outline-responsiveness.mts 512 1048576 --baseline
node --import tsx scripts/profile-outline-responsiveness.mts 512 1048576
```

`--baseline` bundles the exact pre-mission `366830f6` reader without replacing
working-tree files. Seeding and module compilation are outside the measured scan.
The stress corpus is deliberately large (~512 MiB of payload); this is not an
estimate of a typical session or the reporter's data size.

First baseline run: maximum gaps **542 / 522 / 720 ms**, total scans
1717 / 1969 / 2209 ms, six heartbeat turns each. A subsequent immutable-source
baseline run observed **615 / 755 / 712 ms**, totals 2066 / 2409 / 2273 ms.
Initial modified run: maximum gaps **13 / 14 / 14 ms**, totals
1829 / 2680 / 2225 ms, 199 / 262 / 224 turns. Windows, Node/SQLite; uncontrolled
concurrent host work. These observations demonstrate improved cooperation, not
reduced total CPU or an application frame-rate claim. No wall-clock CI threshold.

### Correction and regression contract

Iterate the same checkpoint headers and retain the exact digest/page protocol.
Yield during both header reads and JSON projection when the slice has consumed
8 ms or 128 rows, and check cancellation between rows. Preserve read snapshots,
ownership, staged-undo visibility, known checkpoints and response bounds.

`outline-responsiveness.test.ts` uses real SQLite with a view that charges a
deterministic simulated cost per payload access. It schedules an actual pending
event-loop cancellation in the header or projection phase. The original header
regression failed after **896 payload accesses** before cancellation could run.
Both new tests pass after the patch and assert the read transaction is released.
The existing nine navigation tests also pass; server typecheck passes.

A single SQLite step remains synchronous and cannot be interrupted by this
cooperative budget. This patch does not move native storage work to another
thread, reduce all JSON parsing, or establish that this defect alone causes #824.
Native plugin qualification and independent review are tracked separately.

## Confirmed: subscriber failures cross feature/connection boundaries

The prior audit found these defects, but both source blobs were unchanged in
`366830f6`. They were reproduced again against the current mission baseline.

- Browser `ServerEvents` dispatch stopped at the first throwing callback. A
  wildcard subscriber could prevent the real SSEManager and typed subscribers
  from receiving valid native events; open/status callback failures could prevent
  reconciliation or abort restart. Three browser regressions failed before the
  patch; all four (including normal FIFO/unsubscribe) pass after per-callback
  exception isolation. Faults are diagnosed and never replayed.
- `OpenCodeSharedService.invalidateAfterStream` invalidated the shared client in
  `finally`, including on subscriber-local abort, iterator return/throw or an
  already-aborted subscription. Four regressions failed with the real SDK and
  loopback HTTP/SSE source. All seven now pass: local lifetime changes leave the
  healthy source/client alone, whereas genuine upstream EOF/transport errors
  still invalidate the originating generation. Late cleanup cannot invalidate a
  replacement; obsolete iterators cannot publish queued events. The fourteen
  existing shared-service tests also pass.

Commands:

```powershell
node --import tsx --test packages/ui/tests/browser/event-subscriber-isolation.test.ts
node --import tsx --test packages/server/src/workspaces/subscriber-lifetime.test.ts packages/server/src/workspaces/opencode-service.test.ts
```

The complete private native fixture also passed on OpenCode 2.0.21 with the
production shared-service wrapper: abort/return/throw retain the same client,
relay shutdown leaves the independent subscriber usable, slow-recipient FIFO
remains correct, and proxy/history/navigation/pruning checks pass. Retained
fixture: `C:\Users\Admin\AppData\Local\Temp\opencode\codenomad-pruning-native-Atf4fG`.
The 48 adjacent relay/SSE/proxy/navigation unit tests pass as well. No user
daemon was stopped or restarted.

These are functional isolation fixes, not measured CPU speedups, and no
production callback failure from the reporter has been captured. They prevent
one feature/consumer's failure from disturbing unrelated consumers; they do not
isolate synchronous CPU-heavy callbacks into different threads.

Independent event-boundary review approved these corrections without a
functional blocker, but reproduced a diagnostic gap: a deferred Solid memo
failure can occur at the final shared-batch flush, after callback-level catches.
The transport then mislabeled it as invalid JSON. A small follow-up separates
JSON decoding from event dispatch in `event-source-handlers.ts`. Its new unit
and real-SSE/browser-derived-error tests failed before the patch; all nine focused
tests now pass. The same lot's native/typed handlers receive each event once,
and subsequent events continue. This does not isolate every reactive computation
or change shared batching. Final UI review will recheck it with compaction work.

Residual limits from `issue-824-event-review.md`: these diagnostics use the
existing `sse` debug logger (not enabled by default); a concurrent local abort and
physical source failure has not been deterministically reproduced. No speculative
connection-invalidation change or new logging pipeline is introduced for them.

## Confirmed: orphaned HTTP preflight observers

The real Fastify/loopback proxy reproduction in `issue-824-transport` held the
native session-ownership read for prompt and compact requests. Closing the HTTP
client did not cancel those reads: listeners were installed only after preflight.
An independent session still responded before the held reads were released.
This proves an orphaned-request defect, not a global server CPU freeze or why a
real native read stalls in the reporter's case.

The dedicated correction (`d9598e42`, following red diagnostic `1ece148c`)
installs per-request cancellation at entry, propagates it to supported reads,
retires the local observer of uncancellable shared work, and fences late
continuations before environment writes or forwarding. It never treats ordinary
POST body completion as disconnection, adds no new execution timeout and never
interrupts/replays an admitted native mutation. Twelve real HTTP tests and three
scope tests passed in the source worktree and again after integration, along with
65 adjacent proxy tests and server typecheck. Independent review accepts the patch;
see `issue-824-http-admission-fix.md`.

## Confirmed: HTTP password derivation blocks unrelated work

The prior audit's synchronous-scrypt concern was reproduced with real
Fastify/AuthManager/auth routes and a private v1 auth file. In five baseline runs,
a witness endpoint could not run until all eight invalid logins or four password
changes finished. The async-scrypt correction admits the witness while those
operations are pending. Descriptive five-process medians: login witness
**168.63 → 3.37 ms**, password-change witness **82.43 → 0.80 ms**. Timing is not
the CI assertion: the tests require witness progress before the burst completes.

Hash format/parameters and constant-time comparison are retained; password
changes are serialized and recover after persistence failure. The CLI/env
override hashes synchronously only at startup, before HTTP serving. The shared
libuv pool remains a finite resource, and there is no claim of reduced password
CPU or a fix for compaction. Eight focused tests passed repeatedly in the source
worktree. Integration added a deterministic regression for an old login crossing
a password change: the initial async patch returned 200 after the new secret was
stored. The corrected verifier checks that its auth record remains authoritative
after the derivation; it returns 401 without a cookie or replay. All nine auth
tests and server typecheck pass after integration. Independent review accepts it;
see `issue-824-auth-responsiveness.md`.

## Confirmed: nested task tools remount on every delta

The prior audit's task-renderer correction was requalified against the identical
`366830f6` source blob and integrated with a minimal +29/-18 diff. It retains
stable child-tool keys/shells while reading their current payload. Two baseline
regressions fail on shell identity and stale Markdown; 63 adjacent browser tests
pass after correction, covering disclosure, nested scroller state, in-place
revision, removal, copy, errors/retry and tool images.

Current bounded A/B (30 samples per variant, instrumentation off): median
main-thread duration **353.39 → 22.72 ms**. Instrumented controls show 80 tool-shell
removals/reinsertions per delta becoming zero. The 80 clones/reloads remain; no
claim is made about desktop frame rate or eliminating all task-render costs.
See `issue-824-render-recovery.md` for artifacts, failed setup runs excluded from
statistics, and source-drift caveats. Final combined validation must use a frozen
composition; the prior measurements do not establish that the whole concurrent
worktree was unchanged. Independent combined UI review confirmed a membership
defect: an authoritative page removing one tool part from a retained message
leaves a phantom key/count, potentially hiding a later replacement. The renderer
correction therefore was not accepted for final qualification. The follow-up now
reuses the existing bounded structural scanner at each session revision, retaining
the prior ordered key list when unchanged. Keyed `For` preserves retained shells
through removal/reordering. Five new regressions fail on the preimage and all
68 adjacent browser scenarios pass naturally after correction, including exact
membership/count, tool-to-text identity changes and truncation shrink. The scan
still caps at 10,000 units and 201 tool discoveries/200 displayed tools; scanning
IDs/types on every revision is the explicit correctness tradeoff. Zero remounts
per delta remain instrumentally verified, but prior CPU A/B figures do not
qualify this new postimage. Independent re-review now closes M1 with no residual
blocker: 13 renderer and nine copy/image cases pass freshly and naturally, with
zero remounts per delta. See
`issue-824-task-membership-fix.md` and `issue-824-ui-review.md`, finding M1.

## Confirmed: compaction payload reduction precedes visible throttling

The existing 250 ms throttle limited only visible projection; every native
fragment still entered the reactive SDK reducer, even for an inactive session.
The correction aggregates by instance/session before that reducer, with a timer
started by the first chunk (later chunks do not postpone it). Incoming fragments
still advance revision/read fences immediately. Same-session ordering and SDK
page boundaries flush pending text; terminal authority, reconnect, deletion,
revert, pruning and disposal cancel obsolete buffers. Never-loaded inactive
sessions keep authority markers rather than materializing summary payloads.

The acceptance tests now use exact emission counts and text, not the original
artificial 32 MiB Long Task threshold: 128 active chunks produce one interval
reduction instead of 128, eight chunks delivered in separate 10 ms tasks produce
one reduction, and 128 never-loaded inactive chunks produce no payload reduction
or history request. All five browser tests discriminate the exact baseline and
pass on the patch. Activation mid-compaction, loaded-inactive sessions and remount
preserve exact authoritative text. Eleven new reducer/lifecycle tests and 130
neighbors pass; 67 real-renderer/history browser cases pass naturally.

See `issue-824-compaction-ui-fix.md`. Unit store gates use the repository's
`--conditions=browser --test-force-exit` convention for persistent imported
timers; this is not evidence of natural process cleanup. Spaced dispatcher tasks
are not real EventSource/provider cadence qualification. Interleaved same-session
events/read boundaries intentionally reduce the coalescing ratio, and sustained
arrivals can delay the existing revision-stable activation catch-up. Independent
UI review accepts this coalescing within those limits, without a reproduced text,
ordering or fence defect. Frozen-source validation results are recorded below.

## Browser HTTP/1 isolation: bounded non-reproduction

Five real Chromium Windows → Fastify Windows loopback HTTP/1.1 cases pass:
prompt/compact crossed with page/context close, plus a separate background-read
budget case. One real multiplexed SSE and a held SDK session A preflight leave
input/switch, B reads, metadata and a control endpoint available. Abandonment and
reconnection retire old HTTP/SSE observers before the held handler is released;
late completions produce no forward, environment write or shared invalidation.
Five catalogue intents admit only two held reads; queued work from the destroyed
page does not resume. Held upstream handler closures and idle pooled sockets are
reported separately from outstanding HTTP observers.

See `issue-824-browser-http.md`: 5/5 standalone, 10/10 combined with event
isolation, and 15/15 neighboring server tests pass naturally. No new product
correction follows from this non-reproduction. CDP and Fastify both verify the
HTTP/1.1 protocol, but controls are a minimal Solid fixture, not the complete
transcript/composer; upstream is disposable HTTP with native-shaped responses,
not native compaction. Linux/Electron, LAN and native 2.0.19 remain unqualified;
the report records the isolated cross-host experiment and evidence to collect.

## Native service isolation: bounded non-reproduction

The private native compaction fixture completed twice on OpenCode 2.0.21/Windows.
While A's real summary response was deliberately gated for ~1.5 s, B accepted a
prompt, ran its model request and completed successfully before A was released.
Native info/get/activity remained available (~1.8–7 ms observed). Both sessions
were simultaneously running; A then completed compaction with 29 native deltas
and no compaction-failed event. During a separate 32 MiB outline scan in the real
plugin host, six native info reads completed before the scan ended (final run).

See `issue-824-native-compaction.md` for commands, evidence and limits. This first
scenario used only 24,557 bytes of outgoing summary context; the 32 MiB tool
corpus belongs to outline work, not A's compaction context. Large-context assembly
was then qualified separately: two private runs each at 2/8/32 MiB verify every
tool payload byte at the actual provider boundary (32 MiB request JSON:
33,612,826 bytes). Submission-to-provider headers grows to 225–291 ms at 32 MiB;
unrelated pre-arrival reads show transient latency up to ~85 ms. B nevertheless
completes before A reaches the provider in both 8/32 MiB pairs, and completes
before A's held response is released at every size. No continuous global freeze
or specific native CPU hotspot is established. Provider JSON parse time is
separately recorded, not attributed to native assembly. No speculative upstream
patch follows. No inference about 2.0.19, Linux/Electron, remote TCP or the
reporter's exact data follows from this bounded evidence.

## Validation checkpoint (not final combined qualification)

`node --import tsx --test "packages/server/src/**/*.test.ts"` completed naturally:
**776 tests, 770 pass, 6 skip, 0 fail**, about 32.8 s. UI and server typechecks
also passed at this checkpoint. Auth/proxy corrections developed in separate
worktrees are not included in that run; fresh validation follows integration.

After auth and HTTP integration, a fresh strict-unhandled-rejection full server
run completed naturally: **799 tests, 793 pass, 6 skip, 0 fail**, about 32.8 s.
Command: `node --unhandled-rejections=strict --import tsx --test
"packages/server/src/**/*.test.ts"`. Log: managed shell
`sh_0f87b4309001T4M1Bgo7XpAvfz.out`. This includes the new login-authority race
regression; counts are not additive with earlier runs. Final review and frozen
composition validation remain outstanding.

The complete server build also passes (`npm run build --workspace
@neuralnomads/codenomad`), including production UI, TypeScript, auth assets and
bundled pruning/automation plugins. UI and Electron typechecks pass afterward;
diff check reports no whitespace defects. Vite reports chunks above 500 kB; no
unrelated bundling policy change or warning suppression was introduced. This
build did not start or deploy a desktop/backend process.

The first complete browser run finished naturally: **349 tests, 348 pass, 1 skip,
0 fail**, about 22.2 minutes (`npm run test:browser --workspace @codenomad/ui`,
log `sh_0f86cb7bb001g0xkd6q5qnv4G2.out`). It includes the five compaction cases,
task-shell retention, renderer/history/navigation and native Electron fixture
checks. The opt-in Electron tab-chrome check is skipped. Because this run began
while source owners were still integrating, it is not a frozen-source final
qualification; its event-isolation file executed before the additional deferred
Solid error case, and the later browser HTTP fixture was not included. Do not
reuse or add its count to the forthcoming fresh composition gate.

The independent server integration review accepts auth and HTTP changes without
a blocking finding; see `issue-824-server-review.md`. It preserves the distinction
between proven local defects and the unqualified reporter scenario. UI review
accepts compaction and SSE diagnostics; its task-membership finding was corrected
and closed by independent re-review. Dedicated HTTP browser checks are complete.
Fresh combined validation subsequently finished with before/after source fingerprints
covering tracked and untracked executable inputs. Its acceptance verdict and later
bounded follow-ups are below; documentation updates are excluded from its source
manifest.

## Reviewed-composition validation: acceptance remains blocked

The fresh validation uses 1,696 tracked and untracked executable inputs. Completed
gates have identical before/after manifests, SHA256
`16a3d4085dac90c27e892a480ae4c0735eb52782a9add8b0ca6732a640f1a4df`.
This verifies their boundaries, not a filesystem lock or installed dependencies.
Exact commands, logs and limitations are in `issue-824-combined-validation.md`;
private artifacts remain under
`C:/Users/Admin/AppData/Local/Temp/opencode/issue-824-combined-b91c8b66fcc840e1909170c5eeb846b9/`.

- Full server replay: **799 tests, 793 pass, 6 skip, 0 fail**, natural exit 0.
  The first run's private Git-directory cleanup `EPERM` (792 pass, 1 fail, 6 skip)
  is retained; the isolated nine Git tests and full replay pass with unchanged
  sources. Its Windows cause is not established.
- UI/server/Electron typechecks and server build (including UI and bundled
  plugins) pass naturally. A fresh complete private native fixture passes on
  OpenCode 2.0.21; no user runtime or storage was used.
- Stores: **141/141 assertions pass with force-exit**. The natural-exit attempt
  for the new compactage tests prints 11 passes but times out after 30 seconds;
  lifecycle cleanup is not qualified. Four event-handler tests exit naturally.
- Full browser: **360 tests, 356 pass, 3 fail, 1 skip**, natural exit 1 in about
  21.6 minutes. Failures are focus not returning to the composer after successful
  Git diff insertion (line 609), MCP fixture readiness at reduced motion/150%
  scale, and the expected legacy cached HTML not appearing after the literal-mode
  toggle (line 104; earlier HTML/source checks passed).
  All three pass in a targeted natural-exit replay without source edits; that
  does **not** convert the full suite into a passing gate or establish the causes.
  The existing focused replay has also finished naturally: **104/104 pass**, no
  skip/cancelled, unchanged sources. Its eight suites include all mission browser
  gates and the full session-rendering file. The validator's terminal report is
  received; validation execution is complete, acceptance is still non-green.
- Fresh renderer A/B on the final membership-corrected postimage: three couples,
  30 samples per variant, instrumentation off, natural exit 0. Median main-thread
  **324.57 → 16.94 ms** (baseline range 168.06–743.53 ms, fixed 9.93–50.33 ms).
  Raw metrics: `C:/Users/Admin/AppData/Local/Temp/opencode/codenomad-render-cost-srSQOf/metrics.json`.
  This supersedes the earlier postimage's CPU qualification, not its historical
  evidence; it measures the bounded fixture, not desktop FPS or all task costs.

No functional review blocker remains. However, the fresh full-browser gate is
non-green and the reporter's Electron Linux → Windows LAN/HTTP/OpenCode 2.0.19
scenario remains unqualified. The original freeze's exact cause is not established;
the private 2/8/32 MiB native compaction and loopback HTTP fixtures did not reproduce
a persistent global freeze. Do not mark #824 universally resolved or publish/install
these changes from this evidence alone.

The independent `browser-focus-cache-diagnosis` is now complete without editing
sources. It identifies a test synchronization gap: insertion updates the value
immediately, but composer focus/selection run in `setTimeout(0)`; the test asserts
focus immediately after reading the value. The original failed instant is allowed
by that contract; persistent loss of focus or draft is not demonstrated. Three
new complete focus passes and three HTML-cache passes are recorded separately.
A fourth focus attempt fails earlier, during a detached/intercepted Monaco overlay
click, and is retained as a distinct failure rather than attributed to #824.
The HTML cache transition is a synchronous local cache hit, so ordinary slow
Markdown highlighting is not its explanation; the original timeout remains
unattributed. See `issue-824-browser-focus-cache-diagnosis.md`.

The bounded `browser-mcp-bootstrap-diagnosis` is also complete: readiness timed
out in one of five natural-exit runs, with unchanged executable sources. The
network observations saturated the private harness's shared 4,000-entry budget
before terminal stages/errors/snapshots, so attribution is still impossible.
This is a confirmed diagnostic-capture weakness, not an identified product cause.
See `issue-824-browser-mcp-bootstrap-diagnosis.md`; all five outcomes are retained.

`browser-focus-test-sync` has now completed. The coordinator reviewed the diff:
after the unchanged text assertions, the test captures the textarea and waits for
its identity to equal `document.activeElement`, then retains the original identity
assertion. No sleep, new timeout, force-click, retry or product edit. Focus passes
2/2; the two-case run passes once and fails once on the independent HTML-cache
timeout. That timeout is now reproduced, not merely an unknown historical failure.
Opt-in `CODENOMAD_BROWSER_BOUNDARY_TRACE=1` prepares cache/overlay/focus diagnostics;
it was added after those two runs and has not yet captured the cache recurrence.
See `issue-824-browser-focus-test-sync.md`. Three authorized test/fixture inputs
changed; the earlier combined manifests remain historical, not fingerprints of
the revised test composition. Four selected product inputs remain unchanged in
the specialist's focused manifest; that subset is not a full-product manifest.

`browser-mcp-critical-capture` is now terminal: the private collector's overflow
is verified without a browser, then **5/5 targeted runs pass naturally** in 54.35 s
with complete critical traces, zero overflow and zero executable-source drift.
The 1,696-input comparison confirms that only the three authorized focus-sync
test/fixture paths differ from the earlier combined validation. Settings and render
finish in tens of milliseconds in these passes; most observed navigation time is
before the fixture body. That localizes cost in passes, not the historical timeout.
No sixth targeted run or product patch is justified. The prior red MCP and recurrent
HTML-cache timeout remain open; see `issue-824-browser-mcp-critical-capture.md`.

`browser-final-boundary-gate` has finished its **single normative full-browser
run**: **360 tests, 358 pass, 1 fail, 1 skip, 0 cancelled**, natural exit 1 in
20 min 10 s. All 1,696 inputs remain identical before/after, new manifest SHA256
`da74db30b68829edd40b44c069191cba8b21cc3e5e5d345862eec0cb9a14eb1c`.
The only failure is the final `errors=[]` assertion in the Git insertion test:
`ReferenceError: __name is not defined` from the anonymous opt-in browser script.
All earlier functional assertions in that case, including focus, pass in this
execution. The trace array is present but empty; it cannot prove absent gestures.
MCP and HTML-cache cases pass here, without attributing their earlier failures.
No retry or another full suite was run. See `issue-824-browser-final-boundary-gate.md`.

Acceptance remains **non-green**. `browser-trace-serialization-fix` is now
complete: the exact callback imported through the installed `node --import tsx`
serializes `const describe=__name(...)` without the module-scope helper. A minimal
Chromium page reproduces the same exception and empty trace. This is a confirmed
test-instrumentation defect introduced during this mission, not a product defect.
It is corrected with explicit, self-contained JavaScript passed to
`addInitScript({ content })`. The minimal Chromium check passes with no pageerror,
all observation kinds present and 200 entries retained after saturation. Snapshot
failure is isolated from the test assertion and page closure. UI typecheck and
diff-check pass; assertions, gestures, timeouts and product remain unchanged.
See `issue-824-browser-trace-serialization-fix.md`. The recorded full gate stays
red; there has been **no full-suite or feature-case rerun** after this correction.

Coordinator checkpoint, 2026-10-02 00:03 CEST: all **26 assigned tasks are
terminal completed**, no outstanding task, and no matching browser runner was
observed in the read-only Windows process check. A fresh hash comparison of all
**1,696 executable inputs**, including current tracked/untracked paths, against
the final gate finds exactly one difference: `git-history.test.ts`, SHA256
`dc7c378cc15e54f22f5d7e1a4c485313f0af9df536e1544690a33e3b2b2e5264`.
No product, configuration or script drift is found. This checkpoint is not a new
test execution or retroactive all-green verdict.

Next decision, not work running in the background: an acceptance run on the
corrected test composition is still needed for an all-green full-browser claim.
No automatic retry, extra audit or deployment is launched at this checkpoint.
The exact original #824 cause, earlier MCP/cache failures and natural store
cleanup remain unqualified; the mission is not finished as a successful fix.
Cross-host traces remain to be collected
according to `issue-824-browser-http.md`. No new product patch is justified solely
by a passing retry. No commit/push/merge/install/restart/session cleanup is
authorized by this checkpoint.

## Draft PR handoff authorized by the user

2026-10-02: the user requested a PR containing all mission changes. Deliver the
63 reviewed product/test/script/report paths on `fix/issue-824-performance` to
`dev` as a **draft**, without a closing keyword for #824. Preserve every recorded
failed run and qualification limit. The draft is the reviewable deliverable, not
a claim that all gates pass or the reported freeze is universally resolved.

All 26 investigation/correction/review tasks are complete and no test runner is
active at the handoff checkpoint. The durable mission's nonterminal status does
not mean that an agent or command is still executing: acceptance is incomplete.
No automatic retry or extra general audit accompanies publication. Acceptance
still needs the corrected test composition qualified and the cross-host limits
resolved or explicitly accepted; merge/install/restart/session cleanup remain
outside this publication authorization.

Modified source files above the size guideline (no size-only refactor):
`packages/server/src/server/http-server.ts` ~2,346 lines,
`packages/server/src/workspaces/manager.ts` ~1,240,
`packages/ui/src/stores/instances.ts` ~2,093,
`packages/ui/src/stores/opencode-data.ts` ~828,
`packages/ui/src/components/tool-call/renderers/task.tsx` ~569.
