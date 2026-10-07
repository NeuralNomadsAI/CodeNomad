# Missions refactor: integration qualification record

## Current delivery index — 2026-10-07

The reintroduction is open in [PR #866](https://github.com/NeuralNomadsAI/CodeNomad/pull/866),
on `missions-native-subsessions-20261003`. Its feature-first delivery contract is
[`MISSIONS_PR_DESCRIPTION.md`](MISSIONS_PR_DESCRIPTION.md). It remains open and
unmerged; published source, local corrections and planned recurrence are distinct.
The whole integrated product is not yet accepted. Do not promote the historical
results below into current-source or installed-app qualification.

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
- New complete server aggregate: **2,279 pass / 0 fail / 8 skipped**, no
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
  resource integrity and detach prototypes are not packaged persistent-launch or
  cold-Location recurrence qualification. New isolated checks must keep those gates
  separate, including fresh environment, restart and no admission replay.

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
  through cold native wake and packaged Electron/Tauri parity. Current receipt:
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
- Complete ordinary browser rerun is launched without `NATIVE_MISSION_CAPTURE`
  or `NATIVE_MISSION_OUTPUT`. Its 2,162 input fingerprints are retained at
  `C:/Users/Admin/AppData/Local/Temp/opencode/pr866-ui-no-capture-inputs-20261007.json`.
  Output is
  `C:/Users/Admin/.local/share/opencode/shell/c11b91080a94d4d4d42e330142a991de76325c49/sh_115db55ce001fui5txnQWs9XS7.out`.
  Result is pending; do not infer it from focused checks or the older aggregate.
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

## Release/integration gates still open

1. Real host signer provisioning/rotation, protected grants, multi-profile map
   distribution and managed old-writer/downgrade exclusion.
2. The private durable native adapter and typed signed effects are implemented,
   with no presence following and no native send fallback; existing desktop rollout
    is unchanged. Bounded integration review and private native adapter validation
    are complete; protected provisioning and backend admission wiring remain
    required. New agent-created
   roots and managed-session cleanup are deliberately denied in this adapter.
3. Native independent launch, manager-owned backend containment and persistent
    official service starter, with no shared daemon in backend cleanup.
     The inherited-Job topology closes the combined real-IPC proof frontier, not
     the independent launch, sustained private product channel, outside starter
     or packaged-platform gates. The superseded channel-adoption path is not used.
4. Protected claim-root provisioning and shared participation of actual admission
   and family mutation routes; conservative crashed claims need explicit repair.
5. Electron/Tauri packaging and real private detach/reattach/quit/update/session-end
   fixtures, plus exact macOS process-start identity. No desktop enablement yet.
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
