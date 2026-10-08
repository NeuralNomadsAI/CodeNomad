# Missions refactor: integration qualification record

## Current delivery index — 2026-10-08

The reintroduction is open in [PR #866](https://github.com/NeuralNomadsAI/CodeNomad/pull/866),
on `missions-native-subsessions-20261003`. Its description is the target product
contract. The PR remains open and unmerged; published source, local corrections
and planned recurrence are distinct.
The whole integrated product is not yet accepted. Do not promote the historical
results below into current-source or installed-app qualification.

**Authoritative target clarification (2026-10-07):** Missions runs autonomously
inside the OpenCode service with both CodeNomad UI and its intermediary backend
closed. A persistent CodeNomad backend is not a substitute. The actual user request
was relayed from the cold-restoration subsession and is preserved in
`MISSIONS_AUTONOMOUS_PLUGIN_REQUIREMENTS.md`. Host-lifetime work/receipts below
remain retained, non-activated, separately scoped evidence, not native-plugin
autonomy acceptance. Active integration assignments now target native admission,
profile/environment, authority, storage and service-lifetime scheduling in OpenCode.
As clarified on 2026-10-08, a service restart may lose the in-memory schedule
Job while CodeNomad is closed. Reopening CodeNomad must show the interruption;
only an explicit Resume may rearm it without replay. Unattended cold wake is not a release gate.

**Latest scoped status:** ordinary server **2,370 pass / 0 fail / 8 skipped**,
625 inputs unchanged; latest complete no-capture browser **761 pass / 1 fail /
2 skipped**, 2,162 inputs unchanged, 764 selected. Sole failure: InterruptionDock
fixture startup at its original 15-second deadline. The locale fixture correction
passes; earlier Copy/network failures did not reproduce but remain unexplained.
No assertion/deadline is relaxed, and no further aggregate loop is planned.
Native parking/cold reconstruction has a bounded accepted fixture receipt below;
its automatic-restart target is no longer a delivery gate. Truthful parked-actor
Stop still requires its original-generation fence and native retirement qualification.
Native Job process-bound lifetime is committed in `1465793f`;
production protected authority, finite passage completion and packaged autonomy
remain unqualified. Historical results below retain their original scope and failures.

### Local assembly receipts — 2026-10-08, not packaged acceptance

The clean local assembly worktree is `missions-assembly-20261008`, separate from
the published PR head `d0724eca`. These receipts do not qualify the unmerged
CREATE, Play, due-composition or UI branches and do not authorize installation.

- At `e895e24f`, all top-level `packages/server/src/missions/*.test.ts` were run
  with `node --conditions=browser --import tsx --test`: **733 pass, 0 fail,
  0 skips/cancellations**, with no native `.test.mjs` fixture selected. Full output:
  `C:/Users/Admin/.local/share/opencode/shell/c11b91080a94d4d4d42e330142a991de76325c49/sh_11bf4db520010LHAYhxetFsDGK.out`.
- At `119443d5`, the succeeded-only native settlement/adapter/authority offline
  tests passed **25/25**, and server typecheck passed. Settlement requires exact
  original input, native effect receipts, terminal family evidence, journal and
  notification completion; its final authority transaction rechecks the native
  head/claim/inbox. Authority archival precedes exact calendar finish, so a crash
  between them leaves the original passage pending without replay.
- The scoped one-shot safety review against `d0724eca` found no actionable
  P0/P1/P2 regression in the plugin wrapper, presence cleanup or read-only route.
  This is not the final gatekeeper review of the assembled recurring product.
- At `2985f090`, the broader `opencode/missions/*.test.ts` run explicitly
  excluded `presence-native.test.ts` and selected no private native fixture.
  It finished **163 pass / 1 fail**, with no skips or cancellations. The due
  admission test exceeded its existing 30-second phase deadline under concurrent
  suite load (`native-recurrence-due.test.ts:210`); targeted passes do not erase
  this failure. Repeated synchronous Git-family reads are under investigation,
  without relaxing that deadline or calling a lower-concurrency rerun acceptance.
  Receipt: `C:/Users/Admin/.local/share/opencode/shell/c11b91080a94d4d4d42e330142a991de76325c49/sh_11c2b5378001zfigd0lRoWOMeX.out`.
- At `6f9d485a`, the same broader offline adapter selection, default concurrency
  and original due deadline passed **165/165**, with no skips/cancellations.
  The extra case exercises delayed presence I/O: real callback acknowledgements
  replace the incorrect fixed-sleep observation, without changing production
  retention. Verified Git routing uses a fresh filesystem fence in normal cases
  and retains Git fallback for ambiguous/configuration-changed routing. The
  original due failure and the separate perf-branch presence/owner/baseline
  failures remain failures, not erased by this result. Receipt:
  `C:/Users/Admin/.local/share/opencode/shell/c11b91080a94d4d4d42e330142a991de76325c49/sh_11c66a8e2001ITpweypnekKJve.out`.
- Upstream 2.0.24's active-Location Form/Permission/Shell lists materialize before
  the 1,024-result check. Unknown/over-bound coverage remains pending; no inactive
  worktree scan is used. Failed, interrupted, background and unrecognised effect
  cases are not claimed complete by the succeeded-only observer.

### Known admitted terminal execution failure subset — 2026-10-08, offline only

`missions-known-terminal-failure-20261008` adds a finite-passage branch, leaving
the ordinary succeeded-only observer's contract intact. It accepts only an exact
original start with all three applied authority receipts, one delivered input,
one native execution and a final durable `session.execution.failed.1` whose native
type is `provider.no-route` without an HTTP status. This is a deliberately limited
native coded subset, not error-prose interpretation. There must be **no durable Step,
tool/input, Shell, compaction, extra message, task, report, actor or native child**.
The released native claim, owner/inbox/pending counts, bounded actual Form,
Permission and Shell queues (including uncorrelated running Shells), native head
and journal are rechecked. Unknown/over-bound observations remain pending. The
outcome is **failed**, with all three startup effects **applied**, never
`rejected-before-effect`. No zero-HTTP-request, zero-dispatch or billing claim is
made: the admitted native execution positively ended, not an unadmitted operation.

Source backing is the unmodified reviewed files in `D:/opencode` at
`757e565c23f83b3ce3eab64aa6e35cf6ffbde880`:

- `packages/core/src/session/runner/step.ts:104-173` starts `llm.stream` before
  provider output and may return retry-full recovery before any durable Step.
  `session/runner/publish-llm-event.ts:99-110` lazily publishes Step.Started, and
  `session/runner/llm.ts:214-215` reloads context for subsequent attempts. Therefore
  a later native `provider.no-route` with no Step does **not** prove no previous
  provider HTTP request. Native retries remain native-owned; settlement never
  admits a second workflow operation or new tool grant.
- `session/execution.ts:79-89,141-148` publishes the failed terminal with claim
  release; `session/store.ts:217-223` clears `time_suspended`.
- `session/runner/step.ts:100-129` publishes Tool.Called before starting any local
  executor; `:135-145,256-269` joins/intercepts the scoped local fibers before the
  drain exits, and `session/run-coordinator.ts:99-106` publishes execution settlement
  after that drain exits. The complete exact ledger and empty native family/Shell
  coverage establish absence of passage-owned native tool/project/publication work,
  not absence of earlier provider activity. Other error codes, interrupted and
  partial/tool cases remain outside this intentionally smaller supported subset.
- `form.ts:148-155` keeps ordinary asked Forms within their owning operation and
  cancels them on interruption. `mcp/index.ts:234-268` uses a global sentinel with
  server/elicitation metadata, not native session/message/tool-call provenance.
  An arbitrary global Form arriving after the queue read is not passage-owned
  evidence. The same final native head/claim/inbox guard as success fences new
  passage-owned work; it does not invent ownership of unrelated late Forms.
  The existing queue read conservatively parks globals already observed, without
  claiming that the final lease globally freezes Forms from unrelated conversations.

The shared journal records `mission.finished/failed` at the existing finished
identity, with the exact start operation/session/message/native event identities.
It invents no task report or coordinator prose result. The write inherits the
original native IMMEDIATE frame and already-held business lock; settlement then
archives before the calendar CAS. Offline tests cover failed-not-success archival,
partial work/queue/identity refusals, transaction rollback during authority
archival, a crash after archive before calendar finish, no replay and next-day
admission. Explicit Stop terminality is not added. No private native fixture,
NSIS build, OpenCode edit, live Mission, installation, commit or push qualifies
this branch; packaged qualification remains deferred.

**Cross-branch source coherence:** settlement now consumes `8ec4aa6a`'s shared
`recurrenceSources(child)` / `recurrenceInput(child)` and signed read descriptors,
not just three startup operations or bare `config.consigne`. Each watched source
needs its exact bounded applied read receipt, source placement and old cursor
binding; every original charged operation/receipt survives the failed archive.
Unknown/legacy-without-descriptor reads, extra tool/publication operations and
changed shared input/digest remain pending. The failure journal retains the exact
source-bearing native input digest without trimming or substituting the consigne.
Both native due reconciliation and explicit archive-to-calendar settlement reuse
`recurrenceSourceCursors(archive)`; failed archives return no processed cursors and
retain the old cursor. The previous watched-count selector in due reconciliation
is removed, rather than silently parking all watched failures.

`native-recurrence-failed-sources.test.ts` exercises the actual production failure
observer, native authority provider over an owned offline SQLite/service graph,
shared source/input validators, journal and authority core. Its fixture supplies
pre-existing signed read/startup/native execution records; settlement itself is
not mocked. It verifies a full multi-KiB source input, refusal of unknown/tampered
reads, wrong input digest, hardcoded consigne substitution and moved sources,
unchanged charged receipts, failed cursors staying old, and the real due callback's
archive-only recovery with watched sources after an authority/calendar gap.
No native sends run during recovery; a retired grant cannot settle again and the
next passage can reserve with the unchanged old cursor. This tests the settlement
join with the source branch, not actual private-daemon source querying or a new
watched-source admission producer on this older `2985f090` worktree base. That
producer remains the main/source branch's existing separately scoped work.
Current cross-branch offline validation: failure/source plus ordinary terminal
tests pass **2/2**; adding recurrence-store and journal-capacity regressions gives
**55/55**, and server typecheck passes. These scoped receipts do not replace the
previous aggregate **25/26 admission-unknown failure** receipt below or qualify
private-native/package acceptance. No private fixture or deadline change ran.
Six focused authority identity/budget/archive regressions also pass **6/6** on
the shared signed-read schema; no aggregate or private-native rerun is implied.

Supported ceiling remains deliberate: coded native `provider.no-route` with no
durable Step/tool/Shell/derived family work, disabled publication, and only the
three applied startup operations plus fully validated signed source reads. No
zero-HTTP/billing or model-consumption claim is added; unknown effects stay pending.

Offline validation: server typecheck passes; one serialized authority/due/settlement
run passed **26/26**, and control/adapter/storage/metadata regressions passed **35/35**.
A later serialized run and an earlier concurrent run each returned `unknown`
before terminal observation in initial admission (**25/26**); a diagnostic run
reported `untrusted-signer`, but its underlying cause is not claimed resolved by
this terminal-failure change. A final focused failed-passage/settlement run passed
**2/2**, including native diagnostic preservation. Temporary diagnostics are
removed. No production fence or test deadline was relaxed; these successful
focused receipts do not erase the admission failures or qualify packaging.
The follow-up failure review withdrew its P1/P2 findings after native causal
proof; the strict coded subset is retained. The wording/label correction makes
no zero-HTTP or billing assertion. Its focused terminal test passes **1/1** and
server typecheck passes, including applied-receipt preservation and an unrelated
late-global-Form final-guard regression. No private fixture or deadline change
accompanies this correction; source review/commit remain separate parent actions.
#### Reviewed UI/source join on `9eed6d4a` — 2026-10-08

Parent assembly verification preserves the human-answer RPC/gate together with
CREATE, current passage and archive readers. Its recurring current/history/control
Solid selection passes **19/19** (`sh_11d1636ed001hAq0VPr8Bkw5bI`) and the targeted
strict read routes/native outputs/UI control payload selection passes **39/39**.
Server/UI typechecks pass. These are joined-source receipts, not installed-app
or service-lifetime autonomy acceptance.

The human-answer merge initially rejected watched input because it compared the
original lifecycle text with bare consigne. Both admission and historical proof
now use the shared full composed input and positive startup/source receipts;
watched/nested tests reject subsequent bare-consigne substitution. The published
2.0.24 `session/runner/publish-llm-event.ts:290,473,590` and
`session/message-updater.ts:327,346` establish that `executed` tracks **provider
execution**, not local completion. Local questions, subagents and business tools
carry false. Corrected human and terminal checks retain durable result/claim and
signature requirements and reject provider-hosted substitutes. The focused
producer/common-verifier/settlement selection passes **65/65**, with independent
source review at zero findings; no private native fixture was used. One-time
Wayfinder and original after-denial human evidence remain separate increments.

The owned `missions-ui-final-join-20261008` assembly joins the reviewed current
passage, archived reader and signed-control sources without replacing main's
paused CREATE, Custom/Pocock/Wayfinder templates, verbatim Notes, saved briefs
or source/input budgets. Final independent UI review closed all reported
P0/P1/P2 findings; the additional read-only retry-increment review reported zero
actionable findings (`ses_ee2fb91ceffeRx6LMmjl07gQTP`). This is source/UI scope,
not installed-app or native autonomous execution acceptance.

- Final current-source Solid selection (`mission-recurrence`,
  `mission-passage-history`, `mission-current-passage`) passed **19/19**, including
  partial Pause/remount and terminal partial Stop retries with the original whole
  request identity, clock-cancellation uncertainty, exact read-only status,
  keyboard focus, narrow RTL/touch and all ten locale keys. Receipt:
  `sh_11d0496770019LRfshZ2DNNlFc`.
- The deterministic input/contract/registration and owned current/archive/snapshot
  route selection passed **40/40**, with no skips/cancellations. It validates full
  frozen source/input startup receipts before journal exposure, strict partial
  denial-control snapshots alongside history/pending references, and preservation
  of the native control/status handlers. UI/server typechecks, UI build and Missions
  bundle build passed on the same source. Retained final foreground receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-ui-final-join-20261008-selfchecks.txt`.
- Failed evidence remains failed: the earlier owned joined browser selection was
  **32 pass / 8 fail** (`sh_11ccfa9510017XAUkN5Jc5H8EG`, missing assembled locale
  keys and stale control protocol). Its corrected intermediate selections passed
  **64/64** (`sh_11cd60e3b001yjV1k8oFYfM20D`) and **55/55**
  (`sh_11cd9f892001ThMSVbmMkPDaRI`); these are changing-source scoped receipts,
  not a new aggregate. The parent-reported broader **50/56** and **66/72** failed
  selections also remain failures. The initial foreground browser run timed out
  at the shell's 120-second command limit before completing its selection; it is
  not a pass. Neither these failures nor the earlier native/performance failures
  above are erased by the final focused passes.

Retry authorizes only remaining native interrupt/cancel receipts under the
qualified original pause/stop tuple with `retry: true`. A partial denial is not
a completed control, and no snapshot, refresh, remount or unknown reply replays
a POST, Play, prompt or task birth. Calendar SQL/CAS post-commit Bus delivery,
the separately integrated native control/kernel writer and complete packaged
NSIS/installation/private-native qualification remain distinct gates. No such
fixture, installation, daemon mutation or push accompanied this UI join.

No complete NSIS build or replacement installation has occurred. The requested
native/private qualification remains deferred until that first complete build;
the premature isolated source-fixture receipts below remain exceptions, not
packaged acceptance. The shared daemon and live Mission are not test targets.

At local assembly `9eed6d4a`, paused CREATE/UI, frozen templates/notes/briefs,
watched-source inputs and the actual due pre-reservation/cursor-finish consumer
are joined. All top-level `packages/server/src/missions/*.test.ts` pass
**742/742**, with no skips/cancellations, using the same browser condition and
default test concurrency. Server, UI and Electron typechecks and `build:missions`
pass. The nine recurring Solid browser tests and targeted native-shaped due
regression also pass; none launches a native daemon. Domain receipt:
`C:/Users/Admin/.local/share/opencode/shell/c11b91080a94d4d4d42e330142a991de76325c49/sh_11cc573d1001ziYZAVspTBsMKi.out`.

During CREATE merge verification, `sh_11cbedd3e001rXrGSmzeTPLgMe` finished
**39/40**: its root-reuse fixture expected invalid roots to survive signer reads,
but the joined acquisition now rejects them earlier. The corrected fixture
asserts both the early rejection and the subsequent final-fence rejection;
targeted adapter/due/budget tests then pass **10/10**, without relaxing native
fences or test deadlines. This does not erase the initial failed receipt.
Play/control, Run now, current-passage/result readers, native tool/business
composition, human-answer provenance and artifact-replacement qualification
remain separately scoped joins, not accepted by these results.

The broader Solid selections on that joined source are **not green**:
`sh_11ccc47e3001O4WHMqPaAx0Wgt` finished **50/56** and
`sh_11ccc8be4001aUsLSQ1Siu4X7l` finished **66/72**. Both retain the same six
failures: the old top-level disclosure expectation omitted the new schedule
section, and five explicit identity-retirement cases counted the intentionally
cancelled recurrence-list GET as an unexpected actor/read network failure.
The already-reviewed active-passage fixture correction is being joined without
changing production navigation, widening deadlines or ignoring actor/API errors.
Only the exact owned list GET's `net::ERR_ABORTED` after explicit view retirement
is classified separately; raw failure diagnostics and stale-reader assertions
remain. The corrected control/navigation rerun has its own receipt and must
complete before claiming those failures closed. Neither run uses a native daemon.

That corrected control/navigation selection completed **47/47**, no skips or
cancellations, in `sh_11cd19498002HdKX3wauklX2k9`. All stale actor/reader ABA,
read-only request and setup-error custody assertions remain. This closes the six
fixture failures on this source; it is not a rerun of the entire 72-case selection
or acceptance of the separately assembling UI/control producers.

- Published head at the start of this update: `cfea513b`; corrections now pushed
  through `32ee0fc5` include Stop/capacity (`530dc8af` / `bd2a8cee`), tab-local
  preferences/task-session policy/depth (`972910fe`) and inactive recurrence core
  (`1a17bbcc`). No installation, service restart or merge accompanies this push.
- Current focused UX delivery: 240 browser Missions cases and 32 unit/parity cases.
  Independent review then ran 94 browser and 59 unit/backend cases and reproduced
  two actionable findings: stale clean depth after native config/reconnect, and no
  per-playbook task-policy inheritance. Corrections and fresh regression checks are
  independently closed, including the follow-up in-flight depth race: zero scoped
  findings remain, five focused cases pass. This is not an approval of recurrence
  integration or the packaged host.
- UI/server typechecks pass after moving the depth HTTP snapshot to `api-types.ts`,
  away from the Node implementation dependency chain.
- Previous changing-source aggregate: server 2,247 pass/0 fail/8 skipped; browser
  711 pass/39 fail/2 skipped. A focused rerun does not erase either receipt. A
  frozen-input aggregates below and hosted CI remain separately scoped receipts.
- Earlier complete server aggregate: **2,279 pass / 0 fail / 8 skipped**, no
  cancellations, 2,287 selected cases. Completed in 1,312 seconds on unchanged
  execution inputs; only the separately invoked positive-loader qualification
  fixture changed outside the ordinary `**/*.test.ts` selection. The eight
  platform/opt-in skips remain skips, not positive native qualification. Receipt:
  `C:/Users/Admin/.local/share/opencode/shell/c11b91080a94d4d4d42e330142a991de76325c49/sh_115938c56001IqmfdmI8K4DLrV.out`.
- New complete browser aggregate: **758 pass / 0 fail / 2 skipped**, all 760 cases
  selected, no cancellations. Completed in 2,445 seconds. Benchmark and native
  Electron zoom opt-ins remain skips. Historical capture replay passed against
  current Technical details/report/coordinator navigation with an exact input
  digest; it is renderer-only proof, not current native transport/closed-client
  scheduled execution. Original 711/39/2 failed aggregate remains retained. Receipt:
  `C:/Users/Admin/.local/share/opencode/shell/c11b91080a94d4d4d42e330142a991de76325c49/sh_1158aef010015QPM7e460RS2XH.out`.
- Three isolated permission-fallback failures were fixture omissions: the dock was
  given neither a registered current conversation nor its identity. With that real
  conversation fixture, all three original copy/page/late-ack scenarios pass. The
  product's explicit external-request expansion and approval review guards remain.
  File-search retry passes independently; both fixtures now use private Vite caches
  and native close/dispose acknowledgements rather than mutable checkout caches.
- The Windows lifetime supervisor/service starter/full backend are implemented;
  resource integrity and detach prototypes do not qualify native-plugin
  service-lifetime scheduling. Keep fresh environment, signed admission and
  no-replay gates separate from historical backend and cold-restart probes.

### Parallel implementation follow-up — local, not desktop-enabled

- Fresh complete Windows server aggregate after the native/recurrence corrections:
  **2,362 selected / 2,335 pass / 16 fail / 3 cancelled / 8 skipped**, completed
  under `sh_1167074b3001FeCeovcmqsfwkz`. All **619 frozen existing server/helper
  inputs remain unchanged**. Final fingerprint/count receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-server-native-approval-output-20261007.json`.
  Failures include private owner/readiness, durable native-observation setup,
  installer fixture readiness, pending recovery, WSL timing, event ownership and
  three Mission-input cases. This failed aggregate is retained, not overwritten
  by isolated rerun totals. Diagnosis runs in disjoint bounded groups without
  relaxing ownership or deadlines. Original Mission-input file subsequently passes
  **11/11** at test-file concurrency **1**, unchanged source/assertions. Source
  tracing shows the two missing-rejection cases depend on an instruction-write
  hook; expiry of the advisory Git probe can prevent that hook from running,
  while final session/connection fences still run. Resource-pressure reproduction
  and complete bounded-concurrency validation
  remain separate open work, not an inferred aggregate pass.
- Bounded original process/deadline diagnosis reproduces resource pressure:
  **57/57** checks across six files at concurrency **1**, **56/57** at concurrency
  **2**. The 64-directory pending recovery still expires at **31.5 s** against its
  unchanged **30 s** admission budget at concurrency 2, versus **23.3 s** serially.
  A diagnostic pair records **230 Git-worker requests**, peak **9 submitted**,
  maximum queue-inclusive latency **4.06 s**, with zero unsettled requests. Node's
  default on this machine permits **31 concurrent test files**; each file owns
  its separate bounded Git-worker budget. No production timeout/ownership bypass
  is justified. The proposed aggregate concurrency **1** orchestration cap is not
  yet applied. The complete concurrency-2 comparison now finishes **2,351 pass /
  3 fail / 0 cancelled / 8 skipped**, still **2,362 selected**, with all **619
  original inputs unchanged**. Remaining failures: caller cancellation masked at
  private handshake; 64-directory pending recovery's unchanged 30-second deadline;
  and a Git worktree-config fixture's owned-root teardown `EPERM` (not its ownership
  assertions). Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-server-concurrency2-output-20261007.json`.
  Concurrency 2 is demonstrably insufficient on this machine; serial full validation
  follows correction/review without relaxing any admission deadline. Its later
  completed result below also fails the same 64-directory deadline: concurrency
  alone is not a demonstrated sufficient fix.
- Separate durable diagnosis reproduces a real cancellation defect in
  `host-authority/qualification.ts` discovery/handshake error handling and
  `host-authority/store.ts` receipt-read error handling: caller cancellation can
  become opaque `native-observation-unavailable`. A handshake probe fails in
  **4.48 ms**, not on expiry. The correction must preserve the originating signal
  reason while keeping unrelated/native timeout errors opaque; original pending
  denial and already admitted effects must not be rolled back or replayed.
  Prototype-only propagation passes **2/2** with exact protected/native bytes
  unchanged. Original isolated admission checks pass **1/1** then **2/2**;
  cancellation remains **1 pass / 1 fail** and the original 15-second human queue
  check passes at **14.13 s**. These do not explain all aggregate setup errors or
  replace either failed aggregate. After the concurrency-2 run completed unchanged,
  the three original-signal catch checks and a regression were applied.
  Temp-before/after tests show **0/3 → 3/3**, covering **20 cancellation/redaction
  cases**. The final **86-line** regression asserts an actual completion revision
  before constructing the observation; main server typecheck passes. Final combined
  original/new cancellation checks pass **10/10**, zero failures/cancellations/skips,
  at concurrency 1 (**54.73 s**). Independent review traces every qualification and
  acceptance caller and repeats **3/3** new regressions, **0 scoped findings**.
  Correction committed in **`7d292121`**; no admission deadlines or authority checks
  changed. Author's prior combined **10/10** run confirms all 10 private fixture
  roots removed; it predates only the explicit type-narrowing assertion. Evidence:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-cancellation-diagnostic-output-20261007.json`.
- Independent Git teardown diagnosis confirms a **shared scan custody race**:
  `listNativeWorktrees` can reject one bounded worker while another admitted Git
  read is still outstanding. The ordered probe observes request **11** admitted
  before fixture cleanup and later failing after its directory is removed. The
  original EPERM holder is not retrospectively proven live, but the premature
  custody release is demonstrated. All **9 original Git config cases** pass
  serially unchanged. The correction is in the shared scan, not deletion retries:
  deny partial inventory, stop further entry admission after failure and drain
  already admitted readonly workers within existing bounds before rethrowing the
  original error. Correction committed in **`973d775b`**; main repeats **10/10**
  serial checks (including all 9 original Git config cases) and server typecheck.
  Independent review closes with **0 findings**, repeating the real regression
  **1/1** and both actual-body failure paths **2/2**. Initial test gate/temporary
  path findings are corrected: bounded readiness, all gates released before drain,
  current-user temporary root. Probe-only readiness is shortened to 50 ms; the
  repository keeps its 30-second test bound and all production deadlines unchanged.
  No original test cleanup or ownership assertion is weakened. Evidence:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-bounded-review-git-custody2-order.out`.
- Corrected-source **full serial server aggregate** completed after these two
  independently closed fixes, with **623 original/current source/helper inputs
  frozen** at `973d775b`, all **623 unchanged**: **2,366 selected / 2,357 pass /
  1 fail / 0 cancelled / 8 skipped**, **1,991.31 s**. New cancellation/custody
  regressions account for four additional selected cases; all original cases remain.
  Sole failure: the 64-directory pending recovery returns non-authoritative 503
  after **31.06 s** against its unchanged **30 s** admission deadline. Thus a serial
  test-file cap alone is not sufficient under the actual concurrent native-fixture
  workload. No product deadline, assertion or ownership check is relaxed. The
  pending broker's real pre/post-RPC Git ownership read phases are being diagnosed
  for a minimal safe consolidation; no completed identity authority cache or
  mass-loading fallback is authorized. Opt-in actual native `.test.mjs` fixtures
  are not selected by the aggregate. Neither prior failed receipt is replaced.
  Result: `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-server-serial-corrected-output-20261007.json`.
  Inputs:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-server-serial-corrected-inputs-20261007.json`;
  complete retained log:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-server-serial-corrected-20261007.out`.
- The remaining broker case's unchanged isolated instrumented run passes in
  **26.742 s**, still against the original 30-second deadline and eight ownership
  checks/two Git processes. It executes **195 Git commands**: **65** initial
  classification (**10.419 s**), **65** pre-RPC validation (**8.407 s**), **65**
  post-RPC validation (**7.751 s**); one RPC dispatches at **18.826 s**. All reads
  settle and owned fixture cleanup is confirmed. Windows `execFile` lifetimes
  (not queue-inclusive) are median **86.6 ms**, p95 **1,035.7 ms**, max **2,352.2 ms**.
  This does not replace the complete run's failure. The duplicate initial Git
  filtering supplies only a classification boolean; it is being consolidated
  into the final authoritative pre-RPC preparation pass, expected **195 → 130**
  commands. Fresh post-RPC Git identity remains mandatory for supported and
  declared-unsupported results; normalized mapping/identity withdrawal still
  fails the whole request, foreign candidates remain errors and all-foreign stays
  403. The candidate now measures **130 commands: 0 provisional / 65 pre-RPC /
  65 fresh post-RPC**; unchanged cold case **12.576 s**, one RPC at **6.542 s**,
  ownership peak **8**, Git worker peak **2**, all reads settled and owned cleanup
  verified. Author route suite **22/22**, typecheck and diff check pass. Independent
  committed-contract review confirms no caller needs two distinct pre-RPC Git
  snapshots. Final review repeats **5/5** focused cases, cold case **15.88 s**, but
  confirms **one latent P2** in actual old/new route bodies: `Promise.all` can
  return 503 before admitted peer reads settle, in provisional/pre-RPC preparation
  and supported/unsupported post-RPC validation. Fix is now frozen at both
  route-local batch sites: deny publication, drain admitted reads, then rethrow the
  identical first error; never admit a next batch or late RPC. Author suite is
  **26/26**, typecheck and diff check pass, all **18 original harness/test bodies
  unchanged**. Four persistent negative custody cases fail against virtual old
  batching; cleanup observes **0 outstanding Git reads**. Cold case remains
  **130 commands (65 pre / 65 post)**, now **10.710 s**, unchanged 30-second deadline.
  Final independent review closes **0 remaining findings**, **6/6** actual-source
  checks: four phases retain admitted peers with RPC counts **0 / 0 / 1 / 1**,
  actual helper rethrows the identical first error, real **30-second** expiry yields
  503/**0 RPC**/**no capability publication**, four old-batch controls fail as
  expected. All **9 fixtures removed**, **0 outstanding Git reads**, original
  harness/18 test bodies unchanged. Correction committed **`01d63a0b`**. No
  cross-RPC identity cache, deadline or worker-limit change. Custody candidate receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-pending-custody-final-output-20261007.json`.
  Earlier candidate receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-pending-final-output-20261007.json`;
  review: `.../pr866-pending-independent-20261007/verification.json`.
  Original read-only measurement:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-pending-readonly-2rYnY0/summary.json`.
- The fresh **complete ordinary serial server aggregate** completed at
  **`01d63a0b`**, with **625 inputs frozen**: all earlier **623 paths retained** plus
  the new shared sync-privacy helper and family regression. Selector remains all
  `packages/server/src/**/*.test.ts`; no original test, assertion or deadline is
  removed. New unwired `native-protected-public.ts` and opt-in `.test.mjs`/startup
  fixtures remain independently qualified, explicitly outside ordinary aggregate
  acceptance; they have no `.ts` callers and may progress without modifying these
  frozen inputs. Result: **2,378 selected / 2,370 pass / 0 fail / 0 cancelled /
  8 skipped**, **78 suites**, **1,668.03 s**, all **625 inputs unchanged**. The
  selected-count increase is eight new broker cases plus four family-sync cases;
  no original test is dropped. This closes the ordinary server aggregate for
  these sources, not native opt-in authority, service-owned due admission or
  packaged parity. All three failed historical aggregates remain separately kept.
  Result and complete-log digest:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-server-serial-broker-625-output-20261007.json`.
  Inputs: `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-server-serial-broker-625-inputs-20261007.json`;
  complete log: `.../pr866-server-serial-broker-625-20261007.out`.
- Publication was temporarily blocked: ordinary pushes failed Git LFS lock probing;
  all four outgoing files are verified **non-LFS/non-lockable**, no LFS objects
  were pending. A command-only lock-verification override (no persistent config or
  skipped hook) reached GitHub but received **Internal Server Error**. Read-only
  remote/PR checks retained **`29084987`**, PR open; the body write also returned
  a GraphQL server error. These failures are preserved. A later bounded push
  **succeeds through `3b40f9b1`**, publishing **`01d63a0b`** and its scoped evidence.
  Description reconciliation is separately verified; publication is not aggregate
  or autonomy acceptance. The complete ordinary aggregate later passes as recorded
  above; native opt-in qualification remains independent.
- The paired ordinary desktop bootstrap transport is locally bounded and private:
  exact proof/cookie validation, body drain, redirect/proxy refusal and absolute
  deadlines. A further audit passes **16/16** Node bootstrap/startup checks and
  confirms AuthManager/launcher compatibility without adding dependencies. It
  reproduces an **Electron stale cookie** installed after generation reset while
  native installation is pending: navigation denial alone is insufficient. Exact
  locked Tauri/wry source also queues installation without a generation-aware
  native receipt. Both require final native-execution/receipt fencing before
  ordinary bootstrap commit. The paired correction is committed in **`1f0954da`**:
  Electron serializes installation,
  native readback and exact stale cleanup across resets, with failed cleanup fencing
  successors. Tauri checks at main-thread execution and requires same-webview
  readback before publishing `local_access`; unknown receipts remain fenced.
  Author **22 Node / 14 Rust checks** and Electron typecheck pass; main repeats
  **22/22** Node checks and Electron typecheck. Rust evidence
  includes mocks and real isolated AuthManager routes, **not packaged native cookie
  transport**. Independent final-boundary review closes the stale cookie and
  queued-execution defects and reproduces one macOS Wry IPv4 readback defect:
  its URL filter hides cookies at `127.0.0.1` and can falsely acknowledge stale
  cleanup. Same-webview unfiltered `cookies()` now supplies readback while exact
  name/domain/path/value checks remain strict. The persisted regression closes
  that defect, independently **1/1**, with **0 remaining scoped findings** and
  locked macOS/Windows/Linux reader callers verified. Packaged macOS transport
  remains unqualified. The 24-line auth-only
  fixture separates ordinary bootstrap tests from retained lifetime composition.
  Direct-child lifecycle intent wrappers and persistent attachment scaffolding
  remain separately retained, unactivated, not native-plugin autonomy evidence.
- `860ed92e` extracts the concrete prepared-creation pipeline used by the ordinary
  HTTP route and shares physical root/deletion admission with managed roots.
  **30 focused checks** and server typecheck pass; independent source review finds
  **0 actionable regressions**. Recurrence preparation reuses that pipeline but
  still refuses dispatch without a genuine standing grant; creation is not Play
  or an environment/model send.
- `ce4b58fd` isolates finite passage journals from the ordinary 20-map/2,000-event
  project inventory and archives exact settled references into the existing
  30-receipt history. **72 focused checks** pass. Independent review reproduced
  three defects, now closed: terminal/reference authorization lacked the result,
  native-return reports were incorrectly awaiting coordinator notifications, and
  deletion/cleanup could race archival settlement. The corrected file independently
  passes **7/7** plus all original probes, with **0 remaining scoped findings**.
  Physical journals remain retained; bounded disk reclamation and native terminal
  readers are not implemented or implied.
- Existing-grant restart restoration is local with independent scoped closure.
  It requalifies only an accepted running protected grant, with exact fresh native
  evidence and a persisted genuine daemon-storage identity; it neither adopts nor
  sends Play. Four findings in the first review have corrections and **23 focused
  fast passes**: unknown historical identity rebinding, malformed control evidence,
  losing-attempt lease invalidation and unbounded qualification cancellation.
  Subsequent review exposed hidden ordinary service acquisition through ownership,
  event inventory and the actual native authority core/plugin root reader, plus
  inconsistent canonical Play controls. Those paths now use existing-only
  authenticated connections and registered-only inventory, with no fallback.
  The genuine core/plugin probe independently restores `running` / `qualified`
  with **0 ordinary acquisitions**; **0 remaining scoped findings**. The current
  complete canonical/file/core/plugin run passes **43/43**, no skips or
  cancellations, after the final root-reader correction. All **17 recorded input
  fingerprints remain unchanged** at completion. Receipt:
  `C:/Users/Admin/.local/share/opencode/shell/c11b91080a94d4d4d42e330142a991de76325c49/sh_1163bc8ed001YbqLcAQWY0nx2N.out`.
  Commit: `f6973b96`. Previous **40/40** and fast **26/26** checks predate that
  final correction and remain historical. Earlier
  **31/31** and **20/20** exploratory checks predate these review corrections and
  do not qualify the corrected source or native writer replacement.
- Existing-only workspace observation independently passes **95 focused cases**
  (service/manager/generation/event ownership/routing), including cold nested reads
  after cancellation/invalidation with **0 additional discovery/start/provisioning**.
  Main independently reruns **70 selected cases** with no failure or skip;
  commit `64105006`. Oversized touched sources: `workspaces/manager.ts` about
  1,274 lines; `manager.test.ts` about 1,010 lines, retained without unrelated refactor.
- Native standing authorization is implemented locally in four new pure modules:
  **14 focused checks**, including **1,025 finite passages**, exact-key immutable
  archives and permanent retired-sequence fencing without raising ordinary authority
  quotas. Independent review reproduced **3 P2 findings**: torn-denial reconciliation
  could deadlock after bookkeeping advanced the revision; reservation headroom
  incorrectly rejected materialized receipts; historical archive reads ignored
  their committed digest. All three are corrected and independently closed:
  **17/17** author/main/reviewer tests, reviewer typecheck, original probes and
  unchanged four-file fingerprints; **0 remaining scoped findings**. Commit:
  `112c0836`. The exact receipt stress grows **196,596 → 196,938 bytes** without
  rejecting bookkeeping or raising the 256-KiB ceiling; another reservation is
  still fenced.
  Native signer provisioning,
  writer exclusion, ledger fencing and actual terminal/effect observation remain
  integration work; no production proof producer or dispatch is enabled.
- Native service-graph admission is committed in `e63c182c`: an executable
  daemon-local adapter and high-level Mission reconstruction/environment/send
  helpers. Independent review reproduced ignored async owner approval and an
  omitted mutation guard selecting a read default. Both are corrected and closed:
  **13/13** author/main/reviewer checks, **0 remaining scoped defects**. The final
  actual private OpenCode **2.0.24** fixture exercises the **high-level helper**,
  real journal/authority logic, signed adoption/Play, fresh ENV then prompt and
  synthetic with `resume:true`, **without a CodeNomad backend or upstream edits**.
  Exact lost-ACK evidence retains one admission without replay. All **9 recorded
  production source hashes** match in main/reviewer verification. Final receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-yx2mH0/results.json`.
  Writer trust/exclusion and root-change denial remain **injected**, the Location
  explicitly warmed. Two provider requests show dispatch activity, not successful
  model consumption/completion. Shipping entry/build are unchanged; protected
  native writer qualification, service-owned due work and production activation remain open.
  Earlier `QFyvWn` low-level / `GoUGI8` intermediate receipts remain historical.
- **3/3** entry-lifetime checks pass in author/main: external setup seals out native
  graph services; plugin Scope survives request cleanup but also leaves a stale
  retained capability usable after native-map invalidation. Due passages must
  acquire a fresh scoped native graph and its exact entry token. The checked
  existing-only caller prototype is not a production graph/writer producer or cold
  wake proof. Loading one explicitly signed/enrolled root through a demonstrated
  native acquisition mechanism may be qualified separately; pending-recovery's
  loaded-only rule is not a prohibition on authorized Mission cold-root wake.
- Main reproduced a related returned-approval defect in the shared recurrence
  runner/store/passage/archive paths. Synchronous literal-true checks now cover
  reservation, native storage preparation, settlement and passage/archive writes.
  The first **51 focused cases** and server typecheck preceded further exact
  publication/archive regressions. Independent review reproduced one final
  raw-callback edge: the runner's
  `beforeEffect` returned the original guard after validating it, so late false/void
  could pass through the ordinary creation helper. It now returns the strict
  guarded wrapper; two regressions cover the final invocation and actual shared
  creation-effect seam. Final source: **57/57** complete focused cases and server
  typecheck; independent **2/2** original probes, **40/40** fast aggregate,
  typecheck and unchanged seven-file fingerprints, **0 actionable findings**.
  Commit `354acfaa`. Unknown post-admission settlement retains its pending ID.
- A native transactional metadata commit candidate is implemented locally in
  `native-authority-provider.ts` (**211 lines**), with an actual private **2.0.24**
  graph/SqlClient fixture: guarded **BEGIN IMMEDIATE**, exact snapshot/revision
  checks, readback, rollback after write and two Locations. A second private
  daemon's **genuine native execution claim** denies acquisition without modifying
  that claim. Server typecheck passes. CLI/source fingerprints are recorded in
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-oRs9ZJ/results.json`.
  Enrollment is **injected**; this is **metadata-commit evidence**, not signer
  authority, permanent writer ownership, whole-database rollback resistance,
  managed cold autonomy or production activation. Independent review reproduced
  **1 P1**: authority retired in a microtask after the last caller guard could
  still commit metadata. The final shared transaction hook must recheck caller
  authority as well as native fences for both hot publication and parent archive;
  corrected once in the shared final hook. All **4 actual native retirement
  cases** roll back: revision **0**, original parent unchanged, next parent absent.
  The independent original probe now rejects and positive/competing-execution
  probes still pass; **0 actionable findings** in the frozen adapter scope.
  Author/reviewer source fingerprints match; final receipts:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-7CMDEy/results.json`
  and `.../missions-child-environment-fz21n6/results.json`. Commit `6ba741c4`.
  This closes the metadata adapter P1 only; it does not activate autonomous work.
- On 2026-10-08 an ordinary focused-test command inadvertently selected the
  existing private `native-authority-provider.test.mjs` **after the user deferred
  native tests**. It completed against its own isolated 2.0.24 CLI/DB; no current
  recurrence adapter, cold scheduler or installed product was qualified. The
  shared daemon PID 10348 and installed Tauri PID 14708 were unchanged, and no
  fixture OpenCode process remained. Preserve the unchanged receipt at
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-iGW4Sv/results.json`
  (SHA-256 `ca736c8f473cce0db7f41bc66032ae63a56f31962fbeefb8d244bbd5a1f293f1`);
  do not repeat this native test before the requested first build.
- A second native test was run prematurely during the 2026-10-08 recurring Play
  work, after a server/plugin source build but **before the requested first
  complete NSIS build**. The command was `node scripts/test-missions-native.mjs
  'C:\Users\Admin\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe'`.
  Its isolated OpenCode 2.0.24 service (PID 36796, loopback port 54672) used
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-native-I0kyjB/fixture.db`
  and separate HOME/XDG/config paths; the retained `receipt.json` in that folder
  reports **16 passed, 0 failed gates**, 32 fixture-provider requests and an
  owned-service SIGTERM on exit. The isolated bundle's SHA-256 was
  `DEC64C137FE3036D8F554F089E9699F2DDF2DC02F6318BEF48C22F4F438C0CD9`.
  Source HEAD was `223e897afe2294c9ea317587e9045ae27a1ca9fc` with uncommitted
  Play changes, not a frozen tree. A prior `opencode.cmd` attempt failed with
  `EINVAL` before fixture startup. The script and receipt show no contact with
  the shared daemon, installed Tauri app or live Mission, but their historical
  process state was not independently rechecked. This is **not** packaged or
  production autonomy acceptance; do not repeat private native fixtures before
  the complete build.
- **`65dd66a4`** supplies a separate exact-incarnation native managed-owner seam:
  actual Global/ServerInfo/Database graph, private managed registration and config,
  process start/executable identity and native storage challenge. Trusted enrollment
  is explicitly provisioned, never adopted by an observation. Real private 2.0.24
  proves positive metadata commit, **7 after-write rollbacks**, missing-enrollment
  refusal and denial of a standalone process sharing the same DB. Managed restart
  keeps DB/enrollment but safely refuses stale ownership. All **8 source hashes**
  match; server typecheck and independent review close with **0 actionable findings**.
  Receipt: `C:/Users/Admin/AppData/Local/missions-managed-owner-YUXUFw/fixture/results.json`.
  Known-writer exclusion and independently protected rollback checks remain delivery
  gates; positive restart requalification is optional research. A protected signer/
  checkpoint candidate is being composed outside DB; none is production-enabled.
- **`3e205b52`** adds the opt-in private **protected public signer/checkpoint proof**
  on real 2.0.24, independently closed with **0 findings**. All **16 reviewed input
  hashes** match. Public Ed25519 signature/digest checks deny absent/replaced trust,
  invalid signatures and wrong public signer. A precommit tear rolls metadata back;
  lost RPC acknowledgement after commit preserves the protected original uncertain
  reservation without replay. Restoring **complete older valid SQLite bytes** is
  rejected by the independently stored checkpoint, including an older validly
  signed epoch after an explicit fixture-human Pause. No private key is exported
  or used during a native passage, and no CodeNomad backend is attached. Receipt:
  `C:/Users/Admin/AppData/Local/missions-protected-proof-UEoOzR/fixture/results.json`.
  This is a proof of existing primitives, **not a production authority producer**:
  the existing CAS accepts only a secret-bearing one-shot document; sequential
  `HostStorage.atomic` is not public cross-resource CAS; the genuine async family
  fence is rejected at final guard **4**; native signer provenance still depends
  on backend qualification. Explicit human fixture re-enrollment after DB restore
  is not autonomous restart acceptance. Arbitrary-writer exclusion and power-loss
  durability remain unqualified. A narrowly typed public checkpoint/CAS seam is
  next work, independent of the frozen full server aggregate.
- **`7e38122d`** adds a genuine **synchronous family-current final fence** to the
  existing `FamilyAuthorityStore`, not a second ownership store. It returns literal
  `true` only after fresh private physical root/marker observations, original
  descriptor identity and exact token bytes; absent/same-byte replacement, aliases,
  malformed/oversized markers and unconfirmed synchronous privacy fail closed.
  Queued/reentrant operations and release requests fence publication before/after
  reads; ordinary async assertion/release retries and retained references remain
  unchanged. The existing native Windows owner/DACL evaluator moves into a shared
  22-line storage helper with unchanged bounds and host-authority denial behavior.
  Author and main repeat **16/16** original/new family/private-file tests; server
  typecheck passes. Actual private 2.0.24 final guard **4** rejects async/queued
  release with metadata rollback, then commits with genuine default sync privacy.
  Independent source/caller/evidence review closes **0 findings**, all **8 reviewed
  hashes unchanged**, without independently rerunning the native fixture. Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/family-native-sync-29086334d84247be814f0bd640b82b75/qualification.json`.
  This closes the concrete family callback interface gap, not public checkpoint
  CAS, signer provenance, arbitrary-writer exclusion or production autonomy.
- Native-startup qualification uses a read-copied **2.0.24** artifact and genuinely
  private XDG managed registration, with actual start/restart and preserved sentinel.
  Persisted ENV nonce/hash reaches each daemon; **Node `--import`/`--require` and
  Bun `BUN_OPTIONS --preload` record zero loader hits** on this compiled artifact.
  Bun runtime is **1.4.2**; installed Bun **1.3.14** is not a same-version control.
  Cold global-plugin zero hits are observations over **2-second windows**, not
  boot-completion proof. Cleanup and copied/original artifact hashes pass. Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-startup-ir3u3e/receipt.json`.
  This rejects those artifact-specific loader candidates, not all existing native
  startup mechanisms. No upstream modification, production bootstrap or scheduler
  is enabled.
- Actual **2.0.24 native-claim restart** now proves cold plugin activation without
  post-restart Location demand: one prompt admission, **one tool entry total**,
  **two model requests** (initial and fresh native restart continuation), original
  session/message/call identities retained. The claimed Location plugin loads;
  the idle control has zero setup hits over its **2-second observation window**.
  Native runner marks the unfinished tool **aborted**, not re-executed; resume count
  becomes **1** before terminal settlement clears the claim. Exact upstream tag
  `v2.0.24`, commit `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69`, is read-only source
  evidence. Inactivity can interrupt active tools, and ephemeral tool progress
  does not refresh that clock. This is a qualified **cold activation path**, not
  durable tool continuation or scheduling. Inactivity survival, protected writer,
  signed-root/profile checks, finite passage/no-replay and unattended relaunch
  remain open; closing all CodeNomad processes is **not** qualified. Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-startup-gYg5gT/receipt.json`.
  Cleanup/sentinel preservation and original/copied artifact hashes pass. A bounded
  plugin-lifetime/idle probe follows; no native claims are manufactured or rewritten.
- The follow-up **native timer lifetime** probe passes on actual 2.0.24: plugin
  Scope rearms from its persisted record and ticks after claim settlement. One
  narrow authenticated RPC captures graph references; ticks take short leases and
  compare exact native-map entry tokens. Exact-directory eviction finalizes plugin
  Scope and stops ticks: capturing global Locations does **not** create a global
  lifetime owner. Claim-free restart records **zero setups/rearms/ticks over 8 s**,
  a bounded observation only. Counts remain **1 admission / 1 tool entry / 2 model
  requests**, with no replay or keepalive prompts. Automatic 60-minute inactivity
  eviction and all-CodeNomad-closed operation remain untested. Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-startup-aOPsBv/receipt.json`.
  Cleanup, sentinel preservation and artifact hashes pass. Module evaluation at
  cold boot is now being distinguished from setup activation; production remains
  disabled. Cold restart remains an unqualified historical scenario, not a
  delivery gate after the 2026-10-08 service-lifetime clarification.
- A further module-evaluation probe distinguishes imports from setup: claimed
  restart has **1 entry / 1 bundled-dependency evaluation marker and 1 setup**;
  claim-free restart without Location demand has **0 evaluations / 0 setups over
  8 s**. The two positive sites are within one bundle, not two native imports.
  Exact upstream module loading is called by the Location-scoped supervisor.
  This bounded artifact observation does not prove global impossibility, and no
  escaped/global Scope was added. Counts stay **1 admission / 1 tool / 2 model
  requests**, with cleanup/sentinel/artifact hashes preserved. Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-startup-JQzXFg/receipt.json`.
  A genuine enrolled standing native claim and actual graph callback/retention
  contract are the next bounded candidates; no native execution rows are invented.
- The **standing watcher callback** candidate (opt-in fixtures in **`bdd6f874`**)
  now passes on actual 2.0.24:
  existing Effect `session.hook("context")` holds the genuine execution before
  restart model dispatch, with current Location/lifecycle and Scope distinct from
  plugin setup. The claim survives **2 recoveries**; the original tool remains
  aborted and never replays. Exact eviction's existing local-RPC shutdown race
  cancels the handler, finalizes Scope and cancels future observations—no escaped
  owner. Explicit fixture park plus `session.interrupt(resume:false)` clears the
  claim; a following cold restart without Location demand records zero imports/
  setups/callbacks over **8 s**. Watcher counts: **1 admission / 1 tool / 1 model
  request**. The original timer regression also passes, **1 / 1 / 2**.
  Receipt: `C:/Users/Admin/AppData/Local/Temp/opencode/missions-startup-EmWMtU/receipt.json`;
  timer: `.../missions-startup-gvibEk/receipt.json`. Artifact hashes, sentinel and
  cleanup pass. Native denial/unclaimed control pass, not broader permission/inbox
  qualification. Unattended inactivity survival, ten-resume budget continuity, global/
  RcMap ownership, signer/writer composition and model-following reliability remain
  open. Independent callback review closes with **0 scoped findings**, matching
  authored sources/bundles, CLI fingerprints, raw markers and read-only native DB
  rows for both watcher and timer. It verifies exact upstream hook ordering and
  inherited native graph services, without rerunning the heavyweight fixture.
  Finalization markers prove the awaited handler/plugin lifetimes, not every native
  owner. Receipts pin four authored files each, not the complete runner; new modes
  need fresh frozen receipts and common-path changes need watcher/timer revalidation.
  A real long-duration private expiry probe and bounded native handover investigation
  are separate next work. No
  production scheduling or claim-row writes are enabled.
- The real **automatic inactivity** probe completed in its separate private
  service: **63 minutes** without native polling, prompts or keepalive writes;
  acknowledged genuine held claim and **1 primary model request**. Cancellation/
  cleanup watchdogs were armed within **69 minutes**. Independent read-only review
  verifies exact-root native eviction **60 min 59.823 s** after the held marker,
  **122 s before the pre-tail read**. Claim clears and attempts reset to **0**;
  counts **1 admission / 1 tool / 1 model**, original tool **error: aborted**, no
  executor replay. The old plugin finalizes; tail demand loads a **new graph**, not
  uninterrupted retention. Historical `session.execution.interrupted.1` payloads
  are absent (**0**), so exact execution-interruption reason remains **Unknown**;
  automatic Location eviction is independently evidenced by the bounded native log.
  Ack: `C:/Users/Admin/AppData/Local/Temp/opencode/missions-slow-expiry-20261007-a.json`;
  original final receipt: `.../missions-startup-GzOudV/receipt.json`.
  Independent setup review finds **2 scoped P2 defects** in the new probe only:
  the supervisor can claim sentinel closure from a kill request without awaiting
  owned close acknowledgements, and acceptance can attribute generic cancellation/
  claim clearing to automatic inactivity without mandatory native provenance.
  Both are reproduced by memory-only negative probes. New slow-fixture sources
  now require worker/fork/native close acknowledgements and mandatory exact-root
  native eviction provenance; old-fail/new-pass local checks and generated-adapter
  syntax checks pass with **0 native operations**. Revised entry/readiness checks
  record **14/0**, but do not retroactively qualify the old run. All **12 reviewed
  baseline files remain unchanged**. Source/check receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/slow-expiry-p2-validation-20261007-v2.json`.
  These checks do not prove execution of the patched 63-minute probe;
  completed old-source cleanup remains **unqualified**, despite its literal
  success outcome. One **P2 evidence gap** remains: preserved-sentinel check and
  native child close witness are supported, but the supervisor's original
  **fork-close ACK is absent**; managed stop/status is not a persisted native
  process-close witness. Supplementary PID absence cannot replace those ACKs.
  The supplement truthfully retains **`confirmed: false`**. A fresh ACK-bearing
  cleanup-only protocol proof is separate next work, not automatically another
  63-minute wait and never a retroactive rewrite of the old receipt. Automatic
  Location eviction logs must not be relabeled as an exact execution-interruption
  reason. No quiet-phase polling, native clock changes, fabricated claims or
  production authority are involved; initial setup otherwise matches frozen inputs.
  Original receipt SHA-256: `e0ee90cfcc95a0716681032332f9f3115ac1c7906abd0ea16aa7cd18efe4c6e4`;
  supplement: `e5a39bf1442ca62c931d8f791265db2f248c92d1746b39f07ffb46314d41f4b1`.
  Main verifies these and the original ACK unchanged; raw native log and frozen
  bundle/CLI/run inputs are independently verified without runtime/process queries.
  A cleanup-only preflight now passes **4/4 refusal checks** with **0 CLI executions,
  forks, services or admissions**, retaining `confirmed:false`. It exposes two
  actual producer gaps: `observeOwnedExit` proves PID absence, not an already-open
  managed-daemon exit-handle ACK; immediate cancellation is worker-only, with no
  supported post-held-ACK supervisor entry inside five minutes. Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/slow-cleanup-proof-9CXFLu/receipt.json`.
  The concrete fixture interfaces are being implemented separately: exact owned
  Windows process-handle waiting before stop and nonce-bound supervisor IPC
  cancellation. Shared PID-observation helpers remain frozen for ongoing Job
  diagnosis; no absent-PID result is upgraded to an ACK. No fresh native lineage
  has yet been launched or qualified by this preflight.
  A later **one-lineage short cancellation attempt** records real managed restart/
  stop same-handle exit ACKs, sentinel preservation/close and worker close, but
  the supervisor parent IPC remains open until the controller deadline; its
  outcome stays **unqualified**, `confirmed:false`. Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/slow-cleanup-proof-v4-xfAYO3/attempt-result.json`.
  After a local IPC-drain correction, independent actual-supervisor review finds
  **one remaining P2**: worker close can precede asynchronous enrollment/ACK
  validation and receipt writes; parent disconnect then causes late ACK send
  `ERR_IPC_CHANNEL_CLOSED`. **13 existing + 5 targeted checks** and owned-child/
  watcher closure are separate zero-native evidence, not native acceptance.
  Review: `.../slow-cleanup-independent-20261007/verification.json`.
  The minimal admitted-work drain is now frozen before final publication/
  disconnect; **13 existing + 5 targeted checks pass**, **0 CLI/native admissions**,
  first errors sticky and deadline receipts monotonic. Final independent closure
  passes **19/19**, **0 remaining findings**, including the original held-read
  reproducer; all owned children close, **0 held gates/watchers/CLI/native
  admissions**. First-error **code** remains sticky; error-object identity is not
  exposed and is not claimed. Review:
  `C:/Users/Admin/AppData/Local/Temp/opencode/slow-supervisor-independent-final-20261007/verification.json`.
  Freeze:
  `C:/Users/Admin/AppData/Local/Temp/opencode/slow-supervisor-p2-final-73LvsH/freeze.json`.
  Current first-v4 disposition records all **7 known PIDs OS-dead** and no matching
  controller command line, but its original controller PID was not recorded; this
  supplies **no historical close ACK**. Those source checks authorize no native
  acceptance. One fresh bounded cleanup-only lineage is now authorized on unchanged
  hashes; acceptance awaits its actual role ACKs. The first attempt remains unqualified.
  Exact 2.0.24 source contracts qualify the restart budget as **per-execution**:
  attempts **1–10** run, attempt **11** terminalizes aborted/releases the claim and
  resets the count. Whole-execution completion resets it; a tool/step completion
  does not. No exposed reset/budget setting is found, and the fixture never writes
  native claim/counter columns. A truthful genuine pending compaction can produce
  native `Complete`/`Succeeded`, followed by a new stable-ID admission, but that
  does not terminate an already held primary context callback; returning the
  callback still dispatches a model request. Finite authorized watcher handover
  and uncertain-ACK recovery remain unqualified, not a permanent session limit.
  Source-contract receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-watcher-budget-contract-20261007.json`.
  The frozen watcher receipt's post-eviction native claim is **non-null, attempt 1**:
  handler/Scope cancellation is not claim settlement. Its additive read-only
  verification does not invent a historical interruption reason.
- A distinct **native daemon-owned adoption** candidate is source-qualified at
  exact `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69`: `@opencode/Job.start` consumes an
  Effect and forks work from the native application-owned Job Scope, not a caller
  supplied/escaped plugin Scope. Use a nonce-bound ID distinct from Session IDs,
  which native execution interruption cancels. Shell/subagent recovery kinds must
  not be fabricated. At due, acquire a fresh short
  `LocationServiceMap.contextEffect` lease with current placement/authority/profile
  checks; retained origin RPC/model/tool/Location services are not admissible.
  Actual ownership/eviction/replacement acquisition/shutdown qualification is
  being implemented in a separate private fixture. Generic Job effects/deadlines
  are **not persisted**; native claim recovery is one bootstrap sweep, not a
  continuous scheduler. Service-owned due-time acquisition still needs fresh
  authority and environment during the same daemon process. Job source: `packages/core/src/job.ts:178–183,
  252–297,478–480`, Git blob `771c5a79722effe0ae48d072b95c68f5f03be0ee`.
  This is source evidence only, not a runtime pass or production activation.
- Native Job qualification remains **incomplete**: the latest invocation times
  out without a returned receipt or owned close acknowledgement. Earlier retained
  failed receipts observe genuine `Job.get: running` after caller closure and
  exact origin eviction, but full-service cancellation is still unqualified.
  Effect `forkIn` owns the fiber lifetime without replacing inherited Context/
  Scope; a fresh scoped due acquisition is **not** the native Job owner Scope.
  Current private lineage/custody and first hung stage are being diagnosed without
  a duplicate invocation, escaped fiber or timeout-based acceptance. No park-claim
  runtime probe is started. Frozen candidate/hash custody:
  `C:/Users/Admin/AppData/Local/Temp/opencode/job-adoption-pending-source-freeze-20261007/manifest.json`.
  All 12 reviewed startup files remain unchanged; production stays disabled.
  Later diagnosis narrows the failed private root to `missions-startup-8L0cbr`:
  one due marker, no shutdown finalizer; retained control flow puts the missing-
  finalizer assertion before an endless cleanup retry, but no exception stack was
  captured. Corrected adapters preserve a pre-opened real Windows exit-handle
  witness independently of qualification failure. **6 regression checks** pass,
  including one actual owned-child handle exit; that child is **not a native
  daemon qualification**. Original native/worker/sentinel close ACKs remain
  unconfirmed. A later single bounded OS snapshot settles **current physical
  custody**: old PID **33912 absent**, **0 private executable/Job-runner candidates**,
  **0 unreadable candidates**, no termination or native service calls. This does
  not supply historical ACKs or graceful Scope finalization. Disposition:
  `.../missions-startup-8L0cbr/current-custody-disposition-1791387938083.json`.
  No replacement fixture/park probe had run in that receipt. New source/receipt freeze:
  `C:/Users/Admin/AppData/Local/Temp/opencode/job-exit-handle-correction-freeze-753XQR/manifest.json`.
  Current residue must be reconciled by exact owned identity; PID absence or a
  newly observed exit must never retroactively become an old Scope/fork ACK.
  Exact native Windows stop source explains the finalizer mismatch: CLI stop
  best-effort shuts down persistent PTY, then `Service.stop` sends `SIGTERM`, polls
  PID existence/escalates to `SIGKILL`, and removes unchanged registration. It
  does **not** request or await application Scope closure. Declared Bun/libuv
  Windows kill implementation uses `TerminateProcess`; changing to SIGINT is not
  a graceful fix. The probe executable's embedded Bun build is not independently
  attested by this source review. Preserve the failed graceful-finalizer assertion.
  A separately labeled stock-stop proof may observe native **process-bound Job
  lifetime** through a pre-opened exact exit handle; it cannot claim finalizer,
  descendant-process or external-effect reconciliation. Explicit native Job.cancel
  is a separate generation-scope contract. Embedded SDK.close awaits its own
  runtime Scope but is not a remote-daemon API or target substitute; `serve --stdio`
  cannot be combined with managed `--service`. No public app-shutdown endpoint or
  registration manipulation is added. Source:
  `packages/client/src/effect/service.ts:181–206` and
  `packages/cli/src/commands/handlers/service/stop.ts:10–13`, pinned 2.0.24.
  A separately scoped actual **stock-stop Job run** now completes in **49.8 s**:
  **2 Jobs / 1 fresh acquisition / 1 due marker**, **0 prompts/models**, **0
  Job.cancel calls**. Caller closure and exact origin eviction precede the fresh
  due acquisition; daemon **21136** has a same-handle exit ACK/watcher close,
  sentinel **33948** is preserved then closed, worker **35660** has a fork-close
  ACK/exit **0**. Shutdown finalizer remains **null**: this is native process-bound
  lifetime, not graceful application/generation Scope cancellation or persistence.
  Receipt: `C:/Users/Admin/AppData/Local/Temp/opencode/missions-startup-ygipUx/receipt.json`,
  SHA-256 `41c317a135fc60da5613cb849eb8efb3b8ead1bfdc31a08775b90336ece42da3`.
  Independent review supports that executed proof but finds a custody-retention
  correction, then closes its source with **2 artifact-free checks / 0 findings**.
  **Patched sources did not execute in that native run**. Executed sources and
  corrected candidates stay separately frozen under `job-stock-stop-source-freeze-MYID2v`
  and `job-stock-stop-p2-custody-freeze-we0emD`; one fresh corrected-source run is
  authorized after exact hash verification, no park probe. Review:
  `.../job-stock-stop-p2-custody-freeze-we0emD/independent-review.json`.
  Original failures/ACK gaps and all 12 baseline source hashes remain preserved.
  The exact corrected candidate subsequently passes in **57.8 s**, unchanged
  before/after execution: **2 Jobs / 1 acquisition / 1 marker**, **0 prompts/models/
  Job.cancel calls**. Daemon **41732** has a same-handle exit, watcher **42420**
  closes; sentinel **38660** is preserved/closed, worker **24164** fork-closes with
  exit **0**. Supervisor writes complete for this run, but no separate supervisor
  exit-handle ACK is supplied. Finalizer stays **null**, authority/persistence and
  graceful Scope cancellation unqualified. Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-startup-S3UY5U/receipt.json`,
  SHA-256 `eba3d4bbba86ddb0434e0803008f246670acb53a8384affd1507d64d3ac15a8c`.
  Independent review verifies **12 sources / 12 baseline files / 10 fingerprints /
  15 evidence hashes**; main repeats **2/2 artifact-free entry/custody checks** and
  verifies unchanged hashes. Qualified opt-in fixture committed **`1465793f`**.
  The next healthy-context inactive-claim/cold-reentry probe uses new files only;
  its scope does not include Pause/Stop, full standing authority or production wake.
- Cold-entry scrutiny rejects a specific bootstrap hypothesis: retained
  `missions-startup-JQzXFg/receipt.json` is a **claim-timer** receipt, not an
  independent global-plugin startup. Its restart module/setup hits follow genuine
  native **claim-driven Location acquisition**; its claim-free successor has
  **0 module evaluations / 0 setups** over eight seconds. No caller Location demand
  does not mean no native Location acquisition. Exact configured-plugin import
  chain is Location supervisor → ConfigPluginSource → `PluginModule.load` → source/
  package load. Bun dependency scanning is not evaluation, and `server/tui/rpc`
  metadata exposes no separate startup entrypoint in the inspected contract.
  Thus native self-HTTP credentials alone cannot create an unproved cold entry.
  Public `Service.discover({file})` authenticates but already performs HTTP: signed
  enrollment/path, exact private managed registration/current PID/incarnation and
  loopback endpoint must be checked **before** discovery, then rechecked around
  authentication/adoption. No self-HTTP, startup host or production bootstrap is
  added. The existing native execution interruption/retained-claim path is under
  separate source scrutiny; any inactive claim parking must remain a truthful
  interruption, never claimed success or a fabricated event/counter write. This
  is a concrete entry-contract limit, not a permanent impossibility finding.
- Exact native source supports a **bounded inactive-claim parking hypothesis**,
  not a new API or completed work: `Effect.interrupt` in the awaited primary
  context propagates before model dispatch. With no supplied interruption reason,
  native execution classifies it `Execution.Interrupted(reason:"shutdown")`,
  retains the actual root claim and removes process-local active ownership. That
  classification does **not** mean the daemon shut down. Automatic Location expiry
  selects active owners only; native bootstrap selects non-null **root** claims
  and charges recovery again. Self-parking does not reset the ten-recovery budget;
  attempt 11 releases it. Interrupting an already inactive actor is a no-op and
  does not prove Pause/Stop/revocation. Actual healthy-Location self-parking, native
  Job adoption acknowledgement, cold recovery and genuine finite completion remain
  untested; no fabricated events/counters, model waiting loop or success receipt
  may replace them. Job custody is now settled separately; the healthy-context
  inactive-claim/cold-reentry probe is authorized but has no acceptance receipt yet.
  Separate source review identifies a message-free **private** Core resume path,
  and a public hook `ctx.session.interrupt({sessionID,resume:false})` that records
  actual native **user** interruption without self-joining; direct interruption
  afterward can fence primary dispatch and native settlement releases the claim.
  No public resume/Stop API is inferred. Retirement must first durably fence the
  exact authority generation and cancel its exact adopted Job, then validate
  ownership/placement/environment and unrelated pending work before any guarded
  resume. Empty wake/repurposed compaction inputs/fabricated success are forbidden.
  HTTP RPC application-service context and package/tag access remain private
  contracts to qualify; no retirement runtime proof exists yet. Hook error channel
  is `never`, not an invented typed authorization-denial API. Stock-stop proof
  above does not close this separate lifecycle gate.
  The first private park/cold probe closes **negative in 37.8 s**, independently
  verified: a Windows separator comparison fails **before admission**, **0
  prompts/Jobs/models/interruptions/cold transitions**. Daemon **31196** same-handle
  exit, watcher **17964** close, sentinel **20984** preservation/close and worker
  **42472** fork-close/exit **1** are witnessed; parent writes drain, no supervisor
  exit-handle ACK is invented. Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-startup-qc3AkL/receipt.json`,
  SHA-256 `b797076e473ef6fc4f136c4489a07eb740def45fd783652fa5fae3af7f46d215`.
  Existing exact-path normalization corrects placement without admitting unrelated
  roots; independent correction review passes **6 zero-native checks**. Freeze:
  `.../park-claim-placement-correction-freeze-AMc0z5/manifest.json`.
  One distinct corrected-source native run is authorized after hash validation;
  it is not a replay of the old admission (none occurred). No park/cold acceptance
  is claimed before its receipt and review; the original negative stays unchanged.
  The distinct corrected-source run then closes **negative in 61.4 s** with exact
  hashes unchanged: **1 prompt ACK / 1 healthy hook entry / 1 charged Job attempt /
  0 Job ACKs**. Inner helper-refusal cause is not captured; admission remains
  **unknown/no-replay**, not proven refused. **0 self-interruptions/cold transitions/
  model-HTTP markers** are observed; provider request count was not saved and is
  not inferred zero. Daemon **4596** same-handle exit, watcher **42988** close,
  sentinel **37164** preservation/close and worker **42024** fork-close/exit **1**
  are witnessed; parent writes drain, no supervisor exit-handle ACK is claimed.
  Receipt: `C:/Users/Admin/AppData/Local/Temp/opencode/missions-startup-2iSIoG/receipt.json`,
  SHA-256 `c8382b424ec99b784d256def9722e1456170360390e139fb5217132dd6cc1855`;
  review: `.../park-corrected-native-execution-f7EdCk/independent-runtime-review.json`.
  Retained-source/log diagnosis and bounded private cause instrumentation proceed
  without another native run. Qualified RPC Job adoption does not by itself
  qualify the awaited primary-hook context. Parking/cold continuity remain open.
  Source-only inner-cause instrumentation then passes independent **4 new + 6
  existing zero-native checks**, without reconstructing the old cause. One distinct
  diagnostic run observes the real first failure in **54.8 s**:
  **`Service not found: @opencode/example/LocationServiceMap`**, before this
  attempt invokes `jobs.get/start`. Job callable validation and Core Session lookup
  are not reached; tag presence alone is not adoption acceptance. Counts: **1
  prompt ACK / 1 healthy hook / 1 conservatively charged helper attempt**, saved
  fixture-provider requests **0**, no self-interruption/cold transition. Exact
  daemon **19992** same-handle exit, watcher/worker close, sentinel preservation/
  close and parent write drain are witnessed; no supervisor handle ACK is claimed.
  Receipt: `C:/Users/Admin/AppData/Local/Temp/opencode/missions-startup-KoCYhX/receipt.json`,
  SHA-256 `b103091633cef8a2693dd68bf140b0cba24caf179a68a41b5e34ff47e2697191`;
  review: `.../park-first-cause-native-execution-wjsBK7/independent-runtime-review.json`.
  Earlier admission/unsaved provider count stay unknown. The next candidate removes
  the unnecessary map/Core-Session dependency from **parking-only finite wait
  adoption**, using only the actual validated native Job service and frozen scalar
  fixture identity. No constructed service, retained origin graph or self-HTTP
  fallback is authorized. Source checks/review precede any next native run; fresh
  due-time graph/profile/authority qualification remains separately mandatory.
  The Jobs-only source candidate passes **15 zero-native checks** but its first
  independent review refuses it for **one P2**: clearing Context only inside the
  adopted wait hides services while retaining the caller Context in its restoration
  frame. No active Location-lease extension or eviction failure is inferred.
  Minimal correction restricts the captured `jobs.start` effect **before** its
  internal native fork, leaving the child scalar-only and the caller restoration
  local to admission. Re-review closes **0 findings**, repeats the 15 zero-native
  checks and adapter parsing, and verifies original baselines/prior evidence;
  old-boundary mutation fails the new admission-context assertion. Freeze/review:
  `C:/Users/Admin/AppData/Local/Temp/opencode/park-start-context-source-freeze-uirbZF/independent-source-review.json`,
  manifest SHA-256 `694eb33ceebaf537290d7901c700f94076ce0ed31ad52298989f77672ce9720f`.
  Main verifies six candidate hashes and unchanged baseline12/Job10, then explicitly
  authorizes **one new bounded native parking/cold run** on those exact sources.
  Actual adoption, inactive retained claim, cold bootstrap and role ACKs await its
  receipt/review. Parallel source-only work targets guarded native resume and genuine
  self-user-interruption for Stop; no Stop runtime or production authority is claimed.
- The subsequently corrected shutdown observer accepted `idle_outcome: null` only
  with a shutdown event and an inactive retained claim. One independently reviewed
  bounded native run (**43.647 s, zero findings**) observed one prompt/ACK, two
  running Job ACKs, two healthy shutdown-classified interruptions, inactive eviction
  while the Job remained running, and one cold reconstruction with the same pending
  ID, deadline and claim. There was no second prompt/root demand, provider call,
  model HTTP request, due marker or wait expiry. Receipt SHA-256
  `4346da4e0cff9f577bb8f50a3838057dca8e09066ca8fe23584c809c6e3e5100`:
  `C:/Users/Admin/AppData/Local/Temp/opencode/park-observer-native-execution-KveoLy/Temp/opencode/missions-startup-HLEiWG/receipt.json`.
  This qualifies bounded fixture parking/cold entry, **not** Stop, scheduling,
  standing authority, passage completion or packaged autonomy. The prior `QDipBM`
  observer-negative receipt remains unchanged.
- `32c308a1` fixes actual inline keyed-reorder focus loss and synchronizes the test
  with Kobalte's deferred opening autofocus. **9/9 focused**, both focus cases five
  consecutive runs and independent **9/9 / 0 findings**. The complete no-capture
  replacement **finishes 758 pass / 0 fail / 2 skipped / 0 cancelled**, all **760
  selected cases**, under shell `sh_1163a37f9001cC2EBXji7worPp`. All **2,162 input
  fingerprints remain unchanged** at completion; inputs are in
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-ui-keyed-focus-inputs-20261007.json`.
  Completion check: `.../pr866-ui-keyed-focus-output-20261007.json`. This is ordinary
  Windows renderer/native-fixture evidence, not installed-app or autonomous
  scheduler acceptance, and does not replace the separate hosted CI failure.
- The ordinary-parent production qualifier now includes supervisor/manager/private
  election/full backend/auth and detach/reattach composition. Compile, loader,
  syntax and negative Job probes pass, but the positive path remains unexecuted.
  Independent review found four qualifier defects and two supporting
  client/bootstrap defects; all six corrections are now independently closed with
  **0 remaining scoped findings**. Reviewer checks: **2 owner-control** and **4
  isolated in-process probes**. Author checks: **18 server**, **2 cancellation**,
  native exit-code regression, restrictive-parent refusal and private Cargo compile.
  Separate `a605a070` preserves immediate proof revocation/cookies and one retained
  detach promise; main independently passes **12/12** lifetime correction checks.
  Positive host composition remains unexecuted. Do not promote this
  expanded fixture into native or packaged continuity acceptance.
- Commits in this subsection are local. Hosted run **37613611661** has now
  **completed with failure**, not cancellation, on published `d2a5fddb`: browser
  **757 pass / 1 fail / 2 skipped / 0 cancelled**. Sole failure is
  `header-windows.test.ts:39`, `page.goto`'s **15-second load timeout** before
  shell-badge assertions. It is distinct from the local keyed-focus failure.
  Minimum/latest runtime contracts, three-platform compatibility/pruning and
  Tauri Windows/macOS jobs pass; main server/typecheck/build steps pass. Later
  Linux Tauri steps and build are skipped after the browser failure. Readonly
  root-cause investigation runs without changing the frozen UI aggregate inputs.
  That investigation reproduces both fresh-cache startup failures: first fixture
  compilation and **1,364 unoptimized Lucide imports** stall optimized dependency
  responses while the document is interactive with an empty root. Actual Vite
  `transformRequest` then `waitForRequestsIdle` preparation preserves original
  optimizer settings, readiness and **15-second navigation timeout**: three
  isolated preparations pass with browser loads **2.10–2.18 s**. The header fixture
  also needs the existing owned-cache lifecycle rather than checkout-shared cache.
  The complete Windows aggregate above has now settled with unchanged inputs;
   the targeted owned-cache/preparation correction is now **`35af6332`**. Frozen
   corrected source passes **33/33** complete header cases, **7/7** existing compiler/
   deadline/shutdown regressions and **3 fresh badge repeats, each 1/1**. All original
   test bodies/assertions and the 15-second deadline remain unchanged. Independent
   final review repeats **7/7 setup-hook probes**, closes with **0 actionable findings**
   and confirms all **9 owned cache paths** absent. Receipt:
   `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-header-fix-validation-20261007.json`.
   This is local corrected-source evidence, not current hosted acceptance; the
    completed successful full browser aggregate predates this fixture correction.
- A fresh complete ordinary **no-capture browser aggregate** starts at
  **`9143f347`** after the reviewed header correction, retaining all **2,162 prior
  input paths**. Original command/selector and deadlines remain unchanged;
  `NATIVE_MISSION_CAPTURE` and `NATIVE_MISSION_OUTPUT` are absent. This run is
  independent of the passing server aggregate and ongoing native fixtures; no
  browser outcome was claimed before completion. It now finishes **760 selected /
  757 pass / 1 fail / 0 cancelled / 2 skipped**, **2,510.86 s**, all **2,162 inputs
  unchanged**. Sole failure: `render-cost.test.ts:91`, direct inline Copy click
  intercepted by a header with `data-action-overflow=true` but
  `data-content-overflow=false`, original **30-second** click timeout. The former
  flag denotes menu eligibility, **not measured overflow**. Header startup
  correction is not the failure. Real copy/hover
  root diagnosis is active; no forced click, skip or timeout increase is allowed.
  Result: `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-ui-header-complete-output-20261007.json`.
  Inputs:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-ui-header-complete-inputs-20261007.json`;
  log: `.../pr866-ui-header-complete-20261007.out`;
  job: `sh_11714504d001OxNqANpQB4yJfM`.
  Unchanged focused render-cost/task-copy files pass **26/26**; no source edit or
  root-cause conclusion follows. A viewport-only probe at **1100/512/390/240 px**
  retains the fixture's fixed **1000 px main / 952 px header**, measured overflow
  false and pointer-accessible Copy; resize-back preserves mounted shell/scroller,
  disclosure and scroll position. Private caches close/remove successfully.
  Receipts: `.../pr866-render-cost-negative-output-20261007.json` and
  `.../pr866-render-responsive-output-20261007.json`.
  Fine-pointer CSS hides Copy hit-testing until parent hover/focus. The middle-
  gesture/autoscroll hypothesis is **not reproduced**: **4 fresh samples (2 original /
  2 Escape-only)** preserve original assertions/deadlines and pass. Routing prevents
  middle pointerdown before compatibility mousedown; capture and all-scroll cursor
  clear on release, Copy remains accessible through focus-within, Escape changes
  no measured state. Same scroller/scrollTop survive. Receipt:
  `.../pr866-render-middle-output-20261007.json`.
  The missing fact is the failed page's hover/focus/capture state. Minimal bounded
  **failure-only diagnostic capture** is being prepared without changing actions,
  assertions, deadlines or production CSS, and must preserve the originating error.
  No Escape patch or inferred responsive-menu fix is applied. The complete failed
  aggregate remains unsuperseded.
  Failure-only instrumentation is now frozen in `render-cost.test.ts` (**442
  lines**), with **27/27 focused checks**, UI typecheck and diff check passing.
  All **16 original bodies/copy actions/assertions/deadlines are unchanged**;
  the extra actual-wrapper check preserves the identical originating Error through
  successful and failed snapshots. Capture uses a page-local **64-event passive
  ring**, a caught-failure **2-second** deadline and **32 KiB JSON** cap, without
  altering pointer routing, hover, focus or scrolling. It is **not a root fix**.
  Independent review closes **0 scoped findings**, repeats **27/27 + 3/3 edge
  checks** for timeout/logger/size, confirms identical error preservation and
  pending evaluation drain on owned-page close. **7 browser processes / 7 caches**
  close/remove after shutdown, no open pages/listening fixtures. Review:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-render-diagnostic-independent-20261007/verification.json`.
  Diagnostic committed **`82c7644e`**; original failed aggregate and unknown root
  are unchanged. The fresh full ordinary no-capture aggregate completes at that
  commit with **2,162 inputs unchanged**, all earlier paths retained and **one extra
  persistent wrapper check**: **761 selected / 757 pass / 2 fail / 0 cancelled /
  2 skipped**, **2,480.61 s**. Preferences locator in `mission-control.test.ts:179`
  expires at original **15 s**; `mission-navigation.test.ts:62` navigation returns
  **`net::ERR_NO_BUFFER_SPACE`**. Copy and its persistent diagnostic check pass in
  this run; no failing Copy state was captured, so its old root is **not resolved**.
  Disjoint diagnosis preserves both new failures and the previous aggregate;
  no retry, skip, forced action or increased deadline is applied. Result:
  `.../pr866-ui-diagnostic-complete-output-20261007.json`.
  Navigation diagnosis leaves root **unknown**, with no retries or repository
  changes: **1/1 + 23/23 + 1/1** fresh cases pass. Each page observes **1,364
  uncached Lucide resources**, peak queued/outstanding requests **1,450**; the
  whole file accepts only **161 connections**, maximum **7 open sockets**. Request
  fan-out is not proven socket exhaustion. All **25 contexts** close, server
  sockets/unfinished responses drain and three caches disappear after shutdown;
  some CDP terminals are absent before context detachment, so full browser-body
  drainage is not independently asserted. Vite's port-0 default resolves to the
  actual listening 5173; no bind-collision cause is demonstrated. Chromium's
  `WSAENOBUFS` mapping explains the category, not the failed operation/resource.
  Report: `C:/Users/Admin/AppData/Local/Temp/opencode/mission-navigation-network-20261007/result.md`.
  Bounded failure-only owned-request/socket capture and original-error-preserving
  setup cleanup are approved next diagnostic work, not a root fix or network retry.
  Preferences diagnosis **reproduces a fixture race** twice without request
  failures: config/document language is ready while `fixtureText` still yields
  English `Preferences`, then the dictionary changes the DOM to `Préférences` and
  the captured English locator expires at the unchanged 15-second deadline.
  Only `mission-control.test.ts` changes: wait for the expected localized button
  plus one held-French-import regression; original actions/assertions/deadlines
  remain. Author **22/22**, UI typecheck/diff check pass; removing only the readiness
  wait fails the regression. Independent review validates the locale fix and repeats
  **22/22**, but withholds closure for **one P2** in the new held-import test:
  gate release can precede page close while its admitted handler is still pending.
  Initial review:
  `.../pr866-mission-control-independent-20261007/verification.json`.
  Receipt: `.../pr866-mission-control-final-output-20261007.json`.
  The release → native `unrouteAll({behavior:"wait"})` → close correction then
  closes that **P2 with 0 remaining scoped findings**, **23/23 independent cases
  + 1/1 secondary-error check**. Removing only the locale wait and only native
  route drainage produces **one expected failure each**. The actual failure-path
  probe observes handler settlement while the page is open, before closure;
  secondary cleanup failures preserve the exact initiating Error object. Handler
  errors fail closed. All **11 frozen inputs unchanged**, **6 browsers / 6 caches
  closed/removed**, **0 held routes**. Main verifies hashes and UI typecheck.
  Commit **`7407d303`** changes only this test; all **21 original cases**, actions,
  assertions and deadlines remain, with two new held-import cases. Final review:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-mission-control-p2-independent-20261007/verification.json`.
  Touched-test size warning: **1,213 lines**, no size-only refactor is performed.
  Navigation failure-only capture is also prepared in `mission-navigation.test.ts`
  (**300 lines**): **24/24** author checks, all **23 original bodies byte-identical**,
  plus one real document socket-close custody check with two subcases. That fault
  produces **`ERR_EMPTY_RESPONSE`**, **not NO_BUFFER_SPACE**. Logger/writer throws
  and stalls preserve the exact original navigation Error; held gates settle before
  owned page/context close. JSON is bounded to **32 KiB / 16 packets / 2 seconds**;
  client phase/cache explicitly remain unknown. Owned server sockets/responses
  drain and cache absence is verified. Independent source/actual Chromium review
  closes **0 scoped findings**, repeats **24/24 in 49.2 s** with unchanged hashes
  and originals, verifies gate-before-close and optimizer shutdown/cache removal.
  **Proof limit:** no-effect stalled promises do not prove real aborted filesystem
  writes settled; optional local diagnostic files may be partial/later-settling.
  Commit **`9fab2293`** is diagnostics/setup-error custody only, not acceptance of
  the historical resource failure. Review:
  `.../mission-navigation-custody-20261007/independent-review/review.md`.
  Evidence:
  `C:/Users/Admin/AppData/Local/Temp/opencode/mission-navigation-custody-20261007/`.
  The fresh full ordinary **no-capture** aggregate completes at **`7407d303`**
  after both independent closures. All **2,162 prior input paths** are unchanged;
  only the two reviewed test inputs changed since `82c7644e`. **764 selected cases**:
  +2 held-French-import cases and +1 navigation custody case, no original
  removal. Result: **761 pass / 1 fail / 0 cancelled / 2 skipped**, **2,450.58 s**.
  Sole failure is `interruption-dock.test.ts:56` fixture readiness (case at line 231),
  original **15-second** deadline, before request/badge assertions. Original command,
  assertions and deadlines remain; both external native capture variables are absent.
  Result: `.../pr866-ui-localized-complete-output-20261007.json`. Inputs:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-ui-localized-complete-inputs-20261007.json`;
  log: `.../pr866-ui-localized-complete-20261007.out`;
  job: `sh_117a205a7001O2qz65PqXBWjI8`.
  Six bounded original-case observations do not reproduce that startup failure.
  A failure-only dock diagnostic candidate is retained **uncommitted/unreviewed**;
  original readiness conditions/deadlines and all 17 bodies remain. Its 17 originals
  pass, but its new diagnostic initially fails before a ledger metadata correction;
  later individual checks do not constitute a fresh full-file pass. No root fix or
  aggregate retry is claimed. Evidence:
  `.../pr866-dock-diagnostic-final-output-20261007.json`.
  Following the user's priority correction, browser diagnosis is secondary and no
  new full aggregate is launched; work proceeds on native parking/cold/Stop gates.
  Earlier failed aggregate inputs/log:
  `.../pr866-ui-diagnostic-complete-inputs-20261007.json` and
  `.../pr866-ui-diagnostic-complete-20261007.out`;
  job `sh_1175ae07e0017YiAg4Muj2zW5n`.
  Focused inputs/result:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-render-diagnostic-final-{inputs,output}-20261007.json`.

### Current independent recurrence/native receipts

- Unactivated recurrence core: 22 tests and original-probe independent closure,
  zero remaining scoped findings after correcting no-variant models, an end-of-day
  DST gap and watch removal/re-add. Stress: 64 KiB config, 64 maximum cursors,
  30 maximum reference receipts with rollover; 194,067 / 262,144 bytes. This does
  not qualify a scheduled native admission, a model's publication permissions or
  an indefinitely repeated one-shot Mission journal.
- Fresh actual OpenCode 2.0.24 trajectory: eight gates pass with native parallel
  siblings, real grandchild, native returns observed before business readout and
  unchanged native subagent contract. Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-native-trajectory-LPKoMj/receipt.json`.
- Fresh complete native fixture on published `3250150b`: 16 gates pass, no
  failed gates or recorded failures. Covers exact selection, native declarations,
  fresh environment, busy/idle readout, outbox restart, targeted recovery, lifecycle,
  optional cleanup and native transcripts. Its explicit reload/registration remains
  distinct from unattended cold scheduled wake. Receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/missions-native-mXFfsa/receipt.json`.
- Production Windows qualification: native release build/loader pass; first
  independent birth refuses `native-parent-job-forbids-breakaway`, parent flags
  `0x2000`. One attempt, exact owned sentinel preserved and then torn down. No
  backend/manager/service starts. This records the harness boundary, not successful
  continuity. Repeat from an authorized ordinary Windows parent before proceeding
  through its own retained-backend qualification, not as a gate for native-plugin
  scheduling. Packaged Electron/Tauri service-lifetime parity remains separate. Current receipt:
  `C:/Users/Admin/AppData/Local/Temp/opencode/recurring-continuity-native-dNXg3q/qualification.json`.
- Fourteen actual Tauri cross-host tests pass, including both historical hosted
  failures. Test-only probe duration/exit diagnostics are added; no production
  deadline, retry or unknown-owner authority is changed.
- Hosted run `37597829768` on `3250150b`: runtime minimum/latest, three-platform
  compatibility, native pruning and Tauri macOS pass. Ordinary UI CI fails because
  the i18n source scanner still opens the removed Settings component. Windows
  fails earlier at positive-loader qualification: its temporary directory uses
  `RUNNER~1`, not the canonical path required by the loader. Both reproduce;
  actual short-directory alias refuses and canonical genuine artifact loads on
  pinned Node 24.20.0. Do not weaken the loader or classify this as a continuation
  pass. Minimal fixture corrections are pushed in `32ee0fc5`: six current
  i18n/preferences checks and the genuine positive-loader fixture with actual
  short-directory TEMP on pinned Node 24.20.0 pass. Production loader is unchanged.
  Both corrected steps pass in hosted run `37599765514` below; that run still has
  separate browser failures and is not complete-product acceptance.
- Run `37599550532` on `32ee0fc5` passed the corrected UI scanner and genuine
  Windows loader, then was **cancelled**, not failed, by a body-edit-triggered
  higher-priority run. The workflow includes `pull_request.edited`. Replacement
  run `37599765514` completed without metadata interruption. Do not weaken or
  remove authorization/event handling to manufacture CI stability.
- Hosted run `37599765514` on `32ee0fc5`: **755 browser passes / 3 failures / 2
  skips**, all 760 selected. All other test jobs pass, including server,
  minimum/latest runtime, three-platform compatibility/pruning and Windows/macOS
  Tauri. Two 390px French checks read English while the dictionary loads; saving
  preferences does not await i18n import. The remaining failure is the mandatory
  external native capture absent on ordinary CI. Logs retained at
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-ci-32ee0fc5-browser-failed.log`.
- Hosted run `37606296146` on `e56cf0c9` is **cancelled**, not a new test
  failure, after publication of the independently reviewed native-baseline
  correction `d2a5fddb`. Other test jobs passed; the interrupted browser step has
  no complete aggregate receipt. Replacement run `37613611661` targets
  `d2a5fddb`; it remains pending qualification. Do not infer green CI from the
  cancelled run or edit the PR body while the replacement is active.
- Targeted browser-fixture corrections: geometry now waits for the actual French
  worktree label, and a held real French dictionary import verifies English while
  pending, translated text after release and unchanged draft. **11/11** focused
  checks pass. No product i18n behavior or timeout is changed.
- Independent capture-boundary review found ordinary discovery incorrectly
  includes externally provisioned replay. It is now explicitly
  `native-mission-integration.qualification.ts` with
  `qualify:browser:native-mission-replay`; all assertions/digest/scope survive.
  Explicit missing capture fails **0 pass / 1 fail / 0 skips**, never claims
  qualification. Audited historical capture passes **1/1** with digest
  `63f3eaf8d8d5aa91b3a46dd9b41d55729f1a72f9d4647d82aa97a854debca3fc`, zero
  page errors/external requests. Fresh output:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-explicit-replay-004c6d9142324c318649b7496b55d448/browser-report.json`.
  Ordinary discovery loses only this external case and adds one held-import
  regression; another complete no-capture aggregate and hosted result are required.
- Complete ordinary browser rerun on `e56cf0c9` without `NATIVE_MISSION_CAPTURE`
  or `NATIVE_MISSION_OUTPUT` finishes **757 pass / 1 fail / 2 skipped**, all 760
  cases selected, no cancellations, 2,373 seconds. Its 2,162 input fingerprints
  are unchanged at completion and retained at
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-ui-no-capture-inputs-20261007.json`.
  Output is
  `C:/Users/Admin/.local/share/opencode/shell/c11b91080a94d4d4d42e330142a991de76325c49/sh_115db55ce001fui5txnQWs9XS7.out`.
  Its sole failure is native Electron emulation reset compared against a stale
  initial renderer viewport (height 911 vs 885), not missing capture or the
  translated composer checks. Preserve this failed aggregate.
- Native geometry probe reproduces the initial reference race in two of five
  fresh launches: `getContentBounds()` already returns 1084x885 with the menu
  visible while the pre-emulation renderer remains 1084x911. Every final reset
  agrees with the unchanged native content dimensions. Exact production emulation
  module and original fixture used; no product or menu edits. Probe:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-emulation-geometry-probe.log`.
  The fixture now reads `getContentSize()` and waits for matching renderer size
  before taking its initial reference. Complete reset equality remains strict,
  timeouts unchanged. Five fresh original regression runs pass. Independent
  follow-up closes at zero findings, audits the original 2/5 race and runs the
  exact corrected test **1 pass / 0 failures / 0 skips**. No menu/product change.
  New complete ordinary no-capture run finishes **757 pass / 1 fail / 2 skipped**,
  all 760 cases selected, no cancellations, 2,446 seconds. All **2,162 input hashes
  remain unchanged** at completion. The native emulation regression passes; the
  sole failure is the keyed overflow-menu focus assertion at
  `tests/browser/mission-list-item.test.ts:295`, now under separate root-cause
  investigation. This failed aggregate remains retained; focused reruns do not
  replace it. Fingerprints:
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-ui-native-baseline-inputs-20261007.json`.
  Output:
  `C:/Users/Admin/.local/share/opencode/shell/c11b91080a94d4d4d42e330142a991de76325c49/sh_1160318d1001u5Jia2stdQ6RFK.out`.
- Independent review of the earlier French/capture seam closes at zero findings.
  Its held-import callback and injected pre-release assertion failure use a
  private Vite cache: eventual French/draft retention and error/owned cleanup pass.
  Explicit missing capture independently refuses before browser launch, with no
  skip. Reviewer probes used Node 25.2.1, not pinned-runtime certification.
- Independent published-head integration review closes at zero findings. Its
  230 focused checks pass without skips: create/journal/durable 90,
  authority/catalog/projection 45, resources/guards 59, outcome recovery 25,
  browser copy 10 and genuine compiled loader 1. This does not close full-product
  or scheduled/headless acceptance.
- Fresh server and UI aggregates completed, with input fingerprints retained.
  The UI run uses an unchanged historical OpenCode 2.0.22 capture for its renderer
  replay prerequisite, with exact capture digest and explicit renderer-only scope;
  this is not a fresh native-pipeline qualification. Post-start fingerprints show
  only two changed source-local fixtures (`i18n/messages/missions.test.ts` and
  `native-binding-positive.qualification.ts`), neither selected/imported by those
  aggregate runs. Execution/browser/server aggregate inputs remain unchanged;
  do not label this as whole-checkout immutability.

### File-size signals (not refactor requirements)

Touched oversized sources: `missions/control.ts` ~1,283, `missions/model.ts` ~827,
`missions/journal.ts` ~553, `opencode/missions-plugin.ts` ~626,
`server/http-server.ts` ~2,451, UI `stores/session-api.ts` ~1,995,
`lib/api-client.ts` ~707, `components/tool-call/renderers/task.tsx` ~577,
Tauri `preferences_window.rs` ~663 and `client_state/cross_host.rs` ~1,559 lines.
`packages/ui/tests/browser/mission-control.test.ts` is ~1,150 lines. These are
existing size signals; no unrelated threshold-only refactor accompanies this work.

## Historical baseline — 2026-10-02

The original `feat/missions-durable-continuity` and
`build/tauri-integrated-20261002-1841-b62f` candidates were preserved. The following
records describe that baseline and subsequent dated corrections, not a claim that
the current branch is still unpublished. PR #673 was merged at the user's explicit
request (`c11847880588c287a4a4dfbc3881f35f92a9415d`), then reverted by PR #831
(`d8f91188536caf49034b1e32f791cd59347e33d4`) after the user identified a wrong-session
request and explicitly authorized an immediate admin revert. The revert was prepared
in a separate worktree; local refactor sources remained intact. At that point no
replacement PR was open; #866 is now the delivery surface. The isolated
integration preserves #792/#829/#830/#793, including the 2.0.22 parent-creation guard.
Performance #824 is separate; these results neither validate nor supersede its worktree.

## Parallel review frontier — 2026-10-03, NOT READY

### Native subsession reassessment — user-directed, decision deferred

The user explicitly requires an end-to-end attempt to reuse native subagent and
recursive subsession workflows before deciding against them. Prior root-only
recommendations are not an established impossibility proof. The 2.0.21 continuity
spike already recommends native children for bounded work; its untested recursion,
restart and authority concerns must be tested on the current isolated runtime,
not promoted from gaps to prohibitions. No architecture verdict is carried forward.

The integrated sources/index become a preserved rollback candidate, including the
delivered B1 correction (independent recheck read-only). Prototype work belongs in
a separate registered worktree and private native homes/databases/providers. The
exercise compares native-first orchestration, a minimal native-tool contract wrapper
and a hybrid only where actual evidence requires it. It must reach real recursive
execution/results, continuation/restart, contracts/dependencies/reports, environment/
permission/ownership and Pause/Stop observations, then an executable integration
prototype with independent verification. Findings are hypotheses until directly
tested; restrictions must be scoped to failing guarantees rather than used to reject
all native children. No installed app/shared daemon/profile state or legacy data is
changed, no replacement PR/deployment is authorized, and no experiment is merged
into the preserved candidate before an evidence-based decision.

At the user's request, four disjoint read-only root reviews ran in parallel, each
with one static-only child at depth two. No child delegated further. They establish
eight new findings, assigned to five disjoint correction owners; heavy combined
validation is deferred until all deliveries and independent closures are complete.

| Track | New finding | Evidence / correction scope |
| --- | --- | --- |
| 1 | P2 foreign-mission completion accepted by stored authority receipts | `missions-track1-80d1f780-a3a1-4685-be17-b55822c97084/REVIEW.md`; authority store/completion invariants |
| 1 | P2 invalid receipt discharges reserved journal capacity | Same report; shared key/mission/intent/target validation in capacity accounting |
| 2 | P2 native Stop-drain renews/bypasses its absolute cutoff | `missions-track2-static-164ed16f-9365-4124-80c8-7e77ff800293/REVIEW.md`; native dispatcher deadline; static finding, runtime regression required |
| 3 | P2 definite lifecycle revision rejection leaves permanently stale retry | `track3-retained-20261003-ceec3ee2/REVIEW.md`; lifecycle component and typed rejection handling |
| 3 | P2 full-content reader truncates valid mission text | Same report; bounded Mission reader, preserving global tool limits |
| 3 | P2 RTL keyboard tab arrows move physically backward | Same report; real LTR/RTL reproduction required before acceptance |
| 3 | P3 missing Turkish shared truncation guidance | Same report; Turkish dependency key/locale coverage |
| 4 | P2 cleanup misses late coordinator movement/location-owner withdrawal | `mission-track4-332cbf3ab78f4bdb8ccab990d9583322/REVIEW.md`; async pre-DELETE admission revalidation |

Track 1 performs two in-memory probes with 42 unchanged hashes. Track 2 is static
only, with 533 unchanged scoped hashes. Track 3 executes one real lifecycle browser
probe and actual reader-function truncation; its original commands/results were
exported afterward from retained tool output, without reruns or original receipt
paths. RTL remains statically established, not browser-executed. Track 4 uses the
generated SDK against private HTTP, observing deletion after coordinator movement
and owner withdrawal; all 101 scoped hashes stay unchanged. Existing closures and
production limitations remain intact; these are not installed-symptom diagnoses.

- Track 4 delivery changes two product files and one focused test: the original
  late coordinator move/owner-withdrawal stimuli now reject with zero native DELETEs,
  while valid cleanup still deletes once. Coordinator identity and both location
  owners are reread on the original connection, followed by refreshed target/child
  guards. All 102 affected tests (42 new), server TS and scoped diff pass. Independent
  recheck closes this P2: original late faults return 502 with zero DELETEs, valid
  cleanup returns 200 with one. All 102 tests, TS and whitespace checks pass;
  three owned hashes remain matching. Native atomicity is not qualified. Evidence:
  `mission-track4-correction-20261003/REPORT.md` and
  `mission-track4-independent-c335f1046b6543f1a43f69dfbdfcc062/REVIEW.md`.
- Track 2 delivery first dynamically reproduces the static defect: actual channel
  closure at three seconds and M exit at seven seconds previously yield late success
  at 7,013 ms. The same fault now returns deadline error at 5,001 ms, with exact
  M/B/descendant containment cleanup at 5,006 ms and an untouched sentinel. Valid
  within-budget success remains at 1,217 ms. The original cutoff propagates through
  waits, exit branches and acknowledgment writes. Thirty-seven Rust tests pass,
  with three qualifications still ignored; both channel controls/nine service cases,
  Clippy, production check and scoped formatting pass. Four native source/helper/
  fixture files change. Independent recheck closes this P2: the same 3s/7s fault
  returns native-runtime-stop-drain-deadline at 5,015 ms and exact containment cleanup
  at 5,022 ms; valid control succeeds/cleans at 1,215 ms. Both external sentinels
  survive. Thirty-seven Rust/three ignored qualifications, two channel/nine service
  cases, Clippy/production check/formatting/diff pass with four matching hashes.
  Timings are observations, not hard real-time promises. No HTTP Stop, independent
  launch or production qualification is inferred. Evidence:
  `native-stop-deadline-correction-20261003/RESULT.md` and
  `native-stop-deadline-independent-4b93cf95-0acb-4729-897b-ab7574f44a9b/REVIEW.md`.
- Track 1 delivery rejects foreign completion reads/state/exact retries without
  callbacks, effects or rewrites (effect count one, write count three, callbacks zero,
  foreign bytes unchanged). At 1,999 physical entries, ordinary append is blocked
  and the legitimate deterministic receipt can use the reserved 2,000th slot. All
  158 tests, including 59 new regressions, server TS and scoped diff pass. Independent
  original-probe recheck closes both P2s with unchanged effects/writes/foreign bytes,
  genuine reserved-slot admission only, and cleanupUnavailable still true for damage.
  All 158 tests, both probes, TS/diff and four matching hashes pass; no production
  qualification. Evidence:
  `missions-track1-correction-44785f6a-dd05-45bd-8786-18459d832ae9/RESULT.md` and
  `missions-track1-independent-39fa2c90-f831-48af-b30b-116122469c81/RESULT.md`.
- Track 3 lifecycle adapter is delivered on the real API path: only one import and
  controlMission call change; creation/edit/deletion/recovery/generic request sections
  stay byte-identical. Actual RightPanel 9/9, helper 3/3 and original remount 1/1 pass
  without private transport substitution. Definite rejection requires explicit new
  current-state actions; uncertain/partial admitted controls retain original identities.
  Earlier conditional passes stay conditional. A mid-validation reader-owner TS2550
  is recorded rather than hidden; reader's final delivery subsequently reports strict
  and UI typechecks passing, pending independent verification. Evidence:
  `mission-track3-correction-50YQHY/actual-api/report.json`.
- Reader/RTL/Turkish delivery keeps full Mission text reachable in 9,000-character
  pages, preserves full-source copy and global shared Markdown limits, corrects physical
  LTR/RTL tab arrows with wrapping/Home/End/focus, and registers the missing Turkish
  key. Focused/three existing regressions and typechecks/diff pass in bounded runs,
  not a relabeled single green full suite. The four Track 3 findings now share an
  independent root lifecycle review and one parallel depth-two reader/RTL child.
  Evidence: `track3-correction-nLLYqw/REPORT.md`; whole-feature acceptance remains open.
- Track 3 independent recheck closes reader content/copy and Turkish guidance;
  physical RTL/LTR direction/focus is corrected, but the focused Hebrew case's
  auxiliary undefined-length page error remains unexplained (main run 7/8, failed
  Shell-mock hypothesis 0/1, observational diagnostic 1/1; all retained). Reader
  verification visits 31 pages/nine sections and matches nine full copies totalling
  228,094 UTF-16 units; cross-page Markdown formatting is not preserved, with no
  inaccessible/lost source established. Strict current graph reports zero diagnostics.
  Lifecycle remains open: hidden certified rejection retains a stale retry, and
  component-local uncertainty disappears on row remount, permitting a different
  revision/request. Both real RightPanel navigation probes reproduce this; earlier
  9/3/1 positives remain valid but do not close the edges. Ownership bookkeeping
  versus display-demand fencing and bounded window-local unresolved intent retention
  are in correction; diagnostic RTL investigation is separate and read-only.
  Evidence: `track3-independent-recheck-20261003-f00e2de7/REVIEW.md` and
  `track3-independent-81a771e18abc/REPORT.md`.
- Bounded RTL diagnostic reproduces the same Hebrew failure with full stacks:
  StatusTab reads items.length after the fixture's HTTP 200 Shell response `{}`
  decodes without the required data array. This is a demonstrated invalid fixture
  contract, not a valid-native-response product defect or a complete timing explanation.
  The sole attempted control fails because its asynchronous readiness predicate is
  invalid; both 0/1 failures are retained. Only a contract-correct Shell mock and
  real observable readiness are authorized for correction, without filtering page
  errors or changing production tabs/Status/store behavior. Evidence:
  `rtl-aux-readonly-52ns3g/REPORT.md`.
- Fixture correction changes only mission-primitives.test.ts: the exact native
  Shell GET returns location and data: [] as required. Hebrew/LTR 1/1 each, full
  primitives 7/7, dictionary 1/1, strict/UI typechecks and diff pass. Focused probes
  observe settled real Shell items: [] and zero pageerrors. Independent focused
  recheck closes the fixture contract with original Hebrew/LTR sequences, real
  settled items: []/loading: false/failed: false and zero pageerrors; strict/UI checks
  pass and 18 scoped hashes remain matching. Two existing EventSource console
  errors per run stay recorded. Historical failures, unknown complete timing and
  production limits remain. Evidence: `rtl-mock-fix-UNdxph/REPORT.md` and
  `rtl-contract-independent-20261003-f00e2de7/REPORT.md`.
- Fresh cross-track integration review finds two additional backend P2s: lifecycle
  projection accepts a noncanonical receipt rejected by capacity accounting, falsely
  settling pending targets/exact retry; report projection accepts a wrong native
  admission ID at the canonical notification key, falsely suppressing recovery.
  Two real-product in-memory probes reproduce this, with valid controls contrasted;
  deterministic correlation must be shared by accounting/projection/retry and damage
  must remain unresolved without receipt overwrite or automatic native replay.
  Corrections are assigned separately from UI. All 2,211 source entries stay unchanged
  in that review and the original staged tree still matches. Evidence:
  `whole-integration-final-696f6032-69d9-4327-ade4-8c1c90da986b/REPORT.md` and
  `FINDINGS.md`. Whole/native production acceptance remains false.
- Lifecycle navigation correction is delivered: exact certified rejection clears
  its owned intent even hidden/disposed, without hidden reads; uncertain operations
  survive remount/navigation in bounded 64-entry window-local memory, without TTL,
  eviction, automatic replay or restart persistence. Capacity denies new admission
  rather than forgetting unresolved intent. Durable pending receipts retain priority.
  Original hidden proof permits only explicit revision-2/new-UUID action after the
  revision-1 rejection (zero hidden reads/demand); unknown remount retains revision 1
  and the same UUID, blocking fresh Pause. Ten new/nine existing browser, seven store/
  three helper unit and one original remount checks pass, with strict graph/UI/diff.
  Failed-before, hydration and intermediate fixture failures remain preserved.
  API/shared helpers/index remain unchanged. Independent recheck closes both P2s:
  original conditions 2/2, deferred-reply probes 2/2, navigation 10/10, existing
  9/9, store 7/7, helper 3/3 and original remount 1/1 pass. Strict/UI checks pass;
  12 scoped hashes remain matching, zero pageerrors and verified cache shutdown.
  Console diagnostics and historical failures stay retained; window-restart memory
  loss is explicit, without native/backend qualification. Evidence:
  `mission-lifecycle-navigation-fix-ULSnZa/report.json` and
  `lifecycle-navigation-independent-20261003-f00e2de7/REPORT.md`.
- Backend lifecycle/outbox delivery shares deterministic receipt correlation:
  damaged lifecycle receipts retain original pending targets and exact retry denies
  further native calls; damaged notifications remain pending/unavailable with no
  further synthetic calls. Corrupt bytes stay unchanged, valid retries keep stable
  IDs. All 187 tests, full server TS/diff and prior 158 guards pass. Targeted original
  reviewer recheck closes both P2s: both original probes, all 187 tests and server
  typecheck pass; 13 monitored source hashes stay matching. The fresh whole-feature
  integration review remains underway; final combined/browser validation waits for
  zero actionable findings. Production qualification stays false.
  Evidence: `missions-lifecycle-outbox-correction-d3572ea9-1f59-4b48-9381-1c9d88566177/RESULT.md`.
  Independent evidence: `lifecycle-outbox-independent-5431bd69-7e45-49a6-876c-a1c8de9cd3ac/REPORT.md`.
  Touched oversized sources: missions/model.ts (~598) and missions/control.ts (~961).
- Fresh whole-feature review is **not zero**: three additional P2s are assigned to
  disjoint owners. U1: deferred openActor/read continuations use mutable instance/scope
  and overwrite newer reader/navigation intent; actual extracted-product-function
  probes reproduce it, while attempted browser setups fail before assertions (network
  buffer exhaustion and invalid Lucide compilation), preserved as failures. N1:
  service policy admits 2,048 environment entries but command preparation permits 512;
  a 513-entry request can acquire a permit then cause fatal no-spawn refusal. This is
  static-established and requires genuine isolated native reproduction/correction.
  N2: final authenticated service body can win an overdue timer race and publish after
  the original deadline; private product probe reproduces acceptance at equality,
  with a before-expiry positive control and zero service starts. N2 is unchanged from
  branch HEAD, a preexisting baseline defect, not introduced by Missions. Remedies
  reuse existing view-generation/intent fencing, actual pre-permit command validation
  and the existing remaining-budget check after await. No fallback or replay.
  All 2,214 non-document entries and staged tree remain unchanged; only the two
  authorized coordinator documents change during this review. Evidence:
  `mission-whole-fresh-69affe0f-f4cf-41a6-a07f-c6c3ad03b9e4/REVIEW.md`,
  `COVERAGE_GAPS.md` and `child-native/REVIEW.md`.
- N2 deadline correction is delivered: existing remaining-budget checks now run
  after awaited observations and before metadata publication. Original deadline
  2,000 accepts clock 1,999, but equality/2,001 reject without metadata publication
  or service starts. Fifty-two affected/ten focused final tests, server TS and scoped
  diff pass. Independent recheck closes N2 with clocks 1,999/2,000/2,001 and
  parsing reaching expiry: only before-expiry accepts/publishes, older same-URL
  metadata stays unchanged. Each uses two mocked CLI calls, one authenticated fetch,
  zero starts/registration reads and zero remaining timers. Ten focused/52 affected,
  server TS/diff pass; five delivery hashes match/nine paths stable. Baseline
  provenance and unqualified native timing remain explicit. Evidence:
  `service-deadline-n2-correction-20261003/REPORT.md` and
  `service-deadline-n2-independent-recheck-20261003/REPORT.md`.
- U1 navigation delivery uses originating view generation and newer intent for
  actor/read continuations, including one shared guard for nested reader navigation.
  Twenty-nine focused browser checks (23 new real-component cases), both original
  conditions, four previous editor probes, UI/server TS/new-test strict/diff pass.
  Three files change; 24 protected files stay unchanged. Independent navigation
  recheck closes U1 with 29/29 browser checks, four original editor probes, UI/server
  and new-test strict typechecks; all three correction/24 protected hashes match
  and stay stable. Earlier editor closure remains intact. Evidence:
  `mission-navigation-u1-20261003/after/REPORT.md` and
  `mission-navigation-u1-independent-4104aebb-d592-45f4-9c3d-2ee84898280c/REPORT.md`.
- N1 is dynamically reproduced before correction: a 513-entry request receives
  permit/send but no starter, then fatal ID-0 response-unconfirmed kills contained
  M/B. Actual command preparation now validates before permit issuance: 513 entries
  and 512 case-fold duplicate keys refuse locally with zero permit/send/spawn, M/B
  survive, and subsequent valid 512-entry execution preserves complete environment
  and inherited-sentinel hashes. Thirty-nine Rust tests/three unchanged ignored,
  two channel/nine response controls, Clippy/production check/scoped formatting pass.
  Stop dispatcher/helper hashes stay unchanged. Independent genuine native recheck
  closes N1: 513 distinct and 512 case-fold duplicate requests both refuse locally
  with zero permits/sends/spawns, M/B survive; subsequent valid 512-entry request
  has one permit/send/spawn and preserves full environment/inherited sentinel hashes.
  Exact owned cleanup is confirmed with the external sentinel surviving until its
  explicit cleanup. Thirty-nine Rust/three unchanged ignored, two channel/nine
  service cases pass; 70 scoped paths/artifact hashes stay matching. Independent
  launch, private IPC and packaged production qualifications remain closed.
  Evidence: `native-env-prepermit-a1320159-f365-4ea6-b64f-8460b8c2b3f9/RESULT.md` and
  `native-env-n1-independent-20261003-f0063/REPORT.md`.
- Next whole integration review is **not zero** with three additional P2s. H1:
  HostLifetime HTTP control response settlement only has a scheduled timer; held-timer
  product probe accepts at 4,999/5,000/5,001 ms instead of rejecting equality/after.
  U2: local Mission navigation ownership does not observe newer ordinary session-list
  selection/browser-preview gestures; exact current product functions reproduce both
  overrides. This is outside U1's closed local Mission-intent scope. B1 (static):
  same-mission wrong lifecycle operation completion can omit authority pending state,
  and canonical mirror projection omits operation/target acknowledgments before
  protected Stop acceptance. Failure-plus-corruption canonical runtime reproduction
  is required; terminal reservation alone is not effect completion. Three disjoint
  owners address absolute response expiry, shared navigation supersession and exact
  lifecycle completion/ack correlation without replay or byte repair. Product's 2,219
  entries/staged tree remain unchanged, with only coordinator documents changing.
  Evidence: `mission-whole-static-db57d176-f7be-4db7-92dd-7a289a703acb/REVIEW.md`,
  probe receipts and `child-backend.md`. Final frozen validation remains deferred.
- H1 HTTP correction is delivered: elapsed 4,999 accepts, equality/5,001 reject
  with host-request-timeout; late callbacks cannot publish success. Timeouts remain
  unknown execution outcomes without replay. Fifteen selected tests, server TS/diff
  pass; N2 hashes remain unchanged. Independent recheck closes H1 with exact
  boundary, parse-crossing and late-callback probes, 15 selected tests, server TS
  and scoped diff passing. Scoped/N2 hashes remain matching; native timing and
  production qualifications remain false. Evidence:
  `host-control-h1-correction-20261003/REPORT.md` and
  `mission-host-control-h1-independent-20261003-f003e1/REPORT.md`.
- U2 delivery observes shared conversation changes through a local epoch, retaining
  legitimate nested navigation without global setter rewrites. Forty-one focused
  browser checks (12 new full-shell gestures and all 29 U1 regressions) plus four
  editor probes pass. One production file changes; 29 protected UI files remain
  matching. Typechecks pass before concurrent B1 backend changes, not a green claim
  for that unfinished newer overlay. Independent U2 recheck closes it with all
  41 browser cases, four original probes and fresh typechecks; three correction/29
  protected UI paths match and stay stable. U1/editor closures remain intact; B1's
  concurrent backend and production qualification are not inferred. Evidence:
  `mission-navigation-u2-20261003/after/REPORT.md` and
  `mission-navigation-u2-independent-be6f6362-263b-4752-9cd4-8dac066b96d7/REPORT.md`.

The preceding two editor/uncertain-guidance corrections are independently closed:
four original probes, 53 browser/28 unit regressions, workspace and new-test strict
typechecks pass. All 23 files remain stable during review; 22 match delivery, with
only the authorized lifecycle API delta and unchanged creation/edit sections.
Whole strict browser typing still has 54 identical
baseline/current diagnostics, not a full green claim. Shared API/editor/locales stay
reserved except the explicitly authorized single lifecycle import/controlMission
adapter delta, whose unchanged creation/edit sections are recorded. Evidence:
`mission-ui-correction-20261002/after/REPORT.md` and
`mission-ui-independent-recheck-b734290e-de1a-4919-bf6d-ffa1bd839eb5/REVIEW.md`.
Unknown-operation retention is
window-memory only; native repair/restart settlement is not qualified.

## Earlier integrated review loop — NOT READY

- The integrated NSIS build and focused validation passed at their recorded source
  receipt. Installed executable SHA-256 now matches that artifact:
  `A682475ED4AE58C5C4A2F2E8DA770407CFF98E48256A9F98F2CEFFA665B78F03`.
  This read-only identity check is not packaged continuity qualification. Build input,
  final fixture-only delta and test limits are preserved in
  `tauri-integrated-20261002-1841-b62f/BUILD_REPORT.md` below the approved temp root.
- All three established findings from the preceding review are independently closed:
  supervisor request-local failure, unattributed Shell projection and killed-peer
  fixture expectation. Final narrow native proof passes 28 Rust tests and all nine
  response cases; the same three qualification tests remain ignored. This does not
  activate the canonical durable composition or close production gates.
- A fresh independent whole-integrated review finds **two new actionable P2s**:
  Mission coordinator/managed-root creation bypasses the shared deletion fence;
  canonical accepted Stop releases the claim required for later map-only Delete.
  Both have private failed-before probes. The first creation correction is not
  accepted by independent recheck: two lifetime gaps remain;
  the canonical Stop correction is independently closed. Creation remains open.
  The canonical defect is not established as the cause of
  the installed cleanup symptom. Evidence:
  `whole-gatekeeper-integrated-222fa1ea-9b10-4cdc-a2c7-3b74910ec403/REVIEW.md`.
- Creation-fence delivery holds the shared physical admission through coordinator
  creation/publication; managed specialists use a narrow authenticated journal-keyed
  creation capability with no rejection fallback. The unchanged original probe goes
  from 200/one native create to 503/zero creates when fence injection is absent;
  the production-wired blocked probe returns 409/zero creates/one identity read.
  Four regressions fail before correction; expanded cases pass 10/10 and the terminal
  owner server scope passes 301/301, with TypeScript/scoped diff checks. Blocked
  specialist creation retains its prepublished dispatch intent for explicit retry,
  but creates no native root/assignment. Independent recheck finds residual gaps;
  this is not
  production durable qualification. Evidence:
  `mission-creation-fence-correction/REPORT.md`. Existing oversized touched sources
  include `server/http-server.ts` (~2,401), `missions/control.ts` (~954),
  `opencode/missions-plugin.ts` (~567) and `opencode/automation-plugin.ts` (~600).
- Creation recheck passes the original blocked case, ten creation tests and 92
  related tests, but seven external probes reproduce two residual P2s. Cancellation
  listeners registered after preparation miss callers that disconnect during the
  await; human/managed roots are still created, and the human map is published.
  A failed native transport is also mistaken for settlement: admissions are released
  before a received native create finishes, so a private deletion snapshot misses a
  root appearing afterward. Thirteen reviewed paths stay owner-matching. Capture
  lifetime before preparation and retain fail-closed admission on unknown settlement;
  a negative lookup alone is not proof of completion. Corrections are delivered
  and in independent recheck.
  Evidence: `mission-creation-fence-independent-f59882ae-621c-41c6-b2ef-c03aac97d9b9/RESULT.md`.
- Creation-lifetime delivery captures cancellation at handler entry and retains
  ambiguous dispatched creation's original physical permit in a bounded operation-
  scoped hold. Neither exact retries, negative/positive GETs nor connection changes
  release it or create another root; managed retries cannot bypass it via a late
  visible root. A validated successful original response still permits release.
  Seven actual HTTP/SDK cases and 317 owner server tests pass, as do server TS/diff.
  Unknown-hold recovery stays closed/unqualified and deletion remains fail-closed;
  no guessed terminal proof or background retry is added. Evidence:
  `mission-creation-lifetime-correction-20261002/REPORT.md` (15 owned source hashes).
- Creation-lifetime independent recheck closes both residual P2s: preparation-time
  disconnects cause zero creates/maps/assignments; lost ACK retains the original
  permit through negative/late-positive reads and exact retries, without duplicate
  creates/assignments. Valid original success releases only after settlement and
  publication; listener cleanup passes. Seven wire cases/eleven added probes/ten
  regressions/98 related tests, TS and diff pass; all 15 owner hashes stay matching.
  Unknown-hold repair/restart persistence stays closed and unqualified. Evidence:
  `mission-creation-lifetime-independent-7897ef28-2ea2-4694-b5a3-fdfc471ce82a/RESULT.md`.
- Canonical Stop→Delete delivery retains the exact claim for terminal-map
  bookkeeping; accepted Delete drops only its reference, never reopens sends.
  Both grantless/adopted cases previously failed `family-claim-lost`; the original
  probe now deletes the map (revision 5→7, writes 9→12, receipt reads 8→12), with
  interrupts unchanged at one and environment/prompt/synthetic/create calls at zero.
  Owner validation passes 153/153 tests and server typechecks/scoped diff. Evidence:
  `canonical-stop-delete-correction-b6b724a1-b99e-4a9e-9497-488953005c2a/RESULT.md`.
  Independent recheck closes this P2: the unchanged original probe, 143 focused
  tests and five independent probes pass, checking exact claims/shared references,
  lost-ACK retries, cancellation and explicit caller disposal. All five correction
  files match the owner's manifest. Evidence:
  `canonical-stop-delete-independent-1d4c1509-8358-42b8-97a5-19d180582392/RESULT.md`.
  No sends/session creation or installed-cleanup causality is inferred; production
  lifetime and private injected-trust qualification remain open.
- That frozen review passes 390 server tests with one POSIX skip, 22 UI units,
  both typechecks, 28 native Rust tests/three ignored qualifications/nine response
  cases and all 12 private durable 2.0.22 gates (`qualified:false`). Its 2,170 source
  entries remain unchanged. Browser subset results are **21 pass/one first-navigation
  timeout**, repeated with private fixture caches. A third instrumented reproduction
  captures incomplete cold module loading at the unchanged 15-second deadline:
  neither DOMContentLoaded nor load fires, the fixture is absent and 1,024 script
  requests remain pending (992 lucide icons). No API/EventSource stall, request
  failure, runtime error or Vite error is observed. Exact historical scheduling,
  eventual completion and host-contention contribution remain unproven. The fixture
  explicitly excludes the icon barrel from dependency optimization. A bounded,
  behavior-preserving fixture-preparation correction is delivered for independent
  recheck; no timeout/assertion relaxation or product change is made. Evidence:
  `interruption-first-stage-aD7wYS/REPORT.md`. Failed loader invocations are retained
  separately and ran no valid scenarios; no green suite claim is inferred.
- Cold interruption fixture delivery prepares the exact static module graph via
  real Vite/Solid transforms before browser creation, with a 30-second setup bound,
  fresh owned caches and no hidden-browser priming, aliases or icon stubs. The
  original 15-second navigation deadline, load milestone and assertions stay intact.
  Three fresh attempts pass (preparation 11.33/12.38/10.43 seconds; navigation-to-load
  5.08/4.83/4.98 seconds), then all seven file scenarios pass. Scoped strict TS and
  diff checks pass; caches are disposed even on deliberate setup failure. Late Monaco
  request cancellations and the failed preliminary preparation experiment remain
  recorded. Full UI typecheck instead reports another owner's in-progress cleanup
  component TS2322; that is not a delivered full-typecheck pass. Independent fixture
  delivery evidence: `interruption-cold-correction-EmYfsn/REVIEW.md`.
- Independent cold review closes navigation: two fresh processes/browsers/caches
  pass (preparation 11,672/10,802 ms; load 4,801/4,928 ms), as do all seven file
  cases. Original deadlines, real Solid/icons, dynamic icon updates and source/draft
  assertions remain intact. However, a real installed Icon.jsx compilation failure
  strands native close with 11 pending transforms for ~440 seconds; identity-checked
  private worker termination is required. This is a failed cleanup probe, not negative
  passing coverage. The setup timeout does not bound optimizer settlement during
  disposal. A shared fixture-only cancellation/drain correction is in progress,
  preserving native close acknowledgement before any cache removal. Evidence:
  `interruption-independent-ERNfMr/REVIEW.md`; historical failures remain intact.
- Focused cleanup investigation independently reproduces loss of the exact explicit
  retry after cancel/remount: a committed tombstone and pending specialist remain,
  but the deleted map disappears from snapshots and the UI loses its retry surface.
  Correctly retained child-bearing roots also lack visible counts/reasons. Existing
  tests pass 31 cleanup server, one editor browser and 14 session-deletion tests;
  four private mocked E2E scenarios establish these missing cases. Generic session
  bulk deletion correctly reports partial failures and is a distinct operation.
  A bounded current-namespace projection and explicit same-request retry are
  delivered; ownership/descendant protection remains unchanged. Evidence:
  `cleanup-investigation-20261002/REPORT.md`. No real sessions were deleted.
- Cleanup delivery survives cancel/remount/reconnect/UI reload via current-v2
  tombstones/receipts; explicit retry keeps the original request/revision/option and
  immutable targets. Lost successful acknowledgements settle through receipt reads,
  without another native DELETE. Counts and redacted retention reasons are displayed;
  unknown/damaged observations never count as completion and no automatic mutation
  retry is added. Owner validation passes 37 server tests, 22 UI units and five
  browser cases, both typechecks and scoped diff. The intermediate TS2322 is fixed
  without suppression. Independent recheck reproduces the normal corrections but
  finds a residual receipt-identity defect. Evidence:
  `cleanup-investigation-20261002/after/IMPLEMENTATION_REPORT.md`. Existing touched
  source sizes include `missions/model.ts` (~591) and UI `lib/api-client.ts` (~678).
- Cleanup recheck independently passes 37 server tests, 22 UI units, five browser
  tests and the original four mocked E2E cases, with all 36 owner hashes unchanged.
  Its additional HTTP corruption probe places a valid foreign-mission receipt at
  the expected target key. Two exact retries falsely return 200/deleted while a
  specialist remains pending; journal readEvent and the receipt shortcut do not
  validate mission/event key identity. The reducer discards the orphan without
  marking cleanup unavailable. No unauthorized native deletion occurs. Scoped
  identity validation and honest pending/unavailable outcomes are delivered;
  foreign records must not be overwritten or treated as completion, and ordinary
  display truncation is not storage corruption. Evidence:
  `cleanup-independent-Y6K96p/REVIEW.md` and `receipt-conflict-http.json`.
- Receipt-identity correction changes five scoped server/test files. The unchanged
  HTTP conflict case now returns 503/cleanup-pending on both exact retries, with
  cleanupUnavailable true and counts 0 removed/0 retained/1 pending. No native
  requests occur after detected corruption and the foreign receipt remains intact;
  actual display truncation still permits valid cleanup. Owner validation passes
  46 server/22 UI/five focused browser tests, both workspace typechecks and scoped
  diff. Independent original-probe recheck closes this P2: both exact retries
  produce the same honest 503/0/0/1 outcome, no native requests and unchanged foreign
  bytes. All five delivered hashes remain matching; 46 server/22 UI/five browser
  tests, both typechecks, diff and additional identity/valid-retry probes pass.
  Evidence: `cleanup-receipt-independent-ygLQFe/REVIEW.md` and
  `cleanup-receipt-correction-20261002/after/REPORT.md`; no production qualification.
- The full integrated browser suite, launched before these corrections, finishes
  **390 pass, six fail, one skip (397 total; 1,542,077.8843 ms)**. The before/after
  receipt records changed sources, so this is a retained non-final mixed-source run,
  not corrected frozen-source validation. Four failures cannot load the missing
  local Electron binary (private dependencies were staged with `--ignore-scripts`);
  the others are device-upload fixture readiness and native timeline thumb ratio.
  The original interruption-dock scenario passes in this run, which does not explain
  or invalidate its separately captured cold-loading failures. Receipt:
  `missions-integrated-browser-QxD727/result.json`; complete output remains in the
  harness shell record. Device readiness and timeline drag have bounded independent
  investigations; no product diagnosis or relaxed assertion is assumed.
- The Electron prerequisite is restored solely in this worktree's ignored local
  dependencies by copying the already present exact version **39.0.0**, with matching
  hashes across 75 files. No download, package reinstall, shared dependency mutation
  or application operation occurs. The four previously blocked test files then
  pass **52/52 tests, zero failures/skips** (192,667.9286 ms), including real isolated
  Electron emulation, guest navigation, native zoom and View menu fixtures. This
  closes the prerequisite failures only, not the full-suite/product qualification.
  Evidence: `missions-integrated-browser-QxD727/electron-prerequisite-receipt.json`,
  `electron-prerequisite-recheck.log` and `electron-prerequisite-recheck.json`.
  Fresh combined validation and another whole-scope review remain required after
  all deliveries and independent correction rechecks.
- Timeline thumb investigation reproduces the exact ratio failure: scroll 14,795
  matches the penultimate interpolated pointer position, rather than the final
  endpoint (which predicts a passing ratio). There are zero application scrollTop
  writes after press, no backwards movement and unchanged extent/transcript top;
  streaming assertions are not reached. Relevant sources match `dev` after line
  ending normalization, but base-runtime reproduction is not performed. A bounded
  native final-input settlement correction is delivered in the test helper only;
  no geometry/assertion relaxation or product change is made. Evidence:
  `timeline-readonly-PJWnjJ/finding.md`; 1,972 monitored files remain unchanged.
- Timeline helper delivery adds six lines: a two-frame barrier bounded to one second
  while the mouse remains pressed, preserving the endpoint, 750 ms hold and all
  geometry/assertions. Both after-probes observe actual native top 15,832 and ratio
  .499842 before release, with no application rail writes/paging/errors and stable
  held/released streaming. Two focused cases and all 21 file tests pass, including
  transcript held-press ownership. UI typecheck/scoped diff pass. Independent review
  closes the bounded finding: two fresh focused runs and all 21 file tests pass,
  recording native top 15,832 in the second frame before mouseup, zero application
  writes/paging/errors, unchanged transcript and stable held/released streaming.
  The 750 ms hold still exceeds the 600 ms intent window. Page disposal rejects
  the pending wait in five ms and the next page has zero native mouse buttons held;
  callers propagate errors and close their owned pages. The one-second timeout
  branch is statically reviewed, but two stimuli do not prove hidden-frame starvation
  and are not counted as timeout evidence. All 22 owned hashes stay unchanged.
  Evidence: `timeline-independent-jJCtc4/`. Base runtime is not tested and the prior
  failed full run stays intact; this is not whole-feature/production acceptance.
  Evidence: `timeline-fixed-summary.md`, `timeline-fixed-focused-evidence.json` and
  the referenced owned focused/full-run directories. The full-file receipt records
  an unrelated concurrent device-fixture change, not a whole-source freeze.
- The device-upload timeout is not reproduced by the one unchanged private-cache
  cold attempt: original byte/order/reset assertions pass in ~15.98 seconds, with
  1,364 Lucide requests, milestones at ~14.5 seconds, settled setup APIs and no page
  errors. The fixture is absent at DOMContentLoaded but present at load. Its default
  shared Vite cache is a separately established ownership gap; a scoped use of the
  existing per-server cache/disposal helper is delivered, without deadline changes
  or a claim that this explains the historical post-goto readiness timeout.
  Evidence: `device-upload-cold-review-igRr1n/report.json`; 12 owned hashes unchanged.
- Device cache delivery changes three fixture/test files, preserving the real
  `{server,url}` contract and all upload assertions/deadlines/optimization settings.
  Closure/draining precedes owned disposal even after setup/listen/browser failures;
  a separately reproduced Vite 5 teardown race requires a fixed second close/drain
  pass. Owner cases pass four lifecycle regressions, the focused upload once and all
  20 file tests, with UI typecheck/MJS syntax/diff passing. Distinct caches, another
  live server and shared sentinel remain intact. Independent recheck confirms these
  narrow properties but reproduces a partial-load native-close stall with 11 pending
  requests beyond 30 seconds, before disposal or the second close. Both wrapper and
  captured original close stall. Four lifecycle/one focused/20 file tests still pass;
  closure is not accepted for this failure path. The shared shutdown correction also
  owns this case. Evidence:
  `device-upload-cache-recheck-93704cc9-a04f-4889-a609-f929fca387a9/REVIEW.md`.
  Evidence: `device-upload-cache-ownership-pnDPtQ/report.json`; intermediate failed
  runs remain preserved and the historical readiness-timeout cause stays unknown.
- With all correction deliveries present, coordinator reruns full server/UI
  typechecks together: both pass. This supersedes the intermediate cleanup TS2322,
  not the historical failed browser results. Final frozen-source validation and
  a fresh whole-scope independent review remain required.
- The next full-browser candidate finishes **421 pass, one fail, one skip (423
  total; 1,534,813.0842 ms)** with twelve changed source entries. It is another
  non-final mixed-source run. The sole failure is the mobile interruption scenario's
  `ReferenceError: join is not defined`, after required imports were removed during
  fixture edits. Restore the imports and strictly check the entire browser test,
  not only the helper (UI tsconfig does not establish browser-test typing). All
  original mobile/locale assertions must stay. The owner is correcting this along
  with shutdown; no frozen-green acceptance or installed-product failure is inferred.
  Receipt: `missions-integrated-browser-iFYcLQ/result.json` and its full shell output.
- Shared fixture shutdown delivery replaces the superseded worker experiment and
  drain-only adapter with an owned-cache optimized-load cancellation hook, actual
  native close acknowledgements and optimizer-context onDispose receipts before
  cache removal. A late audit first found cache recreation after two native closes;
  this failure is retained, not relabeled passing. Final owner validation passes
  seven shared regressions, four upload lifecycle cases, two fresh cold cases, seven
  interruption and 20 upload cases. Entire fixture/test graph strict TS, UI typecheck,
  syntax and diff pass; join/tmpdir imports are restored without removing assertions.
  Eleven final caches remain absent after later processes, with zero pending/waiting/
  active contexts and equal created/disposed context counts. Both original shutdown
  failures are independently closed. This Vite 5 read-only load/context adapter
  does not qualify arbitrary hung user plugin cancellation. Evidence:
  `interruption-bounded-lifecycle-7ICo56/REVIEW.md` and `context-final-summary.json`.
- Independent shutdown recheck reports zero residual findings in this fixture scope.
  The unchanged original Icon failure preserves its error and exits naturally; all
  11 owned waits cancel, and deletion waits another 360 ms after native closes for
  genuine context disposal (2 created/2 disposed, pending/waiting/active zero).
  Actual partial upload loading drains 21 transforms/11 waits without harming a
  live sibling or unrelated sentinels. Seven shared/four lifecycle/two fresh cold/
  seven interruption/20 upload cases pass. Entire-test strict TS, UI typecheck,
  syntax/diff pass; nine manifest hashes stay matching. Twenty independent and eleven
  owner final caches remain absent with no forced termination, global esbuild stop,
  fabricated completion or timed removal. Scope is installed Vite 5.4.21 and these
  fixtures only; unsupported-version coverage is unit-only, arbitrary stalled plugins
  and the historical upload-readiness timeout remain unqualified. Evidence:
  `shutdown-independent-yS1c5Y/REVIEW.md` and `terminal-proof.json`.
- Combined current-source validation passes all seven phases on **2,188 unchanged
  entries**, digest `3d6db08fa363fea3137cacee934547dd657fcdf521633ddb502203010b059841`.
  Both workspace typechecks pass; the selected 45-file server scope passes 312 tests
  with no skips and the selected three-file Mission UI scope passes nine with no
  skips. This scope is distinct from the broader independent 22-unit cleanup review.
  Server/UI/pruning/automation/Missions build passes. Native narrow proof passes
  28 Rust tests/three ignored qualifications and nine response cases; all 12 private
  durable 2.0.22 gates pass with injected trust/qualified false. Evidence:
  `missions-integrated-core-R6Sj3D/result.json`, per-phase logs and before/after
  manifests. The documentation update after this receipt is not a product rebuild
  or a retroactive source-digest change. Fresh whole review/full-browser validation
  and genuine production qualification still remain.
- The next fresh whole-scope review is **NOT READY: two new UI P2s**. A disposed
  create/edit editor still invokes onSaved, and the parent's delayed refresh can
  overwrite an intervening explicit Mission selection even without remount. Three
  real-component browser probes reproduce both asynchronous edges. Separately,
  creation-uncertain's structured code is lost and its 409 is presented as revision
  conflict with close/reopen advice; following that advice starts a different request
  instead of settling the original held operation. A fourth real browser probe records
  this misleading guidance/new identity. Scoped editor/parent view fencing and
  allowlisted localized truthful guidance/draft identity are in correction. No new
  backend hold bypass/native replay is established. All 2,188 reviewed entries stay
  unchanged; independent per-path comparison against core confirms only the two
  documented intervening document updates. Evidence:
  `whole-review-independent-802e9264-7eb1-4504-852f-d5c51471e379/REVIEW.md`.
- The subsequent full browser run finishes **428 pass/one fail/one skip (430 total;
  1,705,525.3182 ms)**. Its sources change during those new UI corrections, so it is
  non-final. The sole failure is session-aside's switch scenario waiting 30 seconds
  for fixture readiness at setup, before generation/switch/result-fence assertions.
  Preceding and following aside cases pass; no cold-load explanation is assumed.
  The bounded unchanged-source private-cache investigation passes the switch case
  once and all eleven file tests once; the historical failure is not reproduced.
  The switch fixture becomes ready ~29 ms after goto, with settled command API and
  no observed page/Vite/outdated-module errors. A forced initialization failure
  instead proves setup leaves its owned page open until final browser teardown;
  body assertions/generation requests are never reached. Default shared cache and
  missing owned shutdown are separate confirmed lifecycle gaps, not demonstrated
  timeout causes. A scoped reuse of cache/shutdown and primary-error-preserving page
  cleanup is assigned, without deadline/prebundling/product changes. Evidence:
  `session-aside-readonly-bH0wKg/report.json`. Receipt: `missions-integrated-browser-gRycuv/result.json`
  and its full shell output. Previous failed receipts remain intact.
- Aside harness delivery uses fresh caches and the existing native context/shutdown
  barrier, cleans up startup failures and closes a failed setup's page after bounded
  diagnostics while preserving the original error object/stack. Fixture/shared helpers,
  API/generation code, deadlines and all eleven scenario assertions stay unchanged.
  Focused 1/1, file 11/11 and lifecycle 11/11 pass with strict TS/UI typecheck/diff.
  The actual forced 30-second initialization probe remains 0/1 expected failure:
  module error is preserved, page closes before propagation and generation stays zero.
  Independent recheck closes this bounded correction: eleven lifecycle/one focused/
  eleven file cases pass, strict entire-test TS/UI typecheck/diff pass and eight
  monitored hashes match. The forced readiness wait lasts 30,013.658 ms, preserves
  its original timeout object/stack and module diagnostics after page closure, with
  zero generation/body execution; it remains an expected failure, not a pass. Two
  native close acknowledgements/2 created/2 disposed contexts precede cache removal.
  A native-close fault retains its cache/error; a broken page-close transport can
  still require owned/browser cleanup, not guaranteed individual page closure.
  Historical timeout cause remains unknown. Evidence:
  `session-aside-harness-fix-wk3M6F/report.json` and
  `aside-independent-G8W92H/report.json`.

## Independently exercised checks

### Current implementation frontier (2026-10-02)

- User explicitly permits dropping old Missions compatibility and asks for less
  UI. New journal/authority namespaces are `codenomad-missions/v2` and
  `codenomad-missions/authority-v2`; legacy bytes remain untouched and unread.
  Automatic migration and `migrateLegacy` are removed. The specialist reports
  90 focused tests and full server typecheck passing. The independent authority/
  storage review and correction re-review are recorded below with zero residual
  findings. Wire/schema version stays 1, signed authorization and Play stay explicit.
- Coordinator reran the actual durable adapter against private OpenCode 2.0.21
  after updating its namespace challenge: all 11 gates pass at
  `missions-durable-J9eV4R/result.json`. This run remains `qualified:false`, with
  private injected trust, not production host provisioning or packaged continuity.
- Native `RuntimeSession` changes the topology: S owns a sole runtime Job, M is
  assigned while suspended and its unchanged Node-spawned B inherits containment
  before execution. The specialist reports 15 native tests and the combined real
  IPC/AuthManager/NativeParent/cleanup proof passing. Three original positive
  qualifications remain pending; restrictive parent Job policy was not changed.
  The old channel-adoption BLOCKED result below describes the superseded topology,
   not the latest combined proof. Product channel and service conjunction have since
   been delivered as described below; no desktop activation or packaging acceptance.
- HostLifetime now consumes the inherited-runtime native capability in product
  code: pre-spawn native gates, pre-AuthManager correlated IPC admission, verified
  outside-peer service bridge, distinct fatal versus drained graceful Stop paths.
  The backend specialist reports 19 focused tests and full server typecheck passing.
  The independent bounded review repeated 60 tests and scoped strict TypeScript,
  then reproduced two issues outside the passing suite: P1 cached JS exports under
  a `.node` path can mint production authority without executing native code; P2
  a valid MAC-correlated reply can settle after its absolute deadline if the timer
  callback is delayed, and child verification resets its observation budget.
  The backend owner delivered corrections: captured native `process.dlopen` into
  a fresh Module (without cache/extension mutations), receive-time absolute expiry
  and one inherited deadline through manager/member observations and pre-auth
  readiness. It reports 28 passing regressions with zero skips, including an actual
  compiled N-API loader smoke test plus the original cache/held-timer probes.
  Independent re-review repeats both original probes and reports zero residual
  findings: 37 tests pass with zero failures/skips, and scoped strict TypeScript
  passes. Cached/hooked text SDKs are rejected before any call without cache
  mutation; a late valid reply publishes nothing, closes admission and reports one
  loss. Delayed manager/member/readiness checks cannot renew an expired budget.
  Both bounded adapter findings are closed; the compiled-loader positive test is
  still only native artifact-loading evidence, not S/Job/service qualification.
  The native owner has now delivered the actual compiled `codenomad.runtime.v1`
  addon and `CNHRv001` sustained channel. It reports 20 native tests passing,
  three original positive qualifications still ignored, an offline build, Clippy,
  helper typechecks and source-hashed combined runner passing. Real CNG receipts,
  private peer/process verification and unchanged M/B Node IPC are exercised.
   Service conjunction is now delivered: single-use exact-request permits, opcode 4,
   suspended owned starters, signed historical receipts and cancellation/expiry/
   manager-death cleanup. Independent bounded review repeats the combined runner:
   26 native tests pass, three positive qualifications remain ignored, with matching
   hashes across 8,751 protected files. This narrow proof retains nested starter
   receipts with `outsideAllJobsBeforeResume:false`; it does NOT qualify the outside-
   all-Jobs pre-resume conjunction. Manager qualification still fails closed.
   Independent launch/privacy audits and packaged hosts
  remain separate pending gates. Exact ABI/wire handoffs are in
  `MISSIONS_HOST_LIFETIME.md` and `MISSIONS_NATIVE_NODE_IPC.md`.
- Protected host-authority staging is implemented in `missions/host-authority/`:
  specialist reports 69 tests, including 25 new ones, and focused strict TypeScript
  passing. Real native attestation, writer quiescence, protected-root provisioning
  and canonical backend coupling remain gates; no permissive policy override.
  Independent review repeated 133 focused tests and server typecheck, finding one
  P2 mismatch: fresh prepared maps with no grant could not sign/accept denial
  intents. Coordinator corrected grantless epoch-zero Stop/delete/revoke while
  retaining terminal receipts, pending reservations and prior mirrored grants.
  Seven new regressions exercise actual protected host files and native core.
  Independent correction re-review reports zero residual findings, repeating 72
  host/core/adapter/storage tests and scoped strict TypeScript. Unsettled new
  durable-host integration modules were deliberately outside this bounded verdict.
- Canonical durable-host composition is delivered in `missions/durable-host/`
  and the normalized human-action helper. It reuses real admission/lifecycle
  routes and protected grants/reservations, adds final signer/root/family fences,
  and retains disabled grants/pending receipts after failed Stop. The specialist
  reports 95 focused tests and strict TypeScript passing. Startup/packaging do not
  yet import it. The receipt-producer gap is now closed: strict native
  `authority.receipt` uses only `store.read`, validates exact scope/digest,
  returns a detached immutable receipt and rechecks disposal. Canonical settlement
  performs two real RPC reads on the same authenticated owned connection, with
  no external receipt-reader callback or intent replay. The specialist reports
  110 tests (95 existing plus 15 new) and full server TypeScript passing.
  Independent bounded composition review and actual private OpenCode receipt-wire
  probes were launched. The actual adapter run on private OpenCode 2.0.21 passes
  all 12 gates at `missions-durable-b5xhYQ/result.json`, including exact receipt
  reads for completed creation, pending vetoed Play and terminal Stop, preserved
  after private location reload. Wire-client mutations never alias native records;
  foreign scope/digest/project and undeclared fields are rejected. The probes
  compare product storage-write counts, durable snapshots/reservations and provider
  requests before/after; none change. Damaged authority still refuses receipt
  reads while independent evidence remains durable. An initial probe run
  `missions-durable-bn809i` failed because it compared snapshot read-time
  `generatedAt`; the fixture now excludes only that timestamp, retaining all
   durable bytes/fields and mutation counters in the comparison. Independent bounded
   composition review repeats 120 tests and server typecheck, but finds P1 loss of
   the originating human-request fence during async RPC effects and P2 already-
   canceled actions publishing protected authority reservations. The owner delivers
   signed-intent-correlated ephemeral human leases and original cancellation through
   protected prepare/sign/accept, native reservation, queue/environment/journal/
   completion checkpoints. It reports 142 expanded tests plus 41 additional
   regressions and focused/full server TypeScript passing. Pre-aborted create/Pause
   preserve exact bytes/state/counts; autonomous grant-backed delivery is separate.
   Independent correction re-review closes both P1/P2 with zero residual bounded
   findings, repeating all 142 + 41 tests without failures/skips and scoped/full
   server TypeScript. Original cookie-loss and pre-aborted-Pause exploits are
   independently repeated, along with detached-JSON correlation, settled-lease replay,
   post-environment-ACK/late-completion fences and unaffected autonomous delivery.
   This is isolated composition/RPC-registration evidence, not qualification of
   cross-process human-lease transport. Real
   NativeS/managed-writer/family capabilities remain
  separate gates; fixture composition is not their production qualification.
- Coordinator corrected visibility-owned demand, canceled hidden trailing reads
  and added native `session.status` invalidation. Recovery buttons now reuse the
  selected coordinator row and existing Work actions; no separate administration
  surface. Seven store tests, UI typecheck and current production build pass.
  The fresh independent bounded UI review reports zero residual findings,
  repeating 17 browser, seven store and seven execution-model tests. Additional
  private probes cover actual recovery wiring, 51-caller coalescing, clear/remount
  fences and rapid visibility changes. Native HTTP observations are fixture-owned,
  not live backend/platform qualification. Existing large-chunk build warnings
   remain. The earlier full `npm run test:browser --workspace @codenomad/ui` run
  completed with 349 passing tests, zero failures and one skipped isolated Electron
  tab-chrome case (350 total, 1,220,428 ms). This is a current suite result, not a
   claim that earlier failures were independently explained or native continuity
  and packaged-host acceptance passed. Its Missions/control/recovery/visibility
  tests all passed; native observations still use deterministic HTTP fixtures.
- The base private product/native fixture passes after the storage-generation
  separation on OpenCode 2.0.21: `missions-native-0wn3lD`. It covers existing
  catalog/queue/environment, explicit targeted recovery without assignment replay,
  report outbox recovery, native idle/outcome boundaries, lifecycle/revision/late
  evidence, optional cleanup and transcript preservation. It still exercises the
  presence-backed entry, not the new protected durable-host packaging.
- Current full server build passes with UI compilation/copy, server TypeScript,
  auth pages and bundled pruning/automation/Missions plugin builds. Existing
  minified-chunk warnings remain. The build uses the current presence-backed entry;
  it does not activate durable-host startup or package the qualified native S path.
- Native foreground child environment is now measured against the real owned
  backend admission route on private OpenCode 2.0.21. Eight capability checks pass
  at `missions-child-environment-aQwHme/results.json`, but qualification remains
  false: roots have distinct cleaned profile snapshots; concurrent children,
  continuation and newly created children instead use the private daemon's startup
  environment. Probes retain only DB/state/auth-presence booleans, never values.
  Structured CallID/parent/child binding precedes the first child provider request;
  permissions/model choice, depth-one interruption and completion after private
  bridge/presence removal pass. These do not repair environment inheritance or
   qualify durable Pause/Stop. Explicit backend-only child-environment admission is
   now measured and independently re-reviewed with zero residual findings within
   fixture measurement validity. Eleven checks and eight syntax checks pass; 89
   provider requests match native model-step counts at `missions-child-environment-a7xZ06`.
   First-model and later HTTP shells agree on fresh cleaned child profiles; denied
   newly born children receive zero model requests. Structured progress supplies
   private fixture trust, not native attestation. Flags remain `nativeInheritance:false`,
   `explicitAdmission:true`, `qualified:false`, `signedLifecycleQualified:false`,
   `productForegroundEnabled:false`. Ordinary upstream subagents remain separate.
- Effective deletion locations: coordinator reproduced default session/Shell/PTY
  writes and root file saves bypassing the deletion fence on real isolated routes.
  All six new regressions fail before correction, then the expanded suite passes
  92 tests. Defaults, owned native resource cwd and root saves now enter the existing
  fence until upstream body/write settlement. Independent bounded re-review reports
  zero residual findings and zero scoped TypeScript diagnostics; private probes
  cover physical aliases, global Forms, unchanged blocked bytes, 404/403 and traversal.
  WSL translation is fixture-controlled; this does not qualify shared family claims.
- Shared service launcher: independent review reproduces an event-loop ENOENT crash
  caused by delayed listener installation. Synchronous immediate observation closes
  the original P1. Re-review finds a P2 contract gap for Promise-returning raw Node
  starters. The owner delivers single-use runtime-checked prepared-starter tokens
  that capture pre-handoff errors/close synchronously, with 24 tests passing and one
  POSIX skip plus focused strict TypeScript/native helper checkJs. Independent
  re-review closes the async ENOENT gap but reproduces a residual P2 with real Node
  children: pre-handoff exit automatically drains unobserved stdout/stderr, losing
  output and permitting 65,537 bytes to bypass the 64-KiB cap. The prepared helper
  now retains/counts both streams from preparation with one continuous observer
  through handoff. The owner reports 31 tests passing, one POSIX skip and focused
  strict TypeScript/helper checkJs passing; real Node regressions cover handoff after
  close, retained output, each 65,537-byte overflow, simultaneous 65,536-byte outputs
  and chunks across handoff. Independent correction re-review closes the original
  P2 and reports zero residual findings in this bounded scope: 31 tests pass, one
  POSIX-only skip, strict scoped TypeScript/helper checkJs and broker syntax pass.
  The exact spawn/prepare/await-close/return-token probes retain output, reject
  65,537 bytes independently per stream, accept two simultaneous 65,536-byte streams
  and preserve isolated ordered concurrent launches without cross-token effects.
  The native helper's demand-driven streams are not established as affected.
  Full-source combined validation must be repeated
  against a fresh frozen snapshot after these source changes.

### Fresh combined validation after corrective deliveries

- `test-host-lifetime-node-ipc.mjs` passes the narrow inherited-runtime/channel/
  service proof after the launcher and human-fence changes: 26 native tests pass,
  three qualification tests remain ignored. Before/after hashes match across
  8,755 protected files: `6b6b21bf0ea9b81c10c1d245e24f201facb7a6709afd12c897cf7078e41bfdda`.
  Independent launch, outside-all-Jobs service qualification and packaged parity
  remain unqualified. This is not an independent whole-refactor verdict.
- Complete server and UI typechecks pass. The full server build also passes,
  including UI compilation/copy and bundled pruning/automation/Missions builds;
  existing large-chunk warnings remain. Durable-host startup stays unactivated.
- The fresh durable native run `missions-durable-u5SDNK` stops before any gate
  because its exact 2.0.21 assertion encounters private OpenCode 2.0.22. Its source
  hashes remain unchanged; the private sentinel is preserved through main cleanup.
  This failure is retained, not relabeled as a passing run. The runner's explicit
  qualification target is now 2.0.22 (#830), without changing the product minimum,
  dependency pins or installing/restarting a runtime. The fresh 2.0.22 run at
  `missions-durable-Gr1nrL/result.json` passes all 12 gates with zero blockers,
  unchanged monitored product hashes and a preserved private sentinel. Independent
  repetition at `missions-durable-Zxgg50/result.json` also passes all 12 gates on
  actual 2.0.22, matching all nine monitored hashes with the coordinator run. Receipt
  probes preserve native write counts, authority state, mission snapshot and provider
  counts, and detached returned mutations do not alter stored receipts. A read-only
  cross-check of the private fixture database confirms 30 journal events, 10 authority
  receipts (one pending), revoked/sends-disabled authority and terminal Stop, with
  an empty other-project authority partition. The private sentinel's PID/session
  survive main cleanup. Both runs retain `qualified:false` and injected trust;
  nine-file fencing is not a whole-tree/transitive-dependency proof, and targeted
  receipt comparisons are not exhaustive database comparisons around every gate.
- The canonical human-fence independent re-review closes P1/P2 as recorded above.
- The fresh full browser suite finishes with **348 pass, one failure and one skip**
  (350 total; 1,517,603 ms). All Missions/control/recovery/visibility scenarios pass.
  The failure is `git-history.test.ts:278`, "Changes restores independent disclosures
  and Git actions above the staged files": source or target bounding box is null
  before pointer dragging. This supersedes the earlier green snapshot as the latest
  full-suite result. Its cause is not yet established; focused reproduction and
  correction are assigned without treating a successful rerun as an explanation.
- The fresh independent whole-refactor Gatekeeper verdict is **NOT READY**. It
  covers original Missions plus the local durable refactor, actual entrypoints,
  UI, authorization and native modules. Evidence is in
  `fresh-gatekeeper-71ca132e-adcb-4a61-bb6c-7c2e41e3487c/` below the approved temporary
  root. It repeats 143 authority/route/environment/family tests, 187 baseline/host/
  service tests (one POSIX-only skip), 22 UI/model/localization tests and server/UI
  typechecks. An initial UI invocation retained reconnect timers after its assertions;
  only the reviewer-owned runner was stopped and the complete repeat used
  `--test-force-exit`. That incomplete invocation is not counted as a passing suite.
  Two new findings require correction:
  - **P1:** `supervisor_dispatch.rs:55` propagates an ordinary correlated service
    request failure out of the supervisor loop, closing authority and the runtime
    Job. The native owner is correcting request-local rejection while retaining
    fatal channel/ownership/integrity failures. Source tracing establishes the
    finding; a native supervisor-path failure-injection regression is required.
  - **P2:** activity discards unattributed running Shells and displays an idle
    actor with outstanding admission as `idle-without-report`, while conservative
    recovery rejects the same state as busy. Coordinator adds a shared read-only
    Shell-correlation classification to projection and readiness. The original
    regression fails before correction; 38 expanded tests pass afterward, and
    complete server TypeScript passes. Missing/null/non-string/blank correlation
    now leaves idleness unknown without hiding positive native execution, waits,
    background or queued evidence. Independent correction re-review closes P2 with
    zero residual findings: all 38 tests and full server TypeScript pass, and the
    original scenario now returns `unknown` with `recovery-busy` and zero native
    mutations. Sixteen malformed correlation cases and two native families sharing
    a location remain conservative without attributing the other family's child.
    Ownership rejection still prevents descendant/inbox/Shell reads; no resource
    reads are added and scoped hashes are unchanged. Probe/test/typecheck receipts
    are `p2-correction-probes.json`, `p2-correction-tests.txt` and
    `p2-server-typecheck.txt` in the fresh Gatekeeper evidence directory.
  Known production/integration gates remain open regardless of corrected findings.

The table and review history below retain earlier evidence and failures. New
frontier checks do not imply a whole-refactor Gatekeeper verdict.

| Scope | Result | Boundary |
| --- | --- | --- |
| Server/Electron typechecks | Current server check passes after wrapper alignment; earlier Electron check passes | Not packaged native lifecycle |
| UI typecheck/build | Current typecheck and production build pass | Recovery controls now wired in existing rows; existing large-chunk warnings remain |
| Authority core | 23 private tests + current scoped strict TypeScript pass | Crypto/storage-style adapters; real trust provisioning not enabled |
| HostLifetime/auth/Windows ACL/process identity/family claim | 31 private tests pass after lifetime corrections | Real empty full backend and cookie exchanges; injected process-policy fixtures do not prove Windows Job ownership |
| Shared service launcher | 12 pass, 1 POSIX-only skip in focused paired run | Exact private child starter only; no shared daemon |
| Family authority exclusion | 6 private tests pass | Physical Git common-dir key, same-store refs, crash-conservative claim; routes not wired |
| Native descendant activity/readiness | 18 focused tests pass | 32 descendants/66 reads, partial inventory unknown, no sends |
| Missions API/admission/activity/readiness | 35 focused tests pass before latest cursor extension | Exact location/connection/environment fences and classified redacted errors |
| Combined Missions core + HTTP routes | 137 tests pass after denial-byte correction | Durable wrapper and native lifetime qualifications are separate |
| Authority core + durable adapter + existing native setup/reload | 41 tests pass after integration corrections | Genuine setup without presence and mandatory authenticated host transport; native fixture independently repeated separately |
| Actual durable adapter in private OpenCode 2.0.21 | 12 current native gates pass, including read-only receipt wire; previous 11-gate run independently repeated | Real consumption/checkpoints; host provisioning injected and explicitly unqualified |
| Native Windows launch/Job helper | 15 tests pass including inherited RuntimeSession proof; 3 qualification tests pending | Earlier lock correction independently closed; new topology/product transport still needs review and qualification |
| Native HostLifetime / Node IPC seam | New inherited-Job combined proof passes; original channel-adoption topology was BLOCKED | Real IPC retained; independent launch, outside official starter and product packaging remain unqualified |
| Combined Missions/routes/adapter/lifetime/auth/family regressions | 186 tests pass in one run | Includes wire Stop/retry and private native ACL child tests; not packaged desktop or native durable-daemon qualification |
| Browser Missions + targeted recovery, concurrent files | 15 pass, 1 fail | Play/Pause/Stop first-control load timeout; not green acceptance |
| Same browser tests, serial files | 16 pass | Focused replay does not explain/remove concurrent-run failure |
| Concurrent Missions/recovery browser fixtures after cache isolation | Two passes: 16/16, then 17/17 including cache ownership test | Each Vite server has its own temporary optimizer cache, disposed after server close |

Native fixtures exclusively launch the assigned CLI as private `serve` children,
with isolated HOME/config/DB/provider/workspaces and authenticated loopback:

- `missions-native-1osQGf`: native assignment selection/queue, outbox retry with
  and without reload, actual report consumption, explicit coordinator/report
  recovery with exact stable-ID retry causing no extra turn, lifecycle receipts,
  native historical outcome versus queued-input newer idle boundary, cleanup and
  transcript preservation.
- `missions-continuity-xdKlwn`: existing native root/subagent prototype plus real
  product activity projection of an idle parent with active background child,
  and product recovery refusal with `recovery-busy`. Native 2.0.21 next cursors
  are drained even on short nonempty pages; mocks no longer infer pagination end.
- `missions-authority-5RfG1j`: repeated completed authority prototype, not the
  new production authority module integration or a packaged-host qualification.
- `missions-durable-TKZjHq`: delivered actual product-adapter native fixture,
  not a copied authority prototype. Independent rerun `missions-durable-WLcrf7`
  passes all 11 gates on private OpenCode 2.0.21: typed signed effects, real backend
  admission/final checkpoints and provider consumption, bridge detach/restore,
  project-keyed grant isolation, directory fence, disposal and preserved late
  evidence with damaged authority. Both retain `qualified:false`; trusted signer/
  incarnation and protected registry provisioning are private fixture injections.
  Source hashes in the independent run also cover the new shared synchronous guard
  and admission module. The independent sentinel server/session survives cleanup.

The native `continuity-authority-spike` report has now been recovered from the
old map: the specialist recorded three complete 11-gate private runs at
`missions-authority-S9Rb7E`, `missions-authority-0MM6lc` and
`missions-authority-vRZUDO`. This corroborates the prototype only; it does not
close production trust provisioning, old-writer exclusion, migration or native
desktop lifetime gates. No duplicate task or prototype run was dispatched.
The old map still lacks the `mission-activity-ui` report; its queued admission
is not evidence of consumption or completion. Its implementation ownership is
preserved while results are recovered, without resuming Mission orchestration.

These artifacts reside below `C:/Users/Admin/AppData/Local/Temp/opencode/`.
No application/daemon restart, installation, user session deletion or user config
mutation occurred for these checks. The separate user-authorized #673 merge/#831
revert publication did not publish the local durable refactor.

## Independent review loop

- Targeted recovery: three findings (move during async preparation, pending child
  inbox, global native Form) corrected; bounded reviewer recheck closed all three.
  A separate regression now also moves actor/coordinator specifically during the
  final readiness observation. Native reads and admission are not atomic.
- Authority core: two findings (quota can block denial; qualification stale during
  adoption/Play publication). Denial reservation independently confirmed resolved.
  Re-review exposed signer substitution and an ignored async assertion; corrected
  with an immutable exact signature-verified key/scope/generation snapshot,
  immutable receipt fingerprints and runtime-enforced synchronous `true` fence.
  Third independent recheck closed signer findings and found escaped-metadata
  denial-byte under-reservation. Fixed with complete worst-case receipt/terminal
  serialization and saturated-byte revoke/Stop/delete regressions. Independent
  recheck resolved the reserve finding and noted a literal-policy type widening;
  `as const` correction passes the current scoped strict TypeScript check.
  Final independent bounded re-review repeats 23 tests and strict TypeScript,
  reporting zero residual actionable findings in core/protocol/store/admission/rpc.
- Lifetime/family review delivered three findings: repeated Stop can force cleanup
  exit, expired queued native work remains deliverable/drops live work behind it,
  and present falsy malformed ownership records can bypass validation. Corrections
  delivered by the existing real-backend owner: one shutdown command/shared
  completion and release with retained stopping fences; effective native deadlines,
  queue pruning and correlation tokens; strict ENOENT/undefined-only absence.
  The combined 31-test suite passes independently. Re-review closed all three and
  found a delayed-body Stop peer losing its acknowledgement to immediate socket
  closure. Corrected with immediate new-admission closure and bounded existing-peer
  drainage. Two new wire regressions cover late body completion and a continuously
  active never-finished body; the expanded focused host suite passes 13 tests and
  full server typecheck passes. Final independent bounded recheck reports zero
  findings: 13/13 tests repeated, original delayed-body peer acknowledged after
  listener closure, new keep-alive admission rejected, new connections refused,
  continuously dripping peer closed after 5,009 ms. Both private probes retain
  exactly one shutdown command/release, backend exit 0 and stopping fences.
  The review found no additional bootstrap or physical-family-claim issue.
- Activity/session-recovery UI bounded reviewer was canceled without a verdict;
  that review supplies no acceptance or zero-finding evidence. A fresh independent
  read-only reviewer replaces it, without duplicating the unfinished UI owner's
  implementation or resuming Mission orchestration. Replacement review delivered
  three P2 findings: hidden/inactive panels retain Mission demand, native
  `session.status` is absent from activity invalidations, and failed activity reads
  consume the mutable admission idle baseline. The first two remain open in the
  existing UI owner's scope (its report still absent on the inspected map).
  The third is corrected with a separately captured admission idle boundary,
  retained through provisional metadata reads and restored with epoch on rollback.
  List/runtime regressions plus admission/recovery/startup tests pass 50/50;
  current UI typecheck passes. Independent bounded baseline recheck closes that
  finding, repeating 50/50 tests/typecheck and actual-store probes for repeated
  unavailable reads, historical versus newer idle, stale admission races,
   overlapping admission and rollback; zero native mutation calls. This is the
   historical review state. The current frontier above supersedes those first two
   activity findings and recovery integration: corrected and independently re-reviewed
   with zero residual bounded findings. The original specialist's missing terminal
   report remains a separate unresolved record.
- The delivered durable adapter is under a separate independent integration
  review. Two integration findings were corrected: wrapper/core signer-generation
  mismatch now rejects before any reservation through an additional restrictive
  expected-signer pin; shared literal-true guards observe genuine invalid Promise
  rejections without awaiting them or assimilating thenables. The expanded
  41-test authority/adapter/setup/reload run and full server typecheck pass;
  independent re-review repeats both checks and reports zero residual actionable
  findings in the bounded integration, with negative generation/key/profile/root
  and missing-trust probes causing no writes or effects. The actual adapter's
  native fixture is now delivered and independently repeated (11 gates each).
- Native Windows Rust helper is delivered under `packages/native-host-lifetime/`,
  separate from Node/product packaging: suspended native launch, retained-handle
  PID/FILETIME/private-pipe proofs and manager-owned kill-on-close backend Jobs.
  Specialist reports 8 passing tests and 3 explicitly pending qualification tests.
  This execution host's parent Job forbids breakaway: UI-Job survival cannot be
  qualified here and its policy is not weakened. Independent native-source review
  repeats those checks plus offline Clippy/library check and finds one mutex-scope
  defect: potentially blocking backend creation/cleanup delays the manager-death
  watcher's closure of the sole backend Job. A private lock-dependency probe
  confirms this, not a reproduced native CreateProcess hang. Correction is assigned
  to the existing native owner and is now delivered: creation and blocking cleanup
  outside the lock, borrowed assignment/resumption proof with fresh native gates,
  and child extraction only after unlocking. Four regressions confirm running
  backend/descendant Job closure during blocked preparation or cleanup, late
  suspended-child refusal/cleanup and external sentinel survival. Coordinator
  independently repeats 12 passing tests plus offline Clippy and formatting checks;
  the same 3 positive qualifications remain ignored/pending, not green. Final
  independent native-source correction re-review confirms zero findings, mandatory
  post-creation checks and cleanup outside the loan on error paths, no Job-handle
  duplication or re-entrant callback under the loan, and late children unresumed.
  It repeats 12 tests plus offline check/Clippy/formatting; it does not accept
  independent launch, Node IPC, product integration or platform parity.
  Node stdio/IPC/product integration and packaged parity remain closed.
- The bounded Node IPC proof is delivered in
  `scripts/test-host-lifetime-node-ipc.mjs` and documented in
  `MISSIONS_NATIVE_NODE_IPC.md`; coordinator independently repeats its BLOCKED
  result. Real Node IPC correlation, concurrent one-shot AuthManager proofs/revoke,
  NativeParent, graceful shutdown and fatal disconnect/EOF controls pass, alongside
  the separate 12 native tests/3 pending qualifications. Their conjunction is not
  proved: native IPC handle/fd inheritance and actual Node channel adoption before
  assigned backend resumption are missing. No fake ChildProcess/channel, second
  auth protocol, retroactive Job assignment or direct-spawn fallback was added.
  The independent run verifies unchanged source hashes across 8,677 source/assets
  files. An explicit-disconnect branch observes child exit but not aggregate close;
  it is not promoted to a graceful-close receipt. See the documented typed next
  seam and pending pre-resume IPC DACL/peer/backpressure qualification.
- **Historical whole-refactor Gatekeeper verdict: NOT READY.** Its original P1/P2
  and subsequent peer-loss fixture finding are now independently closed. The latest
  integrated review and remaining actionable findings are recorded at the top of
  this document. A bounded zero-finding review never substitutes for native
  qualification or full acceptance.

## Native release gates and retained historical backend track

Items 3 and the backend detach/reattach part of item 5 below belong to the
separate, non-activated host-lifetime experiment, **not** the OpenCode-only
Missions release gates. The current target is the live PR #866 description.

1. Real host signer provisioning/rotation, protected grants, multi-profile map
   distribution and managed old-writer/downgrade exclusion.
2. The private durable native adapter and typed signed effects are implemented,
   with no presence following and no native send fallback; existing desktop rollout
    is unchanged. Bounded integration review and private native adapter validation
     are complete; protected provisioning and native admission wiring remain
    required. New agent-created
   roots and managed-session cleanup are deliberately denied in this adapter.
 3. **Historical backend track only:** native independent launch, manager-owned backend containment and persistent
    official service starter, with no shared daemon in backend cleanup.
     The inherited-Job topology closes the combined real-IPC proof frontier, not
     the independent launch, sustained private product channel, outside starter
     or packaged-platform gates. The superseded channel-adoption path is not used.
4. Protected claim-root provisioning and shared participation of actual admission
   and family mutation routes; conservative crashed claims need explicit repair.
 5. Electron/Tauri packaged OpenCode-plugin and UI parity remains unqualified.
    Private backend detach/reattach/quit/update/session-end fixtures and the exact
    macOS process-start identity are separate historical host-lifetime gates.
6. Packaged/native UI qualification. An earlier full browser suite passes 349
     tests with zero failures and one skipped Electron tab-chrome case; the fresh
     full suite instead has 348 passes, one Changes drag failure and one skip, as
     recorded above. Recovery
    controls are wired into existing rows and independently reviewed with zero
    residual findings. The earlier concurrent
   first-load failure reproduced in the other fixture before cache isolation;
   per-server temporary caches now pass two concurrent runs. The ownership
   regression covers unique caches and exact cleanup. A shared Vite optimizer
   race is the working explanation, not an independently captured network trace;
    race explanation remains unproven; native lifecycle/platform qualification is
     still required independently of historical green browser snapshots; the latest
     integrated full run is non-final and has six failures, recorded above.
7. Background native subagent Pause/Stop fencing: parent interrupt alone permits
   a late child notification to wake it. No recursive-suspension promise or
    background Mission enablement until this contract is qualified.
   Foreground child inheritance is also unqualified: actual children use the
   daemon startup environment rather than CodeNomad's cleaned root profile. An
   explicit child-admission seam must be measured and protected by real durable
   lifecycle/ownership fences before a Mission child execution mode is offered.
8. Final combined isolated/native/browser/build validation and independent fresh
   Gatekeeper corrections/re-review until zero findings over the COMPLETE scope.
