# Native task-contract integration — bounded independent acceptance

2026-10-03. Architecture selected in `MISSIONS_NATIVE_INTERFACE_COMPARISON.md`.
This tranche integrates mutable task contracts with the existing business
journal/reducer in the **experiment worktree only**. No production entrypoint,
preserved fallback, installed application or shared daemon is changed.

## Required facts, not interchangeable acknowledgments

- Native progress binds actual child, parent, Tool call and parent assistant
  message to one task generation before its first model context.
- That binding is **not** a child inbox admission. The shared task projection must
  not fill `admissionId`/`delivery` from the parent assistant message.
- A native return is its own observation, not an explicit business report or a
  coordinator-delivery receipt. Existing report notification stays pending unless
  its real receipt exists.
- Retiring an in-flight task preserves its original execution and any explicit
  late report without completing or assigning its replacement.

## Integration ownership

Disjoint ordinary subagents implement mutable task-plan state, shared native
fact projection and native execution/continuation validation. Each may use one
read-only recursive reviewer. Coordinator assembles the wrapper and the actual
native fixture; a separate reviewer must verify the assembled changed scope.
This is not Mission-driven orchestration.

## Acceptance scenarios being implemented

1. Per-task generations start at one, independently of mutable plan-document and
   business-journal revisions; only changed task contracts are invalidated.
2. Authenticated coordinator retire/replace/dependency edits, exact request retry
   and conflict refusal; unrelated running task semantics remain valid.
3. Actual selected native agent/model/variant, separate from the business role;
   mismatches reject before child creation.
4. Explicit new-task reuse of the same native child, preserving old reports and
   invocation history; foreign/busy/unauthorized reuse cannot send or switch it.
5. Retire while an actual provider request is in flight; retain an explicit late
   report and fence its next provider request without replay or replacement launch.
6. Existing depth-three recursion, sibling concurrency, one-birth collision guards,
   wrong-parent rejection, ordinary native permissions and private reload persist.

`scripts/native-subsession-spike/contract-wrapper/dynamic-cases.mjs` drives the
real native Tool/plugin/journal path. The fixture's idle admission callback reads
the same private server's authenticated `session.active` route; plugin contexts
do not expose that method and an unavailable/unknown observation must fail closed.
Only provider replies and deliberate holds are deterministic. No copied native
executor or direct Tool-execution shortcut is an acceptance substitute.

## Qualification ceiling

Coordinator actual-native run **PASS 78 requests / 26 sessions / 849 events**:
`C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-wrapper-pBgzT8/`.
Results include real provider-side `recursive_sub` / `fixture/selected#careful`,
gen-1 investigator launching gen-2 nested work after unrelated plan revisions,
busy refusal with unchanged bindings/maps, and exact investigator-child reuse
for implementation while old report/binding history remains intact. Retired
in-flight work retains one explicit late report and issues no subsequent provider
request; this is not suspension of an already-running OS process.

Coordinator assembled targeted structural suite **189 passed / 0 failed**;
expanded business regression suite (top-level Mission tests plus the two new
helpers, excluding nested durable-host/host-authority fixtures) **317 passed /
0 failed**, no skips. The 189-test result is a subset, not an additive total.
Scoped strict typing exit 0. Logs, original source copies and preservation receipts:
`C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-integration-coordinator-IJzdAS/`.
The preservation check still matches all **2,225** original source entries, raw
original index SHA-256 `21a5beee4071a842ef888dfbbfecfcc95cc42b69b378dff0268031ffbac222db`,
and all **181** previously audited artifacts. The initial assembled independent
read-only review subsequently found R1/R2 below;
the original native repeat passed the same 78/26/849, but did not exercise those
newly identified boundaries. Neither result is whole-feature closure.

An additional recursive **35-file Mission regression attempt** exceeded its
120-second command budget before producing final totals. Its incomplete
`mission-regressions.log` is retained; no completed whole-Mission-suite pass is
claimed. The log ends during structural durable-host admission tests (observed
individual durations around 52–65 seconds), without a recorded failed test.
The runner was no longer active after timeout. This is separate from the
completed 189-test changed-scope result and is not frozen final validation.

Original independent W1-R **52/19/575** describes its frozen source/dependency
scope, not new mutable integration bytes. Historical failures/success artifacts
remain retained. Model responses here are deterministic; actual transport,
native executor, storage, Tool loops, observations and effects are real. Model
understanding under nondeterministic provider replies is not established.

Private coordinator credentials are not signed production child authority.
Process-local exclusivity and separate storage writes are not cross-process or
crash-atomic admission/report recovery. Fresh profile ENV, hostile sibling
isolation, family lifecycle/late-wake/captured-tool races, complete dynamic
Pocock/Wayfinder, live desktop UI and packaged parity still require their own
qualification. No queue, automatic assignment retry, receipt repair or native
writer takeover is authorized by this tranche.

## Independent findings and bounded corrections

Initial static review (96/96 scoped tests, strict typing clean) independently
reproduced two assembled-path defects with structural boundaries:
`C:/Users/Admin/AppData/Local/Temp/opencode/integration-static-review-06d8df7c6f2940b6b15b67bd4b209861/REPORT.md`.
Initial actual-native repeat, source/index/artifact audit and 15 trace checks:
`C:/Users/Admin/AppData/Local/Temp/opencode/native-integration-independent-fdf9d2ce-d993-4699-a514-1b07e19d75b6/REPORT.md`.

### R1 — actor capacity, including overlapping native births

The shared Mission cap is eight actors **including the coordinator**. Before the
correction, child eight was born; its binding event was discarded while private
owner/current state was still written. The journal then failed authority closed.
`contract-capacity.ts` now reserves a bounded slot under the existing project
lock **before** invoking native execution, accounts for overlapping pending
births and converts a reservation only after the actual accepted journal actor
footprint. Existing owned specialist continuation consumes no new slot. `finally`
releases reservations. The wrapper verifies shared binding acceptance before
writing private ownership; it never raises the cap or discards an actor to fit.
This reservation is process-local, not a durable/cross-process writer claim.

### R2 — current invocation termination without rewriting the original return

An original bound executor error followed by explicit same-task continuation
could return truthfully while the shared original binding still looked pending.
Retirement therefore reported false outstanding execution. Shared `nativeExecution`
now projects the exact current call independently of immutable `nativeBinding`;
`task.native-call-started` / `task.native-call-ended` retain call history and
distinguish `returned` from `error`. Successful continuation never labels the
original failed call as a successful return. Retirement observes the current call;
an old report cannot settle a later pending invocation. Errors are observed
executor termination, not descendant process cancellation or OS suspension.

The actual native R2 control injects one private error after awaited **real native
child progress and accepted wrapper binding**, then explicitly continues that
child through native execution without a report. It is an error-boundary test,
not proof that the native engine naturally fails that way. No fake executor/RPC
Tool invocation substitutes for the actual Tool loop.

### Explicit actor choice and busy policy

`reuseFromTaskKey` selects the same actor; it is not merely permission to reuse.
Omitting the exact continuation `sessionID` now refuses before birth in the helper
policy tests. The native negative grouped with stale refs is **not proof** of
that specific policy: its persisted error says stale task rather than required
`sessionID`. It therefore required a separate isolated control before closure.
The separate isolated control below subsequently qualifies this guard; the grouped
receipt remains non-proof. Ordinary fresh tasks without that selection remain valid.
Busy same-task and cross-task
continuations refuse without send/switch; a local in-flight task claim also
rejects a second overlapping same-task call instead of delaying it until idle.

Native `message.list` exposes both Tool results only once their assistant message
settles. To observe rejection **while its sibling native provider request remains
held**, the fixture uses a read-only RPC over a private in-memory observer of the
actual rejected wrapper promise. It neither invokes a Tool nor writes contract
authority. Completed native messages separately confirm one success/one error.

### Retained native before/after evidence

| Phase | Private root suffix | Requests / sessions / events | Outcome |
|---|---|---|---|
| Initial assembled bytes, coordinator | `pBgzT8` | 78 / 26 / 849 | Bounded initial acceptance, later R1/R2 found |
| Initial assembled bytes, independent | `6ANjA9` | 78 / 26 / 849 | Independent initial acceptance |
| Old executed bundle, first extended oracle | `VNajnb` | 109 / 39 / 1196 | Retained timeout: journal poison prevented the expected first-provider hold |
| Old executed bundle, corrected oracle | `zW51r3` | 109 / 39 / 1206 | R1 and R2 reproduced; **not feature acceptance** |
| Corrected bytes, first observation oracle | `PtepYA` | 92 / 30 / 978 | Retained timeout: incomplete assistant Tool parts were not published yet |
| Corrected bytes, corrected observation | `DugIAQ` | 118 / 38 / 1295 | Coordinator PASS, zero discarded events, independently repeated |
| Corrected bytes, independent repeat | `rq7epO` | 118 / 38 / 1295 | Independent corrected acceptance; grouped selection oracle excluded |
| Corrected bundle, isolated selection | `JsO4cm` | 10 / 2 / 122 | Coordinator exact guard and same-child positive PASS |
| Corrected bundle, independent isolated selection | `s2PwyG` | 10 / 2 / 122 | Independent targeted gate PASS |

All roots have prefix `C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-wrapper-`.
The baseline executed bundle SHA-256 is
`68c5319cda186ec7b5052310d7e9c216c19c44b056f72a7f12335d00f14add9c`,
identical to preserved `pBgzT8/plugin/wrapper.mjs`. Baseline `sourceHashes` describe
the then-current experiment files, **not** the old bundled bytes it executed;
`baselineBundle` / `executedBundleHash` retain that distinction explicitly.

Corrected business/helper regressions: **375/375**, no skips; corrected scoped
strict typing exit 0. Independent current-source static review closes **R1/R2**
with **184/184** scoped tests, strict typing, six assembled structural controls,
and a read-only recursive R2 reviewer; no remaining actionable correction finding:
`C:/Users/Admin/AppData/Local/Temp/opencode/integration-closure-review-93927440627544c3ac2e6c18c7989451/REPORT.md`.
The independent corrected native repeat also passes **118/38/1295**, with the
required-sessionID grouped negative explicitly left unqualified:
`C:/Users/Admin/AppData/Local/Temp/opencode/native-corrected-independent-0ffaa9ce-5423-4b49-8b50-bac06b3b0a97/REPORT.md`.
The broader 35-file timeout remains incomplete; no whole-core,
whole-browser, nondeterministic-provider, live UI or production rollout pass is
inferred from these bounded results.

### Isolated same-actor selection control

To avoid mistaking the grouped stale-ref error for the intended guard, a bounded
control copies the **unchanged main fixture setup** into an owned Temp runner and
replaces only its acceptance scenarios. It executes valid completed investigation,
the authenticated revision selecting that investigator for implementation, a
single correct-generation/execution call without `sessionID`, and then approved
exact-child reuse. It invokes no Tool through RPC and does not emulate native
execution. The generator/provenance and both runner versions are retained in the
coordinator evidence directory. The first diagnostic import failed before native
launch (`@opencode/client` has an import-only export); that log is preserved.

Coordinator isolated native **PASS 10 requests / 2 sessions / 122 events**:
`native-contract-wrapper-JsO4cm`. The error is exactly
`reuseFromTaskKey requires an explicit native continuation sessionID`; all private
entries and Mission maps stay identical and no child is born on refusal. Approved
continuation then reports implementation on the original investigator child.
Its executed bundle is the exact same corrected `b3a2186c…` as `DugIAQ`; experiment
source files are untouched. Independent isolated repeat also passes **10/2/122**:
`C:/Users/Admin/AppData/Local/Temp/opencode/native-isolated-reuse-independent-d0e7ae12-0d66-4bfc-a8b9-c608b7f1f222/REPORT.md`.
It verifies zero child inbox/provider/birth activity on refusal, the exact next
parent-request error, correct positive task context, preserved old report and
actual native stored implementation binding/report. All 2,225 original entries,
both indexes, 181 older artifacts and 132 additional protected evidence files
remain unchanged at that independent checkpoint; no owned native processes remain.
Its optional storage-audit check initially used top-level `event.taskKey` instead
of `event.report.taskKey`; the failed receipt is retained, with a separate bounded
validation of the original captured rows. No native rerun or receipt repair.
The grouped stale-error receipt is still retained and is not relabeled as this
new isolated proof.

## Outcome and next production gates

This **bounded experiment tranche is independently accepted**: mutable task
contracts, truthful binding/invocation observations, explicit native selections,
authorized exact-child cross-task reuse, targeted retirement/late evidence, R1/R2
corrections and busy/capacity refusals. Main and isolated runs qualify the same
corrected bundled module; request/session/event counts above are separate runs,
not one synthetic combined result. Structural test counts are overlapping suites.

The feature is **NOT READY for production**. Next qualify signed derived task
authority and hostile siblings, fresh complete owned family ENV, lifecycle/late
wakes and background contracts, crash/duplicate report-delivery recovery, live
existing UI/bridge and native host/package parity. Complete dynamic playbook
policy, broad review-until-zero and frozen whole-core/full-browser validation
still remain. Keep the existing fallback, namespace isolation and explicit human
Play/recovery policy; no parallel root dispatcher, no mutation replay, no implicit
native writer takeover. No source relocation, production activation, replacement
PR or deployment occurred. The broader 35-file timeout is still incomplete.
