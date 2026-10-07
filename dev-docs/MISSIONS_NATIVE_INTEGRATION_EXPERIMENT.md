# Native Mission integration — provisional executable proof

2026-10-03. **Research candidate only, not an architecture selection or product
activation.** The independently verified three lane-1 files remain immutable.
No production modules, signed authority, root guards, Pocock policy, CSS or i18n
files were changed.

## Outcome and runnable commands

Native/business pipeline **PASS** on authenticated private **OpenCode 2.0.22**:
**31 actual provider requests, 10 native sessions, 332 captured events**.
Three custom tasks progress investigate → implement → verify, with recursive
native leaves, exact-child continuation and parallel bounded native review.
Explicit reports update the existing `MissionJournal`/reducer; the coordinator
consumes report evidence before deciding each next ordinary native launch.

**Captured-data UI replay now PASS after two test-only corrections below.**
Independent integration repeat/review now also passes. Live desktop transport
and production qualification remain OPEN; native/business and captured UI checks
do not establish those guarantees.

### Coordinator UI follow-up — failures preserved, current replay PASS

The coordinator compared the failed oracle to product `lib/markdown.ts` and
matched its `breaks: true` option. That run passes readers and descendant clicks,
then exposes another fixture defect: replaying older frames after `finished`
expects bounded session refreshes to delete already known newer sessions. The
test now replays all eight real captured frames **forward**, retaining every
snapshot/dependency/session assertion. No product cache or renderer changed.

The current single browser test passes all eight transitions, all three report
summary/evidence readers plus exact structured artifacts, declared dependency
edges, real actor clicks and descendant navigation with exact parent/root IDs.
Zero page errors/external requests; two owned Vite contexts disposed, zero pending
loads, closed listener and private cache cleanup. Scoped strict typing of both
new UI files with existing ambient roots also passes after these corrections.

Current UI artifacts:
`C:/Users/Admin/AppData/Local/Temp/opencode/native-integration-ui-coordinator-forward-20261003/`.
The intermediate backward-replay failure remains at
`C:/Users/Admin/AppData/Local/Temp/opencode/native-integration-ui-coordinator-oracle-20261003/`;
the owner's original failed artifacts below remain untouched. No previous failure
is retroactively relabeled green. This still qualifies **captured-data replay**,
not a live native bridge or the production session-tree renderer (fixture
navigation uses existing session-store callbacks).

### Independent complete repeat — native and fresh captured UI PASS

`C:/Users/Admin/AppData/Local/Temp/opencode/native-integration-independent-20261003-f0063/REPORT.md`
records one unchanged native repeat (31 requests, 10 sessions, 332 events) and
one browser test against that reviewer's **fresh** native capture: 1/1, all eight
frames, three summary/evidence/artifact readers, four business actor clicks and
eight descendant selections. Owned process/cache cleanup and immutable source/
index checks pass. No new actionable failure in this bounded scope; production,
live bridge and full session-tree renderer remain unqualified. The independent
report retains a post-exit observer-disposal error separately from successful
native execution, without hiding or rerunning it.

From `D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003`:

The native generator below is a frozen historical Windows experiment, not a
portable current-product CI fixture. Review its exact private prerequisites
before running it. Current renderer replay is separately invoked and requires
an audited capture; ordinary browser CI neither provisions that historical run
nor claims native qualification. Missing capture in explicit qualification fails
rather than skips. Always use a new output directory to preserve old receipts.

```powershell
node scripts/native-subsession-spike/integration/run.mjs

$env:NATIVE_MISSION_CAPTURE = 'C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-oLnPm0/capture.json'
$env:NATIVE_MISSION_OUTPUT = Join-Path $env:LOCALAPPDATA ('Temp/opencode/native-mission-replay-' + [guid]::NewGuid().ToString('N'))
npm run qualify:browser:native-mission-replay --workspace '@codenomad/ui'
```

Native artifact root:
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-oLnPm0/`.

UI qualification is captured-data replay **after owned native process cleanup**,
not a live authenticated desktop bridge. Closing the bounded private runtime
before browser compilation/rendering keeps its ≤240-second execution/cleanup
contract independent of UI startup. Captured snapshots, native Session.Info and
event payloads are actual reads from the pipeline, not invented renderer inputs.

## New files and small caller interface

- `packages/server/src/missions/native-subsession-experiment/integration.ts`
  contains the typed business module, never imported by product activation.
- `scripts/native-subsession-spike/integration/index.ts` is its private native
  plugin adapter: context instructions, native fact observation, business tools.
- `scripts/native-subsession-spike/integration/runtime.mjs` and `run.mjs` own
  isolation, deterministic model responses, assertions and exact child cleanup.
- `packages/ui/tests/browser/native-mission-integration.qualification.ts` and
  `fixtures/native-mission-integration.tsx` mount the existing UI components.

```ts
start(ctx, ownedCoordinatorID, objective)
read(ctx, nativeCallerID) // inherited contract, native lineage, existing snapshot
report(ctx, { sessionID, id: nativeCallID }, input)
```

Model-facing usage remains ordinary:

```text
integration_start({ objective: "Investigate → implement → verify" })
subagent({ agent: "integration_all", description: "Investigate", prompt: "..." })
// Recursive native leaf:
integration_report({ taskKey: "investigate", outcome: "completed", summary: "...", evidence: ["..."] })
// Coordinator consumes receipts and decides continuation/review/verification.
subagent({ agent: "integration_all", sessionID: actualChildID, description: "Implement", prompt: "..." })
// After all three explicit task reports:
integration_report({ final: true, outcome: "completed", summary: "..." })
```

No task dispatcher, second execution queue, native executor wrapper or tool
schema/permission edit exists. Fixture response plans model the deterministic
provider only; business code neither dispatches those plans nor starts children.
Native schema equality across root requests, catalog equality across the run,
source guard and hashes are recorded. Tool function-reference identity through
SDK adapters is not claimed.

### Interface invariants / failure behavior

- Only a fresh owned root starts this fixed **custom** three-task contract.
- Reads follow actual `session.parentID`, reject cycles/foreign Location/project,
  and bound lineage/call scans. Event facts provide call/admission correlation;
  they are not an awaited pre-birth hook or crash-atomic binding.
- Authority remains **root-wide inherited report scope**, not hostile-sibling
  per-task isolation. Ordinary unassigned native work remains allowed.
- Unknown task, unmet dependency and invalid report outcome fail. This denies
  business evidence admission, **not native execution permission**. Native
  success without a report leaves the business task ready.
- Explicit final completion is coordinator-only and checks every task completed,
  then calls the existing custom completion policy. It deliberately does not
  require the reporting coordinator's own session already terminal.
- Native permission, ancestry and continuation errors remain native errors;
  a foreign parent's continuation produces no child request or new birth.
- Existing report identity/notification helpers supply deterministic IDs and
  compatible admitted receipts; zero events are discarded by the reducer.
- Storage/report/synthetic receipt operations are separate writes. No atomic
  crash recovery, exactly-once notification or retry/outbox claim is made.

**Seam:** business contract/read/report handling, not native execution.
**Depth / Leverage:** three operations reuse native recursive execution and the
existing Mission journal/reducer. **Locality:** validation and business facts are
in one small typed module; native hooks stay in the private adapter.
**Dependency strategy:** real private OpenCode, deterministic provider only;
immutable journal/contracts/receipt helpers are imported rather than copied.

## Actual pipeline, identities and consumption

Coordinator: `ses_eff9a9afaffeWUC6n1fFJ14VjC`.
Mission: `msn_12d2cad237fb0e46adccffb4`.

| Work | Actual native execution | Business evidence / consumption |
| --- | --- | --- |
| Investigate | Root tool `investigate_call` → child `ses_eff9a942affeCC5J7uCLQy36em`; child tool `investigate_recursive` → grandchild `ses_eff9a9281fferSad9hojK6cmUe` | Leaf `investigate_report`; report `rep_0a4d5075c74bd0b6e3cc7369`; root provider request 14 consumes `INVESTIGATION_EVIDENCE` before implementation choice |
| Implement | Root `implement_continue` uses the **same** child `ses_eff9a942affeCC5J7uCLQy36em`, not a new root actor | `implement_report`; report `rep_781bcd5e04113997db512617`; root request 19 consumes `IMPLEMENTATION_EVIDENCE` before verification choice |
| Parallel review subwork | Root `review_parallel`, background child `ses_eff9a8a6bffeYsqOKAOeKiyzWz`; active concurrently with continued implementation | Native review result/notification consumed at root request 18; no fourth business task or fabricated report |
| Independent verify branch | `verify_call` → `ses_eff9a890bffeIGN3xQDnFeeNzk` → `verify_recursive` → `ses_eff9a87faffeyIQojf5yQnv059` → `verify_to_leaf` → `ses_eff9a8784ffe0XSAdBvadeSONk` | Real depth-three fresh native branch; `verify_report`; report `rep_0f6c53710aaa299e1a16a3f4`; root request 27 consumes `VERIFICATION_EVIDENCE` |
| Explicit Mission completion | Root ordinary tool `mission_final` | `mission.finished` event `finished_d78622413999f9fa81fe299c`; task reports all completed before admission; actual final tool result consumed in root request 28 |

Final report invocation succeeds at native event index **300**, before root
execution success at index **310** (invocation index 298). Thus business finish
does not depend on the currently executing coordinator first becoming idle.
`post-run-audit.json` independently parses the actual final tool result from
provider request 28 and checks stable report IDs and unchanged tested code hashes.

Native foreground results and business reports are separate semantic channels.
At requests 13, 18 and 26, the coordinator had native results but not yet the
separately queued business receipts. Its deterministic provider returned plain
wait text, admitted no dependent tool, and native inbox processing resumed it
with those already queued receipts. No host prompt/retry/dispatcher was added.

Fixture caveat: the final model response is also wait text because its last
serialized-string predicate misreads escaped JSON quotes. The structured final
tool result is actually present and consumed at request 28, audited separately;
no further native run/fix was performed. Do not claim a meaningful final textual
acknowledgement from the deterministic model. The explicit business completion,
native tool success, consumed result and terminal native execution are confirmed.

### Actual snapshot transitions

| Capture frame | investigate | implement | verify | Mission |
| --- | --- | --- | --- | --- |
| initial | ready | blocked | blocked | active |
| native-success-unreported | ready | blocked | blocked | active |
| negative-reports-denied | ready | blocked | blocked | active |
| investigate-reported | completed | ready | blocked | active |
| parallel-review-active | completed | ready | blocked | active |
| implemented | completed | completed | ready | active |
| verified | completed | completed | completed | active |
| finished | completed | completed | completed | completed |

An actor is bound in the journal when explicit evidence arrives, recording the
actual earlier native prompt admission. Before that the prototype does not
manufacture a running/queued business task from native activity. Reports retain
all real lineage edges, call IDs/event IDs and native admission IDs.

## Negative controls and limits

- Unreported native child succeeds and the coordinator consumes its result;
  business investigate remains ready and dependent tasks blocked.
- `negative_wrong`: unknown task error; `negative_blocked`: unmet dependency
  error; `negative_outcome`: actual native schema rejects `succeeded`.
  All three are actual model → native-tool calls, not direct captured executors.
- Foreign root `ses_eff9a840dffeO6HgSkPPFT0dfO` tries `foreign_continue` on the
  real investigator child: native “not a child of the current session,” zero
  additional child requests and zero additional births.
- Before explicit dependent decisions and after completed work, bounded 300 ms
  observation windows produce **zero additional provider requests**. This is
  evidence of no automatic dispatcher in this candidate, not an indefinite
  quiescence or external-writer guarantee.
- Fresh recursive verification is distinct from investigation/implementation.
  It does **not** qualify Pocock's fresh-root reviewer/validator independence or
  resolver-root reuse. Existing `contracts.ts` root policies were not deleted.

## Artifacts, checks and integrity

- `results.json`, `requests.json`, `events.json`, `transcripts.json` retain actual
  version, IDs, complete schemas, options, native outcomes, reports and consumption.
- `capture.json` contains eight actual intermediate snapshots, authoritative
  native session reads and captured event batches for UI replay.
- `openapi.json`, `serve.log`, private database retain runtime evidence.
- `post-run-audit.json` validates the final structured provider result, stable
  report IDs, tested integration-source hashes, frozen sources/index and lane 1.
- Scoped `tsc --noEmit` of the new business module **PASS** (also executed by the
  runnable native fixture). This is not a whole-browser/workspace typecheck.

Native first attempt `missions-child-environment-0AoYEf` is preserved. It exposed
the native-result/business-receipt timing distinction. **One purposeful fix**
added bounded deterministic provider wait responses without admission/dispatch;
the second actual run `missions-child-environment-oLnPm0` passed. No broad
lifecycle/ENV/cancellation fixture was repeated.

Every native run hashes the frozen **2,225 source files** and frozen index
before/after and compares immutable lane-1 file hashes to their verified values:

- Source digest: `0b22cdd75f4f94658620472367cd0cfb9955eaa469b6f0d816b66506f91f1dfa`.
- Index: `21a5beee4071a842ef888dfbbfecfcc95cc42b69b378dff0268031ffbac222db`.
- Lane-1 files: exact verified hashes retained in both runs and post-run audit.

Assigned absolute CLI only, private HOME/XDG/APPDATA/config/DB/runtime/Git,
stripped inherited ownership/credential-like keys, updates/models fetch/project
discovery disabled, synthetic loopback provider. ≤240 seconds, ≤200 provider
requests, native depth three, bounded agent steps and exact owned child cleanup.
No service commands, shared daemon stop, user data, application restart, installs,
commits/staging or dependency/cache mutation.

## Original delivered UI evidence — retained before coordinator follow-up

Existing `MissionWork`, `MissionGraph`, `MissionActors`, `MissionReader` are
mounted with full styles. Captured native events enter existing
`serverEvents.dispatchBatch`; existing Mission and native session stores consume
the data. MissionGraph uses **only** investigate→implement→verify dependencies;
native parent hierarchy is navigated separately with exact native IDs/parent IDs.

Original delivered browser test **FAIL**, preserved without further fixes/reruns after the allowed
purposeful browser correction. It confirmed all five main frames, exact two
declared graph edges, and actual session-store ID/parentID mappings through nine
native sessions. Investigation report opened; its full summary, evidence and
structured native lineage are visibly present in `ui-proof/failure.png`. Summary
assertion passed; evidence assertion timed out because the fixture's default
`marked.parse` oracle differs from production `breaks: true`. This is not a native
execution failure, and it does not qualify all remaining reader content.

The failure occurred before actor/child navigation clicks and additional-frame
replay assertions. Those remain **unknown**, not green from source inspection.
The existing navigation callback is `setActiveSessionFromList`; it was not
rewritten, but that alone is not an interaction proof.

Actual rendering paths:

- `MissionControl → MissionWork/MissionGraph/MissionActors/MissionReader`.
- `serverEvents.dispatchBatch → missions.ts/sse-manager/sessions.ts`.
- `fetchSessions → toClientSessionV2` for the captured native Session.Info.

Artifacts under the native run root:

- `ui-proof/{initial,investigate-reported,implemented,verified,finished}.png`.
- `ui-proof/failure.png`, `ui-proof/browser-report.json`.
- `ui-test-verification.log`; first failure retained in `ui-proof-first-run/`
  and `ui-test-first.log`.

Runtime browser errors and external requests: **zero**. Scoped TypeScript with
the existing ambient declaration roots: **zero owned and zero imported
diagnostics**. Omitting those ambient roots produced 14 imported declaration
diagnostics; no whole-browser/workspace typing-green claim is made. Fixture
shutdown recorded its owned temporary Vite cache, zero active contexts and a
closed listener; it did not clear or reuse the shared optimizer cache.

The replay is fixture transport, with native mutation routes refused; no live
authenticated bridge/SSE or uncaptured active-session inventory is qualified.
Missing runtime activity remains unknown. At delivery, the next narrow UI gate was aligning the
test oracle with existing Markdown options, then explicitly qualifying readers
and descendant navigation—not redesigning the native execution path.

## Product seams this would replace, not layer beside

If selected after all lane evidence, the root-only dispatch portions of
`missions/control.ts` and durable-host actor/admission orchestration would need
an explicit native-child contract/report path instead of retaining a second
root-execution engine beside it. Existing journal, report identities, business
reducer and session-ID-based Mission UI can remain the shared business surface.
This candidate is not wired into those product modules.

The root checks in `durable-host/native-authority.ts`, signed authority protocols,
ownership/environment/deletion fences and activation gates are **trust guards**,
not expendable dispatch boilerplate. Child authorization must be designed and
qualified explicitly before replacing a root actor's execution role there.
Pocock fresh-root policies and resolver continuation mapping require their own
product decision/tests, not a custom-fixture green badge.

Unqualified: hostile per-task branch authorization, observer lag/reconnect/crash,
atomic contract/report receipt recovery, profile environment admission, durable
Pause/Stop notification fences, real desktop detach/restart and production UI
transport. Native first-context ancestry is usable; guaranteed call binding
before that context is **not** established by an asynchronous subscriber.

Coordinator-supplied current qualification evidence is not repeated here:
ENV follow-up 52 requests/12 actual root-child pairs found source→process
differences (PSModulePath/native keys) in roots as well as descendants. Matched
root-only Shell controls at `missions-child-environment-13Flwj` (3 requests,
2 roots, 0 children) still permitted filesystem effects after foreground
interrupt/background removal with zero later provider requests. These do not
establish atomic OS cancellation for either roots or children, nor justify
preferring roots on that basis. No architecture ranking is made before wrapper
lane evidence and the requested integration review.
