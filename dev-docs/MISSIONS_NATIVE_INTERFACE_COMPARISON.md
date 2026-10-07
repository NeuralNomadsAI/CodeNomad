# Native Missions interface comparison — native-first architecture selected

> Historical 2026-10-03 comparison and architectural decision. Its private adapter
> and native 2.0.22 receipts remain evidence for their exact scenarios, not the
> current product API or a runtime-version allowlist. The selected native-first
> architecture is now integrated in open [PR #866](https://github.com/NeuralNomadsAI/CodeNomad/pull/866);
> its description is the target contract, while qualification is in
> [`MISSIONS_REFACTOR_VALIDATION.md`](MISSIONS_REFACTOR_VALIDATION.md). Ordinary
> recurring passage admission and stronger signed-child authority remain distinct.

This is an experiment comparison, not production activation. The preserved
refactor remains untouched. The integrated candidate's independent native/UI
repeat passes. Original wrapper W1/W2/W3 corrections independently close at
44 requests/16 sessions/490 events. Follow-up W1-R is native-reproduced and
corrected; current extended fixture passes at 52 requests/19 sessions/575 events,
with strict scoped typing also passing. Independent W1-R closure passes on the
same current bytes (52/19/575), zero remaining bounded correction findings.

**Decision on 2026-10-03:** OpenCode-native execution is the default; use the
minimal optional task-envelope/awaited-progress binding seam for declared Mission
work. Native calls without an envelope serve ordinary subwork, explicit observers
attach existing execution, and roots remain scoped exceptions. This selects the
execution architecture, **not the private adapter unchanged** or production
readiness. No second execution scheduler, duplicate child creator or automatic
assignment replay is authorized by this decision.

## What is established

Unchanged native `subagent` executes depth-three recursive work, concurrent
branches, same-child continuation and native result/error return on private
2.0.22. Two independent full repeats confirm the native-first and observer
experiments. Explicit same-child continuation after six crash boundaries also
executes without duplicate births; this is not resumption of a captured executor
or exactly-once business reporting. The current API supports `parentID`; the
older claim that no API-linked child can be created is obsolete for this runtime.

## Interfaces actually implemented

| Path | Caller learns | Execution ownership | Demonstrated business behavior | Remaining limitation |
| --- | --- | --- | --- | --- |
| Native-first | `start`, `record`, `report`; ordinary native delegation | OpenCode | Descendant reports enter the existing journal/reducer; coordinator consumes reports | Root-wide task authority, actor bound only at report, event binding not crash-atomic |
| Attach-only observer | `intent`, `attach`, `watch`, `report`; adapter also uses context/event/snapshot reads | OpenCode | Task/source/revision-matched coordinator reports; tree/journal reconstructed after actual Location reload | One task per existing root; self-root completion refused during its own running turn; notification pending |
| Contract wrapper | `seed`, `inspect`, `dispose`; optional native `mission` reference and explicit report | Original native executor through a contract adapter | Independently closed same-task one birth/full semantic context and in-flight nested own-task/ancestor rejection before waiting on locks | Sealed foreground plan; per-task serialization is not crash-atomic, bookkeeping is not inbox admission; dynamic contracts/choices/cross-task reuse require product integration |
| Preserved root implementation | Mission delegation plus independent actor selection, admission/retry and receipt handling | Mission control creates/admit roots; OpenCode runs them | Previously reviewed root contracts and durable receipts | Its production qualification also remains incomplete; it is not a proven universal control baseline |

The observer is genuinely useful for attaching to existing execution, but **as
implemented it does not replace root-per-task assignment with child-per-task
assignment**. Its native descendants do not change that business interface.
Conversely, native-first really records child actors, but its common root-wide
authority is not equivalent to the preserved task-specific policy. These are
different seams with different guarantees, not interchangeable green test counts.

The smallest native-first caller is already viable for bounded recursive work.
That positive result does not settle which contract-binding interface should ship.
Adding an execution scheduler would duplicate the native behavior already proved.

## Control/environment limits, without unfair attribution

- Raw children do not inherit a freshly written root environment. Explicit owned
  admission writes a fresh complete snapshot before each tested child/provider
  request, including recursion, concurrent profiles and continuation. Environment
  state is volatile across daemon replacement and needs explicit re-admission.
- Full process ENV identity is false. Configured values match; `PSMODULEPATH`
  changes and native terminal/session keys appear. Full root probes have the same
  differences as descendants. No key is excluded to manufacture equality.
- Raw background completion can wake an interrupted parent. Private durable
  generation/context/tool gates prevent measured post-Stop model consumption;
  synthetic admission and model consumption remain different observations.
- Raw `session.shell` needs the owned backend admission policy; model hooks do not
  cover it. A native model gate does not suspend an already running OS process.
- Shell effects after cancellation were measured at depth three **and in matched
  root controls with zero native children**. Private 2.0.22 foreground root
  interruption and background Shell removal both leave the released process's
  file effect observable, with zero post-Stop provider requests. This is therefore
  not exclusively a recursive-subsession limitation and does not justify a
  root-only architecture on its own. Root evidence: approved temp
  `missions-child-environment-13Flwj/results.json` (3 requests, 2 sessions,
  60 events); runnable `scripts/native-subsession-spike/root-shell-control.mjs`.

No atomic recursive suspension, production signed child authority, hostile sibling
isolation or exactly-once reports is inferred from these private tests.

## Product seams that actually need replacement or qualification

These are read-only findings about the preserved source, not authorization to
remove checks or start a second orchestration path beside it.

1. **Delegation/actor admission:** `missions/control.ts` creates/admit independent
   actors through `MissionSessionAdapter` and `createManagedRoot`. A native-first
   interface should register business intent and consume actual native delegation
   references instead of reproducing child execution/admission in another queue.
2. **Ownership:** the same file's `ownedRootSession` rejects every `parentID`.
   Child task/report visibility needs bounded, rechecked native ancestry to an
   authorized coordinator/task scope. Simply deleting the root check is unsafe.
3. **Protected authority:** `missions/durable-host/native-authority.ts` validates
   root-only saved bindings. Derived child authority needs fresh project/location,
   physical-family, connection and contract-generation checks. Private plugin
   storage is evidence, not native trusted authorization.
4. **Recovery/control:** reuse `native-session-family.ts`'s bounded verified native
   tree reads. Recovery observes inboxes, waits and effects; it must not replay
   assignments or infer completion from idle. Lifecycle receipts must describe
   exactly what was stopped, not claim OS process-tree suspension.
5. **Reports:** keep durable business reporting distinct from native result return.
   A business report can contain evidence/next steps not present in the native
   return. Avoid an extra wake only if actual native parent consumption supplies
   that business report. Stable receipts do not prove atomic cross-storage sends.
6. **UI:** current `MissionWork`, `MissionExecution` and actor/report surfaces use
   session IDs without requiring roots. Exercise them with actual child IDs before
   adding another renderer. `MissionGraph` draws declared task dependencies, not
   the native session tree; keep these separate.
7. **Playbook independence:** `missions/contracts.ts` describes fresh reviewers
   and implementer/resolver continuation explicitly as root sessions. Native
   fresh children and same-child continuation are demonstrated, but that alone
   does not validate a complete Pocock playbook. Any replacement must preserve
   fresh reviewer context and exact implementer identity, not merely remove the
   root wording/checks. The current integrated experiment uses custom tasks and
   does not silently claim full Pocock validation.

Root reuse in another worktree, independent lifetime or a genuinely unrelated
conversation can justify a root exception. No experimental result yet justifies
making independent roots the default for every bounded delegated task.

## T3 Code: ideas worth reusing, not a substitute qualification

Read-only inspection on 2026-10-03: release
[`v0.0.46-nightly.20261003.2610`](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610),
tag `8ed276c246b624631e7d39241ebfd22d8314cb68`, local `D:/t3code` HEAD
`6108ef3d3d`. No edits or execution of their live tests. The inspected adapter's
post-tag diff updates reported native model/variant metadata; the delegation,
MCP injection and recovery paths below are already in the tag.

| T3 source, relative to `D:/t3code` | Observed implementation | Decision input |
| --- | --- | --- |
| `apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.ts` | Native `subagent` progress/session events project native child IDs as app child threads; recursive calls and exact-child continuations keep native execution | Observe/project execution rather than replace it. Task dependencies remain a separate business graph |
| Same adapter, `prepareTurn`/`mcpRules` | Native Location MCP registration per app thread, scoped credential and session rules; native instructions entry. External-server injection is skipped and failed addition does not block ordinary turns | Add tools/context through supported native mechanisms. Directory registration and inherited thread rules are not hostile-sibling task isolation |
| Same adapter, `backfill`/`reconcile` | After stream loss, reconstruct items by stable native IDs and current activity/history; no matching terminal history means interrupted, not success. Lost background reports/follow-ups can be dropped | Reconcile authoritatively; unknown/lost work must remain visible, never manufacture business completion from idle |
| Same adapter, `stopBackground` | Explicitly interrupt background child sessions and resulting parent wakes; retain tracking when Stop cannot reach a child | Native delegation still needs owned lifecycle policy. This is not an OS-process-tree suspension proof |
| `apps/server/src/orchestration-v2/RestartContinuation.ts` | Opt-in continuation sends new input with stable app identities, skips newer user runs, and can explain lost background work | Recovery and new execution are separate intents. Do not copy automatic continuation into our explicit Play/recovery policy |
| `docs/orchestration-v2/orchestrator-mcp-server.md` | App `delegate_task` creates its own child thread/run, especially useful across harnesses; it is not the native subagent path | Their universal scheduler solves a multi-harness requirement we do not need to invent for OpenCode-native work |

Their live test source exercises foreground/background native children, Stop,
server death, a later prompt retaining history and stream-drop recovery. The
death test explicitly expects **interrupted**, then a later successful run on
one provider thread. This is concrete test intent, not a test pass executed here.

**Now:** use these seams to choose native execution plus explicit task authority,
reporting and recovery. **Follow-up:** descendant presentation and useful native
steering/fork/compaction UX. **Not deferrable for production:** signed child
authority, hostile sibling isolation, atomic admission/report recovery, owned
environment/lifecycle controls, live bridge and packaged parity. T3's 2.0.18
support floor is its adapter policy, not evidence to raise CodeNomad's technical
minimum.

## Evidence and required implementation/qualification gates

Independent architectural review recommends the same high-level choice, without
approving the private adapter unchanged. Report:
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-architecture-decision-review-cbc256a2-1a28-4094-a0b7-d799eff711c2/REPORT.md`.
This review ran no native/type/UI tests; the separate W1-R closure now passes. It
identifies these non-negotiable integration semantics:

- Native binding/call facts must have truthful fields, separate from child inbox
  admission, native success, explicit business completion and notification receipt.
- Mutable authenticated task generations must survive unrelated journal revisions
  and revoke affected retired/replaced work without replay or silent rebinding.
- Task agent/model/variant choices stay separate from role. Exact-child reuse
  across new authorized tasks must preserve history and refuse busy/foreign work;
  the private wrapper currently accepts only the same contract.
- Signed child authority, fresh ENV and lifecycle policy apply to every native
  execution in the Mission family, including ordinary envelope-free subwork.
- Immediate-parent result/reference consumption is not necessarily coordinator
  report delivery; crash/duplicate/late-result reporting needs its own proof.
- Reuse one business path and the existing UI/desktop plumbing. A sealed private
  wrapper beside the existing root dispatcher would not be the chosen integration.

Suggested order: truthful business/native records and mutable task/rebinding
semantics; owned signed execution/report admission and crash/lifecycle proofs;
actual live UI/native hierarchy; applicable host-lifetime and packaged parity;
fresh complete independent review and frozen final validation. Temporarily gated
playbook/root restrictions must remain explicit until complete Pocock/Wayfinder
replacement policy is qualified. Unknown requirements are not impossibility
claims. None of this is authority to alter the preserved fallback or deploy.

- `MISSIONS_NATIVE_FIRST_EXPERIMENT.md`, independently repeated at
  `native-first-lane1-independent-20261003-f0063/REPORT.md` in approved temp.
- `MISSIONS_NATIVE_OBSERVER_EXPERIMENT.md`, independently repeated at
  `missions-observer-independent-b31db33d-c32f-427f-86bd-db161f5253a3/REPORT.md`.
- `MISSIONS_NATIVE_RECURSION_QUALIFICATION.md`, five selected independent repeats
  at `qualification-lane4-independent-3d3dd593-51db-44fc-b9aa-2e9aa416762e/REPORT.md`.
- Completed ENV measurement repeated by the coordinator at
  `env-followup-coordinator-independent-hYXpjn/REPORT.md`: two native runs,
  52 provider requests, 12 actual Tool/API comparisons; full equality false.
- `MISSIONS_NATIVE_INTEGRATION_EXPERIMENT.md`: actual native/business integration
  delivers 31 provider requests, 10 sessions and 332 events. Eight captured native
  frames pass existing Mission UI, full report readers and descendant selection
  after test-only Markdown/chronological-replay corrections. Independent repeat
  also passes against fresh native captures at
  `native-integration-independent-20261003-f0063/REPORT.md`; captured UI is not
   live desktop transport qualification.

- `MISSIONS_NATIVE_WRAPPER_EXPERIMENT.md`: current independent W1-R closure at
  `wrapper-w1r-independent-23b78f93-07e6-45a1-ba14-5c54ea2a7c63/REPORT.md` in
  approved Temp confirms 52/19/575 and strict typing, with actual in-flight
  rejection and unchanged Mission maps/all 68 private entries across the negative
  step. Its 181 retained artifacts and all 2,225 primary bytes/raw index remain
  unchanged. Coordinator retained baseline failure is 35/14/389, not erased.

The architecture is now selected and its bounded wrapper correction independently
closed. The next change is **product contract integration in the experiment**:
truthful native binding/admission/delivery records, mutable coordinator task
generations, explicit execution selections and authorized cross-task reuse of
the exact child. Preserve shared journal/policy and the original fallback; do
not simply wire the sealed private wrapper beside the root dispatcher.

Before enabling that path, qualify signed derived authority/hostile siblings,
fresh owned ENV across all family paths, lifecycle/late-wake/captured-tool races
and crash/duplicate report/delivery recovery. Then exercise live existing UI and
the applicable packaged native host gates. Whole-review-until-zero and frozen
core/full-browser validation apply to that integrated changed scope, not to an
unchanged root-only fallback presented as proof of a new design. Previously
recorded browser/type failures and unresolved original specialist results remain
open; this research does not relabel them.

Reintroduction material remains unpublishable: the preserved pre-experiment
validation records are historical source/qualification evidence, not a current
native-first ready-to-merge result.
Update the final PR description only after the changed product scope and final
validation are known. No replacement PR, deployment, native writer takeover or
waiver of existing desktop rollout gates is authorized or performed.

### Mutable-contract tranche — initial acceptance and corrected boundaries

`MISSIONS_NATIVE_CONTRACT_INTEGRATION.md` records the implementation now assembled
inside the experiment: shared truthful native binding/return events (without
invented inbox admission), targeted task generations, coordinator retire/replace/
dependency edits, explicit agent/model/variant gates and coordinator-authorized
reuse of the same native child across task contracts. Coordinator actual native
initial acceptance passes **78/26/849**; initial business/helper regressions pass
**317/317** and scoped strict typing is clean. Separate review discovers R1/R2
(actor-cap poisoning and stale original-invocation settlement). Corrected native
acceptance passes **118/38/1295**, independently repeated; business/helper
regressions pass **375/375**, strict typing is clean and an independent
184-test/assembled structural review closes R1/R2 with no residual bounded
correction finding. An isolated explicit-child-selection native control passes
**10/2/122** at the coordinator and independently. A larger nested
Mission test attempt timed out and stays incomplete. Retained before/after bundle
identity and oracle failures are documented rather than overwritten.
This tranche does not enable the desktop path or waive any gates listed above.
