# feat(missions): reintroduce native coordination with durable authority

Prepared full reintroduction description; no replacement PR has been published.
The preserved refactor is now integrated with `dev` at `394482f9` in a separate
uncommitted worktree. Update validation at publication after the remaining
corrections/checks. This is not a readiness verdict.

## Summary

- Reintroduce the complete Missions feature, not a follow-up dependent on #673.
  #673 was merged, then reverted by #831 at the user's explicit request. This
  change includes both the original user-facing feature and the local durable refactor.
- Coordinate native OpenCode V2 sessions through a project-scoped durable task map,
  declared dependencies, roles, reports and evidence, without a second workflow engine.
- Provide bounded custom, Pocock bug-fixing and Wayfinder exploration playbooks.
- Keep native execution, durable plan state and authorization separate; preserve
  evidence without interpreting admission or historical outcomes as completion.

## User-visible behavior

- The right-panel Missions view presents objectives, Work, attention, Reports,
  Conversations and History, with dependency edges and inline reader/session actions.
- Explicit Play/Pause/Stop use durable lifecycle intents and per-target receipts;
  unresolved controls remain visible and require an explicit retry.
- Targeted recovery reuses the selected coordinator row and existing Work actions.
  It asks for inspection or a missing report, never replays the original assignment.
- Activity reconciles actual native execution, bounded descendants, inboxes,
  Forms, permissions and Shells. Missing observations remain unknown, not successful.
- Cached display snapshots survive transient failures. Hidden panels release demand;
  reconnect and native activity invalidations trigger authoritative reconciliation.
- UI strings use the existing locale system and shared square-corner window chrome.

## Architecture and safety

- OpenCode owns execution, native inboxes and results. Missions owns contracts,
  dependencies and evidence. CodeNomad owns authorization and human intervention.
- Native roots are the supported Mission actors. Roles are independent of native
  agent/model/variant IDs; queued work never switches a busy actor's selection.
- A native plugin persists the journal/map, injects context and exposes bounded
  coordinator/actor tools and typed RPC. Automation remains separate from Missions.
- The durable adapter uses signed, scoped intents and an authenticated backend
  transport. It has no direct native-send fallback when authorization is unavailable.
- Per-send admission reads the complete fresh execution-host profile, validates
  native ownership/connection/location and retains mutation fences through effects.
  No profile values travel through the UI or model-facing plugin inputs.
- HostLifetime reuses the full backend, `WorkspaceManager` and existing `AuthManager`.
  Desktop detach, backend Stop and Mission Pause/Stop are different actions.
- Protected host authority, canonical composition and native Windows lifetime/channel
  modules are implemented, but their complete production qualification is still open.
  Startup/packaging do not activate the durable-host composition.
- Notifications for already-saved reports are separate from dispatch. Late evidence
  remains durable after Stop without waking execution or resurrecting terminal state.

## Breaking storage change

No migration or compatibility with previous Missions is provided. New journals use
`codenomad-missions/v2` and authority uses `codenomad-missions/authority-v2`;
wire/schema version remains 1. Old bytes are ignored without reading, importing,
changing or deleting them. Fresh signed authorization and explicit Play are separate.
Namespace isolation does not prove native writer exclusion or session ownership.

## Validation recorded so far

See [the qualification record](MISSIONS_REFACTOR_VALIDATION.md) for artifacts,
source snapshots, correction loops and exact limits. Historical passing runs are
not presented as final validation of the latest sources or current `dev` integration.

- User-requested parallel review on 2026-10-03 uses four root reviewers and four
  static-only children, depth two maximum. It establishes eight additional findings:
  authority completion identity, journal reservation accounting, absolute native
  drain deadline, stale rejected lifecycle retry, reader truncation, RTL keyboard
  direction, Turkish truncation guidance and late cleanup coordinator/owner checks.
  Five disjoint correction owners are assigned; static-only deadline/RTL findings
  require runtime regressions. Heavy validation waits for deliveries and independent
  closures. These do not revoke earlier narrowly established closures or qualify
  production trust/native ownership.
- Parallel deliveries: late cleanup owner/coordinator validation passes the original
  fault controls with zero DELETEs and 102 tests; native Stop cutoff now rejects the
  reproduced seven-second late exit at five seconds, preserving isolated containment
  and within-budget success. Thirty-seven Rust tests pass (three qualifications remain
  ignored). Cleanup admission is independently closed (original fault 502/zero
  DELETEs, valid 200/one, 102 tests, stable hashes); native cutoff is independently
  closed by the original real fault, within-budget control and 37 Rust/two channel/
  nine response cases, with three ignored qualifications unchanged.
  No production acceptance is inferred.
- Authority/journal delivery also passes 158 tests (59 new): damaged foreign
  completions fail closed without rewrites/effects, and invalid receipts cannot
  discharge the legitimate reserved capacity. Both original probes and 158 tests
  independently close these P2s without foreign-byte changes; production qualification
  remains false.
- Lifecycle is wired to its actual typed API (9 browser/three helper/one remount
  cases pass), and reader paging/physical RTL arrows/Turkish key corrections are
  delivered. Reader and Turkish findings are independently closed, RTL direction is
  correct with an unexplained auxiliary page error retained. Lifecycle recheck finds
  two navigation edges: hidden certified rejection retains stale retry, and remount
  loses uncertain identity. Both are in correction; the lifecycle adapter's
  creation/edit/deletion/recovery/generic-request sections remain unchanged. Earlier
  conditional transport passes remain explicitly conditional.
- The auxiliary RTL error is reproduced in StatusTab with an invalid successful
  Shell fixture response missing the SDK's data array. A narrow test-contract fix
  is authorized; historical failures and an invalid readiness-control failure remain
  recorded, with no valid-native-response product defect or complete timing claim.
- The test-only Shell contract fix passes Hebrew/LTR controls, seven primitives,
  dictionary and strict/UI typechecks, with settled empty Shell state and zero page
  errors. Focused independent recheck closes the contract with unchanged sequences,
  settled real state, strict/UI passes and 18 stable hashes. Existing EventSource
  console errors and historical failures stay recorded; timing causality is not inferred.
- A fresh integration review additionally reproduces false lifecycle settlement
  from a noncanonical receipt and false report admission from a wrong native message
  receipt. Shared deterministic correlation/damaged-observation corrections are
  assigned without receipt overwrite or automatic native replay. The reviewed 2,211
  entries and original staged tree stay unchanged; no whole-feature acceptance.
- UI lifecycle navigation corrections are independently closed: hidden
  rejection bookkeeping does not refresh hidden displays; uncertain intent survives
  remount in bounded 64-entry window-local memory (no eviction/TTL/replay/persistence).
  Actual mocked-wire identities, 10 new/nine existing browser, seven store/three helper
  and one remount checks pass, plus both original conditions/two deferred-reply probes,
  strict/UI checks and 12 stable hashes; historical failures stay recorded. No native lifecycle
  or restart qualification is inferred.
- Backend lifecycle/outbox correlation is delivered (187 tests, server TS/diff and
  prior 158 guards pass): damage stays unresolved/unavailable without replay or byte
  overwrite, valid retries preserve stable IDs. Independent recheck closes both P2s
  with original probes, 187 tests, server TS and 13 matching hashes. Fresh whole-feature
  review remains underway before final frozen validation; production is unqualified.
- Fresh whole-feature review is not zero: deferred Mission coordinator/reader
  navigation overwrites newer view intent; native service policy/command environment
  ceilings disagree (static finding requiring actual isolated native proof); and
  final authenticated metadata can publish at absolute expiry (reproduced preexisting
  baseline defect, not introduced by Missions). Three disjoint correction owners are
  active; failed private browser setups remain recorded. Final freeze is deferred.
- Baseline service deadline correction is delivered: before-expiry control accepts,
  equal/after expiry observations cannot publish metadata or start services; 52 affected
  and ten focused checks plus server TS pass. Independent recheck closes N2 including
  parse-time expiry, unchanged older metadata and zero starts/timers; native timing
  remains unqualified.
- Deferred navigation correction passes 29 real-component browser checks (23 new)
  plus previous editor probes and typechecks. Native environment preparation is now
  pre-permit, after actual reproduction of fatal 513-entry refusal; invalid requests
  leave runtime alive and subsequent valid 512-entry execution preserves full env.
  Thirty-nine Rust tests pass with three unchanged ignored qualifications. The
  navigation correction is independently closed (29 browser/four editor probes,
  typechecks, three correction/24 protected stable hashes). Native environment N1
  is independently closed with live-runtime zero permit/send/spawn invalid controls,
  subsequent valid full-env execution, 39 Rust/two channel/nine service passes,
  three unchanged ignored qualifications and 70 stable paths. No production
  qualification is inferred.
- Next whole review remains not zero: late local HostLifetime HTTP ACK, delayed
  Mission navigation versus newer ordinary session/preview gestures, and same-mission
  wrong-operation protected Stop settlement (static, runtime reproduction required).
  Three disjoint corrections are assigned; prior U1/N1 scope closures remain valid.
  No final source freeze, production acceptance, replay or corrupt-byte repair.
- Local HTTP expiry H1 is delivered (15 checks/server TS): equality/late replies
  reject with fixed timeout and cannot publish success. Independent boundary,
  parse-crossing, late-callback and 15 selected checks close H1; timeout still means
  unknown execution, never automatic replay. Native timing remains unqualified.
- Shared-conversation navigation U2 delivery passes 41 focused browser checks (12
  full-shell additions/all 29 U1 regressions) and four editor probes, with one product
  file changed/29 protected UI files matching. Independent review closes U2 with
  41 cases/four probes/fresh typechecks and three correction/29 protected stable
  paths; concurrent B1/backend and production qualification are not inferred.
- The preceding two editor corrections are independently closed: four original
  probes, 53 browser/28 unit tests and workspace/new-test strict typechecks pass.
  All 23 files stay stable; 22 match delivery, with only the authorized lifecycle
  adapter delta and unchanged creation/edit sections. Full strict browser typing
  retains 54 identical baseline/current diagnostics,
  explicitly not green. Unknown-operation retention is window-memory only.

- Private OpenCode 2.0.21 product fixtures exercise queue/selection/environment,
  targeted recovery without replay, report notification, lifecycle and late evidence.
- Actual durable adapter/receipt wire: 12 private gates pass, including read-only
  receipts across reload. Injected trust means `qualified:false` remains explicit.
- Browser suite at its recorded snapshot: 349 pass, zero failures, one skip.
  Fresh UI/server typechecks and full server/UI/plugin build pass after corrections.
  The fresh full browser run has 348 passes, one Changes drag failure and one skip;
  all Missions scenarios pass. A controlled matching row-replacement race is corrected
  in the test and independently closed (focused case, 18 file tests and race probe
  pass). The original scheduling remains unproven; no full-suite green claim.
  Existing large-chunk warnings remain.
- Deletion-fence corrections: all six new regressions failed before correction;
  92 focused tests pass afterward. Independent bounded re-review reports zero
  residual findings, including default locations, native resource cwd and root saves.
- Native IPC/service runner at its recorded frozen snapshot: 26 pass, three
  qualification tests ignored. The fresh post-correction run matches hashes across
  8,755 protected files. This is a narrow inherited-Job proof, not rollout approval.
- Independent reviews found human-request authorization/cancellation issues in
  canonical effects. Signed-intent/cancellation corrections are independently closed
  with zero residual bounded findings: 142 + 41 tests pass without failures/skips.
  Cross-process human-lease transport remains unqualified.
  Starter spawn-error and pre-handoff output-retention/size-limit corrections are
  independently closed with zero residual bounded findings: 31 pass, one POSIX skip.
- Child experiments prove explicit private environment admission, not native
  inheritance, signed lifecycle qualification or a supported Mission child mode.
- The initial fresh durable run stops at its exact 2.0.21 pin because the private
  CLI is now 2.0.22; that failed run is retained. The separate exact-target 2.0.22
  run and independent repeat pass all 12 gates, with nine monitored product hashes
  unchanged. No installation
  or shared-daemon restart was performed; `qualified:false` remains explicit.
- Fresh whole-refactor Gatekeeper verdict: **NOT READY**, with a P1 supervisor
  request-failure isolation defect and P2 unattributed-Shell projection defect.
  Both original findings and the subsequent peer-loss fixture expectation are
  independently closed. Final narrow native proof passes 28 Rust tests plus all
  nine response cases, retaining three ignored production qualifications.
- A new independent integrated whole-review remains **NOT READY**: Mission root
  creation bypasses deletion fencing and canonical Stop strands subsequent map-only
  Delete. Private probes reproduce both; the Stop correction is independently
  closed by the unchanged original probe, 143 tests and five additional probes,
  without sends/session creation. Creation correction is delivered (10 regressions,
  301 server tests and typecheck pass); the real wired blocked probe creates no
  sessions. Independent recheck originally found two residual lifetime P2s. Their
  delivered correction captures cancellation at entry and parks ambiguous dispatched
  creation's original permit; exact retries/GETs/connection changes cannot release
  it or replay creation. Seven wire probes and 317 owner tests pass; independent
  recheck closes both residual P2s with seven wire/eleven added probes/ten regressions/
  98 related tests, stable hashes and no duplicate creation. Unknown-hold recovery
  and restart persistence stay closed/unqualified; no fallback is added.
  That frozen review passes 390 server tests/one POSIX skip, 22 UI units, typechecks,
  native proof and all 12 private durable 2.0.22 gates (`qualified:false`). Its browser
  subset has 21 passes and one cold first-navigation timeout, independently repeated.
  Instrumentation captures incomplete loading of the excluded icon module graph at
  the unchanged deadline, before fixture/application assertions; exact historical
  scheduling and host contention remain unproven. The fixture-only graph-preparation
  correction passes three fresh cold attempts and 7/7 file tests. Navigation is
  independently closed by two fresh cold attempts and another 7/7 file run. A
  subsequent static-compilation closure defect is also independently closed by the
  shared shutdown correction below. The intermediate cleanup type error is fixed.
  No timeout relaxation, installed-product diagnosis or whole-scope acceptance.
- Specialist cleanup has a separately reproduced retry-surface defect after
  cancel/remount and unexplained conservative retention. A bounded persisted
  projection and explicit original-request retry/counts are independently verified
  (37 server/22 UI/five browser tests and typechecks pass), without weakening ownership
  or descendant protections. Lost successful acknowledgements
  settle by reading receipts, not a second DELETE. Generic session-list deletion is
  separate and its isolated partial-failure case behaves correctly.
- Cleanup recheck finds a remaining P2: a foreign-mission receipt at the expected
  storage key makes exact retries falsely return success while cleanup stays pending.
  No unauthorized removal occurs. The five-file correction returns 503/pending with
  unavailable state and honest 0/0/1 counts, making no native requests after detected
  corruption. Foreign receipts stay untouched. Owner 46 server/22 UI/five browser
  tests and both typechecks independently pass; the original-probe recheck closes
  this P2 with matching outcomes, zero native requests and unchanged foreign bytes.
- The integrated full-browser repeat records **390 pass/six fail/one skip**, with
  sources changing during corrections; it is not a frozen final proof. Four failures
  are missing local Electron prerequisites, now restored from the existing exact
  dependency version without installation/runtime mutation. The four affected files
  pass 52/52 isolated rechecks, closing only that prerequisite gap. Upload readiness
  and timeline-thumb failures remain under investigation. Upload's unchanged private
  cold case passes once, without explaining the historical timeout; its isolated
  cache lifecycle delivery passes four ownership and 20 file tests. Independent
  recheck confirms narrow cache ownership but finds a partial-load closure stall,
  subsequently closed by the shared shutdown correction. Timeline's failure matches a
  penultimate native pointer position, with no application snap-back; a six-line
  bounded test-helper settlement correction reaches the real endpoint while pressed,
  passes two probes and 21/21 file tests and is independently closed with matching
  native pre-release positions, zero application writes and another 21/21 file run.
  Combined server/UI typechecks now pass with all deliveries. No relaxed
  timeout/assertion or final browser acceptance is claimed.
- The next candidate records **421 pass/one fail/one skip**, again with source changes
  during correction. Missing `join` in the mobile interruption test is the sole
  failure; imports are subsequently restored and full-test strict typing passes.
  This is not
  a frozen-source acceptance result. Earlier failed receipts remain preserved.
- The shared fixture shutdown correction is independently closed:
  owned optimized-load cancellation, real native closure and optimizer-context
  disposal precede cache removal. Seven shared/four lifecycle/two cold/seven
  interruption/20 upload cases and entire-test strict TS pass independently; mobile
  imports are restored. Original failures terminate naturally and cache removal
  waits for genuine context disposal; no late recreation is observed. The preceding
  cache-recreation audit failure stays recorded. Installed Vite 5.4.21/fixture scope
  only: no whole browser green or arbitrary-plugin cancellation claim is made.
- Combined current-source validation passes on 2,188 unchanged entries: both
  typechecks, 312 selected server tests/nine selected Mission UI units, full server/
  UI/plugin build, 28 native Rust tests plus nine response cases (three qualifications
  remain ignored), and all 12 private durable 2.0.22 gates (`qualified:false`). Receipt:
  `missions-integrated-core-R6Sj3D/result.json`. Fresh whole review/full-browser
  validation and genuine production gates remain separate.
- A subsequent fresh whole review finds two new UI P2s, reproduced by four real
  browser probes: stale create/edit completion (including delayed parent refresh)
  overwrites newer selection, and creation-uncertain is mislabeled with close/reopen
  revision-conflict advice that creates a different request. View fencing and
  allowlisted localized guidance/original-draft identity are being corrected.
- The next full browser run is **428 pass/one fail/one skip**, with changing sources
  during these corrections. The sole side-question switch case fails fixture setup
  before its assertions. One focused and all eleven file tests pass independently,
  without reproducing/explaining that timeout. A forced setup failure proves a page
  leak and default shared-cache ownership is separately confirmed; scoped harness
  cleanup is assigned, with no deadline/product change or flake dismissal. No frozen
  final browser acceptance is claimed. Scoped harness cleanup is delivered (11 file/
  eleven lifecycle cases and strict TS pass), independently closed with matching
  hashes and genuine context disposal receipts.
  The forced initialization probe preserves its original failure and closes its page;
  it is not counted as a functional pass or a timeout-cause explanation.

## Remaining release gates — no desktop continuity claim yet

- Genuine host attestation, managed-writer exclusion, protected provisioning and
  trust distribution, then canonical startup/packaging integration.
- Shared physical-family claim participation across actual admissions and mutations,
  protected claim-root provisioning and execution-host/WSL identity mapping.
- Independent native launch, outside-all-Jobs official service starter, private
  storage/IPC audits and packaged Electron/Tauri detach/reattach parity.
- Per-inbox child environment isolation and durable/recursive Pause/Stop fencing.
  Native foreground/background Mission child modes remain disabled.
- Final frozen-source combined validation and fresh independent whole-refactor
  Gatekeeper review/corrections until zero findings. Prior findings are closed, but
  the new integrated review/cleanup findings and browser failure remain unresolved.

Performance #824 remains separate. No installation, shared-daemon restart, native
session deletion or automatic legacy adoption is included in this change.
