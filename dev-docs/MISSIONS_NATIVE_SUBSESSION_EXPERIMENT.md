# Native Missions subsession experiment

Status: **architecture selected: native-first execution with task-bound declared
work; production integration/qualification NOT READY**. User-directed on 2026-10-03.

## Question

Can Missions reuse OpenCode's native subagent/subsession workflows, including
recursive delegation, as its normal execution path while retaining business
contracts, dependency evidence and explicit human intervention?

The previous root-only choice is not the conclusion of this experiment. Neither
missing qualification nor a failed first attempt establishes native impossibility.
The older 2.0.21 continuity spike already demonstrated children and continuation;
its results are prior evidence, not current-runtime recursive qualification.

## Preserved return point

- Original: `D:/CodeNomad/.codenomad/worktrees/tauri-integrated-20261002-1841-b62f`.
- Experiment: `D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003`.
- Branch: `experiment/missions-native-subsessions-20261003`.
- HEAD: `394482f97f743af555599cc172080b4e63e8b4b7`.
- Original staged tree: `0dd4b21892c6614c755c14b1fc8f0c30e776eeb9`.
- Preserved working source: 2,225 nonignored tracked/untracked entries.
- Manifest digest: `0b22cdd75f4f94658620472367cd0cfb9955eaa469b6f0d816b66506f91f1dfa`.
- Evidence/code snapshot: `C:/Users/Admin/AppData/Local/Temp/opencode/missions-native-rollback-V0FPSs`.

Initial Git checkout/apply normalized line endings in 311 files. That mismatch is
recorded, then corrected only in the newly owned worktree from the verified code
snapshot. Final initial-copy hashes exactly match the preserved working source;
the original files/index remain unchanged. This is a source snapshot, **not a
Mission-data/profile/conversation backup**. The installed app and shared daemon
are not involved. The conversation remains attached to the original worktree.

The delivered protected-Stop B1 correction is included in this candidate. Its
read-only independent recheck now closes B1 with a genuinely complete affected
union: **241/241** and valid/corrupt Stop controls, 34 scoped hashes unchanged.
The earlier 239/240 and incomplete timed-out union remain historical evidence,
not retroactively green runs. This is separate from native architecture research
and does not establish production qualification. Evidence:
`C:/Users/Admin/AppData/Local/Temp/opencode/mission-b1-independent-20261003-f003e1/REPORT.md`.

Dependencies are exposed through a read-only-by-convention `node_modules` junction
to the original installation. No install/update or mutable cache/build output may
write through it; fixtures use separately owned caches and private output roots.

## Parallel alternatives

| Lane | Interface to try | Owned implementation | Question |
| --- | --- | --- | --- |
| Native-first | Ordinary native subagent calls, minimal contract/report context | `scripts/native-subsession-spike/native-first/` | Can the common caller work without changing the native tool? |
| Contract wrapper | Minimal structured contract envelope around the actual native tool | `scripts/native-subsession-spike/contract-wrapper/` | Can binding precede execution while preserving native permissions/results? |
| Observer | Attach contracts to an existing native execution tree | `scripts/native-subsession-spike/observer/` | Can persisted native references reconstruct task evidence without owning execution? |
| Qualification | Actual recursive continuity and control/environment experiments | `scripts/native-subsession-spike/qualification/` | What works directly, what has a tested workaround, and what remains unknown? |

Native-first, wrapper and observer are deliberately different module interfaces,
not three implementations of the same assumed root-session orchestration. Reports
compare depth, locality and seam placement only after executable evidence.

Engineering reviewers may delegate once, depth two maximum. That limit does not
limit the native experiment: try a root, child, grandchild and great-grandchild,
including legal agent/permission configuration rather than mistaking a built-in
agent's delegation restriction for a runtime limitation.

## Evidence required

### First delivery — native-first positive, independent review underway

Lane 1 executes ordinary unchanged native subagent recursion to depth three on an
authenticated private 2.0.22 runtime, concurrent branches, continuation, permission
denials, native result/error consumption and explicit reports through the existing
Mission reducer. Final run: 39 provider requests, 15 sessions, 422 events, all frozen
source/index hashes unchanged. The actual depth-one default is increased through
the supported `experimental.subagent_depth: 3` configuration, not a new executor.

This confirms measured native capability, not per-task hostile-sibling authorization
or crash-safe first-context/event binding. Eleven retained fixture launches exceed
the initial internal three-correction ceiling; the final pass does not erase earlier
failures. No verdict on untested alternatives or production rollout. Evidence:
`MISSIONS_NATIVE_FIRST_EXPERIMENT.md` and private
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-EDJTBC/`.
Independent complete repeat verifies the same positive capabilities on private
2.0.22 (39 requests/15 sessions/422 events), exact owned cleanup and frozen source/
index preservation. Root-wide authorization and ordering/crash limits remain.
Evidence: `C:/Users/Admin/AppData/Local/Temp/opencode/native-first-lane1-independent-20261003-f0063/REPORT.md`.

### Second delivery — attach-only observer positive, independent review underway

Lane 3's private 2.0.22 run records 33 provider requests, 11 native sessions and
380 events, with 11 confirmed checks/two explicit limits. Ordinary native tools
remain unchanged; task-matched coordinator reports and native persisted evidence
reconstruct the same tree/journal after disposal and actual Location reload.
Native execution continues when observer source scope becomes unknown.

First-context event ordering is observed, not guaranteed. A coordinator's still
running self-root cannot prove idle terminal completion; that task/dependent stays
unreported/blocked. Accepted coordinator report Tool-result consumption is proved,
but reducer notification remains pending, not a synthetic-outbox acknowledgment.
The adapter's local observer bookkeeping identities are not native inbox IDs.
These limitations remain part of the comparison, not hidden integration guarantees.
Evidence: `MISSIONS_NATIVE_OBSERVER_EXPERIMENT.md` and private
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-observer-2J4Gw5/`.
Independent complete repeat verifies observer behavior on private 2.0.22 (33
requests/11 sessions/380 events), scoped typecheck and unchanged source/primary
index. Self-root completion and pending report notification stay explicit limits.
Evidence: `C:/Users/Admin/AppData/Local/Temp/opencode/missions-observer-independent-b31db33d-c32f-427f-86bd-db161f5253a3/REPORT.md`.
Wrapper implementation and targeted qualification evidence completion continue separately.

### Third delivery — recursive lifecycle/continuity measurements

Lane 4 records 16 isolated 2.0.22 runs: ten complete experiments and six preserved
failures, 228 total provider requests. Depth-three execution, explicit same-child
continuation after six crash boundaries, fresh owned recursive environment and
durable Stop model-consumption gates execute on the actual native runtime.

The current authenticated API **supports session.create parentID**, with a real
API-linked recursive family/model turn. The older no-parentID claim does not apply
to 2.0.22. This capability is not permission-equivalent to native tool launch.

Measured limits: native ENV snapshots are volatile; raw background notifications
can wake interrupted parents; raw session.shell bypasses model/tool hooks; already
running Windows shell descendants perform effects after native cancellation.
Tested remedies include fresh pre-provider owned admission, generation/lifetime
gates rejecting stale ENV wakes, durable native context/tool gates and protected
backend entrypoints. These do not establish atomic recursive OS suspension, native
production trust or exactly-once business reports. Native admission and model
consumption remain distinct. Independent five-repeat verification (109 provider
requests) confirms the measured positive behaviors and reproduces background wake,
raw-shell bypass and OS-effect limits; all frozen source/index hashes stay unchanged.
It finds a retention gap: foreground post-crash continuation drops its complete
ENV-write trace, and older recursive traces predate full input-snapshot hashes.
Those metadata remain unknown, not borrowed from other calls. A targeted fresh
measurement now retains foreground/background traces and compares actual process
ENV key/value hashes to full dispatched snapshots, preserving all prior artifacts.
The fresh measurement and coordinator's two complete independent repeats now
retain the exact foreground/background writes before provider dispatch (52
requests, 12 full Tool/API pairs in each measurement). Every configured value
matches. Full process equality is **false**, without filtering: PowerShell changes
`PSMODULEPATH`, native terminal/session keys appear, and Tool/API differ. Root
probes show the same differences as children/grandchildren; no child-specific
environment defect is inferred. Qualification files, all frozen sources and the
raw primary index remain unchanged across the repeats. The initially assigned
follow-up reviewer was interrupted by a tool content filter and supplied no result;
that attempt is not counted as verification. The coordinator independently reran
both real fixtures and retained assertions/receipts under
`C:/Users/Admin/AppData/Local/Temp/opencode/env-followup-coordinator-independent-hYXpjn/`.
Independent evidence:
`C:/Users/Admin/AppData/Local/Temp/opencode/qualification-lane4-independent-3d3dd593-51db-44fc-b9aa-2e9aa416762e/REPORT.md`.
Evidence: `MISSIONS_NATIVE_RECURSION_QUALIFICATION.md` and
`scripts/native-subsession-spike/qualification/RESULTS.json` (all failed runs retained).

### Integration phase — execution underway, not an architecture decision

A separately owned native-first integration experiment now exercises real native
work, the existing journal/reducer, explicit dependency/report transitions and the
existing Solid Mission/session surfaces. The independently verified native-first,
observer and qualification implementations remain immutable inputs. Integration
lives under `scripts/native-subsession-spike/integration/`, with focused optional
browser fixtures; it does not wire production startup or weaken its authority.
Native/business integration now delivers private 2.0.22 execution (31 provider
requests, 10 sessions, 332 events), three explicit dependent task reports, actual
same-child continuation, recursive verification and parallel review. Captured
native snapshots feed unchanged real Mission UI and session-store navigation.
Two test-oracle defects (Markdown options and backward replay/cache assumptions)
are preserved and corrected only in the new test; all eight chronological frames,
report readers/artifacts, task edges and descendant clicks now pass, with scoped
typing and clean owned fixture shutdown. The independent complete native/UI repeat
also passes (31 requests, 10 sessions, 332 events; fresh capture, 1/1 browser test,
eight frames/readers/descendant selections), with source/index and cleanup checks.
Independent evidence:
`C:/Users/Admin/AppData/Local/Temp/opencode/native-integration-independent-20261003-f0063/REPORT.md`.
Evidence: `MISSIONS_NATIVE_INTEGRATION_EXPERIMENT.md` and private
`native-integration-ui-coordinator-forward-20261003/`. Live bridge/runtime activity,
per-task sibling isolation, crash-atomic reports and production authority remain
unqualified.

### Wrapper delivery found after actor cancellation — verification underway

The wrapper actor terminated as cancelled, not as a completed task. Inspection
nevertheless finds an implemented optional structured-envelope adapter, a complete
report and retained successful native runs: reported broad 34 requests/13 sessions/
379 events plus default-permission controls. These remain **delivery claims** until
independent verification; cancellation is neither a technical failure nor a pass.
The cancelled actor is not resumed. A separate reviewer repeats the delivered
fixture and checks collision behavior and first-context contract completeness.

The independent original-source broad repeat confirms 34 requests/13 sessions/
379 events. Three correctable wrapper findings remain: ownership collision creates
an unbound child before rejection, task semantic payload is absent from first
context, and strict module typing fails. Its targeted fixture stops on a timestamp
oracle defect; concurrent case is unexecuted. The coordinator applies bounded
prototype-only corrections and runs an extended native fixture: current source
passes with **44 requests, 16 sessions, 490 events**. Existing-owner duplicate calls
create no child or map mutation; two fresh same-task calls yield one native child,
one success/one error. Full task semantics and a nonempty completed dependency
reach first provider context; strict scoped typing passes. Independent correction
closure subsequently closes W1/W2/W3 but finds W1-R: malformed own-task/ancestor
calls can wait on their enclosing task's lock before parent validation. The
extended actual fixture reproduces the stall on unchanged module source
(35 requests/14 sessions/389 events). Read-only admission now runs before that
wait and is rechecked inside the lock; current full fixture passes
**52 requests/19 sessions/575 events**, including zero-effect rejection of both
nested invalid refs before enclosing calls return. Scoped strict typing passes;
independent W1-R closure now passes once with the same **52/19/575**, clean strict
typing and zero remaining bounded correction findings. All 2,225 primary bytes,
raw index and 181 prior artifact files are unchanged. Evidence:
`C:/Users/Admin/AppData/Local/Temp/opencode/wrapper-w1r-independent-23b78f93-07e6-45a1-ba14-5c54ea2a7c63/REPORT.md`.
Original failures
and orphan evidence remain intact; no child is removed or replayed to conceal it.

The adapter awaits actual native progress to bind a task before first context,
retains native executor/options/permissions and returns business references along
the existing foreground result path. It is sealed-plan/foreground-only; parent
assistant-message bookkeeping is not a child inbox receipt, and existing report
notification remains pending. See `MISSIONS_NATIVE_WRAPPER_EXPERIMENT.md`.

### T3 Code comparison — read-only, not third-party runtime qualification

The user supplied `v0.0.46-nightly.20261003.2610` and `D:/t3code`. Release tag
is `8ed276c246b624631e7d39241ebfd22d8314cb68`; inspected local HEAD is
`6108ef3d3d`. Adapter changes after the tag concern reported model/variant
metadata, not a different delegation/recovery mechanism. Relevant source and
takeaways are recorded in `MISSIONS_NATIVE_INTERFACE_COMPARISON.md`.

T3 projects actual native OpenCode child sessions separately from its own
cross-harness `delegate_task` execution. Its reconnect reconciles activity and
history; a lost execution is interrupted, and opt-in restart continuation sends
new input. It does not restore a vanished foreground/background executor or
prove our production child authority/reporting guarantees. No T3 files/configs
were changed and its live tests were not executed. These are integration ideas
and comparison evidence, not a replacement for this experiment's native proofs.

### Architecture outcome — 2026-10-03

Choose native OpenCode execution by default and the optional task-envelope /
awaited-native-progress binding seam for declared Mission work. Ordinary native
subwork remains envelope-free (without gaining task/report privileges), but
owned family environment/lifecycle policy still applies. Explicit observer
attachment covers existing execution without creating/prompting/moving it.
Keep coordinator roots and scoped specialist exceptions for explicit independent
Location/lifetime/reuse or temporarily gated playbook semantics. No measured
result supports a universal root-only default; unknown product guarantees are
not native impossibility proofs.

Independent architectural recommendation agrees, without running another native
suite or approving the private wrapper unchanged:
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-architecture-decision-review-cbc256a2-1a28-4094-a0b7-d799eff711c2/REPORT.md`.
Decision details, rejected alternatives, integration order and blocking gates live
in `MISSIONS_NATIVE_INTERFACE_COMPARISON.md`. The original source/index fallback,
installed app, shared daemon, #824 work and old Mission maps remain untouched.
No production activation, replacement PR or redeployment follows this choice.

### Mutable native contracts — assembled experiment and independent corrections

Parallel ordinary specialists and one-level read-only recursive reviewers have
implemented task plans/generations, execution choice/reuse admission and truthful
shared business projection. Coordinator assembled those modules around the actual
native executor, not a second root dispatcher or synthetic delegation engine.
`task.native-bound` retains actual parent/child/Tool/message identities without
claiming a child inbox ACK; native return and explicit business reports remain
separate. New contracts can reuse an independently completed investigator child
without retiring its original task or erasing its historical report/binding.

Coordinator private native acceptance passes **78 requests / 26 sessions /
849 events**. It exercises held in-flight plan changes, distinct task generations,
actual selected agent/model/variant, busy/stale/foreign refusals and late retired
evidence. Initial expanded business/helper regressions pass **317/317**, strict
typing passes. Independent native repeat passes the same 78/26/849, while its
static peer finds R1/R2 capacity/continuation-settlement defects. Old bundled
source reproduces both with actual native execution; no failures are erased.
Corrected native scope passes **118/38/1295**, independently repeated, and
business/helper regressions pass **375/375**. Independent 184-test/assembled
closure plus a recursive read-only R2 reviewer close both bounded findings.
An isolated explicit-child-selection native control passes **10/2/122** at the
coordinator and independently. A broader nested 35-file attempt times
out at 120 seconds and remains incomplete. Exact evidence and
limits: `MISSIONS_NATIVE_CONTRACT_INTEGRATION.md`. Original 2,225 source entries,
raw index and 181 prior artifacts still match preservation receipts; no release.

### Matched root Shell controls

The coordinator executed two actual root-only controls on private 2.0.22: direct
foreground Shell plus native session interruption, and background Shell plus
exact native Shell removal. Both observe the private process's released file
effect after Stop, despite zero additional provider requests and zero native
child births. Thus the previously measured effect is not exclusive to recursive
delegation. Sources/index remain unchanged. Evidence:
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-13Flwj/results.json`
(3 requests, 2 sessions, 60 events). Runnable:
`scripts/native-subsession-spike/root-shell-control.mjs`.

1. Real native recursive creation and concurrent siblings, exact parent/call IDs,
   native results/errors and actual parent model consumption.
2. Child continuation under its original parent, and foreign-parent refusal.
3. Task/contract/dependency/report correlation with no parallel execution queue,
   guessed call IDs, text parsing or fabricated child creation.
4. Restore from persisted native messages/state after plugin reload and a private
   daemon restart/crash; distinguish safe explicit continuation from duplicate replay.
5. Permission inheritance and fresh complete environment at every relevant level,
   including concurrent profiles and continuation. Try supported explicit admission
   if native inheritance fails; do not trim values or expose credentials.
6. Foreground/background Pause/Stop, descendant activity, pending native waits and
   late notifications. Measure admission, model consumption and tool/process effects
   separately. Test supported hook/interrupt/inbox mechanisms before declaring a
   guarantee unavailable; never turn a model gate into a claimed OS process pause.
7. A runnable Missions integration prototype on the strongest supported path,
   followed by independent verification of its actual behavior and limitations.

Admission, consumption, native outcome, business report and task completion stay
distinct. Unknown remains unknown. A failing background guarantee does not by
itself reject bounded foreground children or the entire native-first architecture.

## Isolation and decision discipline

Launch only the assigned absolute CLI as a private `serve` child, never service
discovery/start/stop. Read the runtime version through that child's authenticated
HTTP endpoint. Each run has private home/config/database/provider/project paths
under the approved temp root, stripped inherited ownership variables, finite
deadlines/turn budgets and exact owned-process cleanup. Only the provider replies
are deterministic; OpenCode's runner, native tools, sessions and tested effects
must be real. This does not prove a nondeterministic LLM follows every contract.

Keep every failed setup and controlled negative result. A genuine limitation needs
an exact failing scenario, a positive control and an attempted supported remedy.
Documentation/static analysis identifies hypotheses, not a final inability verdict.

No production gate is disabled. No user configuration, credentials, database,
conversations, legacy namespace, shared daemon, deployment, commit or PR is changed.
No prototype is merged into the preserved return point before the evidence-based
decision. The decision may favor native-first, a scoped hybrid, or the preserved
candidate, but must explain which measured requirements actually force that choice.
