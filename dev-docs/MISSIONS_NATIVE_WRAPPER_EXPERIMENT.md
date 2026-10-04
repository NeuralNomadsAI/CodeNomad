# Native Mission contract wrapper — lane 2

## Outcome

### Independent review and bounded corrections — W1/W2/W3/W1-R CLOSED

Independent original-source broad repeat confirms 34 requests/13 sessions/379
events. It also finds three wrapper defects: an already-owned task's new-child
call creates an orphan before rejection; first context contains binding identity
but lacks task semantics; strict scoped typing reports three module diagnostics.
The targeted probe stops on an incorrect whole-snapshot timestamp comparison,
so its concurrent case is unexecuted, not passed. Evidence remains immutable at
`C:/Users/Admin/AppData/Local/Temp/opencode/wrapper-independent-e78e04b4-0e36-433c-a4a0-bd6f158da675/REPORT.md`.

The coordinator changes only the new wrapper module and its broad fixture:

- A task-specific native-call lock plus pre-executor owner check rejects a new
  launch after ownership and serializes simultaneous fresh launches. Exact-child
  continuation remains allowed; different task siblings and recursive tasks use
  different locks. No project lock spans native execution, no persistent scheduler
  or speculative reservation/replay/cleanup runner is added.
- First context now includes bounded objective, complete declared task (title,
  brief, business role, parent-task and dependency keys) and dependency outcomes,
  separately from native binding identity. Native execution selections stay native.
- Registrations are explicitly typed; absent coordinator title falls back to its
  actual ID. Strict scoped typecheck now passes.

The extended real native fixture checks existing-owner duplicate refusal, two
fresh same-task calls while the first child request is held, one actual child,
one success/one error, and semantic first context including a nonempty completed
dependency. It compares persistent map/entries, not `generatedAt`. That fixture
passes on current source: **44 requests, 16 sessions, 490 events** at
`C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-wrapper-5XoNNj/`.
Strict scoped typing passes. Independent repeat closes original W1/W2/W3 at
**44 requests, 16 sessions, 490 events**, with a new source-derived W1-R:
invalid own-task/ancestor delegation waits on a lock held by its waiting parent
before caller validation. Evidence:
`C:/Users/Admin/AppData/Local/Temp/opencode/wrapper-closure-e8f60599-335f-4d68-8648-ec56ec840646/REPORT.md`.

The coordinator extends the existing real fixture with two nested invalid calls
(current task and in-flight ancestor), held provider requests and retained
before/after map/storage snapshots. The unchanged module **fails** waiting for
their return: **35 requests, 14 sessions, 389 events**, at
`C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-wrapper-8DgQlH/`.
This is a bounded observed stall, not an unbounded runtime guarantee.

The correction adds a read-only `admitted()` check **before** waiting on the task
lock and keeps the authoritative check **inside** its turn. No timeout/scheduler
or alternate executor is added. Current extended fixture passes:
**52 requests, 19 sessions, 575 events**, at
`C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-wrapper-QSnJta/`.
Both errors reach the actual child provider while its enclosing calls remain
in flight; no extra birth or Mission/contract entry changes occur. Legal work
then completes with two explicit reports. Existing depth-three execution,
different-task concurrency, same-task one-birth behavior, exact continuation,
dependency context and reload checks still execute. Strict scoped typing passes.
Independent W1-R correction closure now passes once on the same current bytes:
**52 requests, 19 sessions, 575 events**, strict scoped typecheck clean, **zero
remaining findings in that bounded correction review**. Actual errors are
consumed before either enclosing native call completes; all 68 retained private
entries and all Mission maps are equal across the negative step. Eight fixture
roots plus eleven actual native children are counted from session-created events.
Owned reviewer PID 27240 is absent; all 2,225 preserved primary entries/raw index
and 181 prior retained artifact files remain unchanged. Evidence:
`C:/Users/Admin/AppData/Local/Temp/opencode/wrapper-w1r-independent-23b78f93-07e6-45a1-ba14-5c54ea2a7c63/REPORT.md`.
This is not a zero-finding whole-feature review or approval to ship the private
sealed-plan module. Coordinator logs and before/after
source/preservation receipts:
`C:/Users/Admin/AppData/Local/Temp/opencode/wrapper-w1r-coordinator-QZULGT/`.
Earlier proofs describe their recorded source, not these changed bytes.

Per-task serialization is intentionally simple. It is not crash-atomic admission:
crash before persisted progress, arbitrary overlapping tools/child continuations,
dynamic plans and production signed authorization remain separate gates.

**The complete bounded foreground fixture PASSED on authenticated private OpenCode 2.0.22:** 34 provider requests, 13 native sessions, 379 events, including depth-3 native recursion and actual native plugin-storage reload persistence. This is an implemented adapter, not a replacement root-actor engine or a production rollout decision. Earlier failed fixtures remain preserved; the final run retains General's builtin deny instead of overriding it with global `allow *`.

Only new files under `scripts/native-subsession-spike/contract-wrapper/`, `packages/server/src/missions/native-subsession-experiment/contract-wrapper.ts`, and this document were written. No existing candidate file, production entrypoint, root validator, native executor source, dependency installation, real configuration, shared daemon, or user Mission map was modified.

## Small interface and usage

```ts
const contracts = await installNativeMissionContracts(ctx)
await contracts.seed({ missionID, coordinatorID, expectedRevision: 0, objective, tasks })
const proof = await contracts.inspect()
return () => contracts.dispose() // native plugin lifecycle cleanup
```

The factory takes the native plugin context; its returned interface has three methods: `seed`, `inspect`, `dispose`. Seed admission belongs in an authenticated coordinator-owned transport. The fixture uses a fresh private capability token, never a model-facing arbitrary-session mutation method. This does **not** substitute for the product's signed authority/worktree/environment checks.

Models use the existing actual native tool:

```ts
subagent({ agent: "recursive", description, prompt,
  mission: { missionID, revision: 1, taskKey: "level-one" } })
mission_contract_report({ contract: { missionID, revision: 1, taskKey: "level-one" },
  outcome: "completed", summary: "Explicit evidence" })
```

The coordinator seals the complete bounded contract/dependency map before execution. A task's `parentTaskKey` is either null (the coordinator launches it) or another declared task (that native child can launch this subwork). Descendants get no plan-writing tool. Calls without `mission` retain native behavior and can perform ordinary native subwork, subject to native permissions/depth. They do not acquire a separate Mission task or business-report authority.

The sealed contract revision is 1 and is separate from `MissionMap.revision`, which the reused reducer derives from journal event count. Revision changes are deliberately not implemented; wrong/unknown references fail before launch rather than silently rebinding. Dynamic coordinator revisions need an explicit later adapter, not descendant topology writers.

## Implementation seam and ordering

1. Reuse native `Tool.Info.input.mapFields` to add one optional structured envelope. All existing field-schema identities, name, description, output, namespace and options are checked unchanged. The captured original native `execute` remains the sole child creator/prompt/result machinery; options remain `{ codemode: false }`.
2. Read and validate the exact sealed contract, declared parent and completed dependency reports before native execution. Nothing is written by this preflight. Permission denial is still native; there is no raw executor RPC or alternate launch path.
3. Await structured native `progress.sessionID`. Read the actual child, verify its real `parentID` and Location, then persist `(parentID, actual tool.id, actual childID, assistant messageID, contract)`. Keys include both actual parent and call IDs; there is no guessed provider-call registration or prompt/description parsing.
4. Persist child bindings and actual production-format `task.dispatching` / `task.dispatched` events before returning from progress. The first child context reads that binding and emits the exact contract. The deterministic provider captures prove it is present in the **first** real child request.
5. Native foreground results return to the actual parent. Preserve their content and native metadata, add a report reference on that same return path when an explicit business report exists, and retain a separate returned receipt. No second synthetic notification or report outbox is created.

`MissionJournal`, `runMissionExclusive`, `stableToken`, `validateMissionReportArtifact`, and the actual Mission reducer are reused read-only from the candidate. Child actors are represented explicitly by their native session IDs; this private adapter does not pretend they are roots or loosen product `ownedRoot` acceptance. Storage is real `ctx.storage` in the private native database, not a Map substitute. The three-method seam hides binding, context injection, continuation ownership, business acknowledgement and native result covariance in one implementation.

The private project mutation lock is held only around bounded storage/journal operations, never across native child execution. Parallel siblings overlap provider requests. The current contract adapter is foreground-only and capped at three native edges; native configuration also sets `experimental.subagent_depth: 3`. Native defaults cap depth at 1. Existing journal limits remain 2,000 events / 96 tasks / 8 actors; large-map behavior beyond these limits is not qualified here.

## Real execution evidence

All commands were run with explicit workdir:

`D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003`

```pwsh
node scripts/native-subsession-spike/contract-wrapper/probe.mjs
node scripts/native-subsession-spike/contract-wrapper/run.mjs
node scripts/native-subsession-spike/contract-wrapper/default-permissions.mjs
node scripts/native-subsession-spike/contract-wrapper/verify-evidence.mjs
node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --module ESNext --moduleResolution Bundler --target ES2022 --types node packages/server/src/missions/native-subsession-experiment/contract-wrapper.ts
node --check scripts/native-subsession-spike/contract-wrapper/run.mjs
```

The CLI is exactly `C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe`, launched as an owned `serve --hostname 127.0.0.1 --port 0 --print-logs` child. HTTP server metadata—not the executable filename—confirmed 2.0.22. Client/plugin packages are installed 2.0.22, read through the read-only dependency junction. Each private run has its own approved Temp project, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG roots, config, database and dummy loopback provider. Final scripts inherit only a Windows execution-variable allowlist, not provider credentials or OPENCODE/CODENOMAD/XDG/WSL host keys. No install/upgrade, service discovery, synthetic tool context, or `ctx.tool.list().execute(...)` shortcut is used.

The shape probe succeeded at `C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-shape-1ayoni`: native input is an Effect Struct, and context exports its ordinary JSON Schema. Three purposeful fixture correction iterations were retained:

| Broad run directory suffix | Native calls / sessions / events | Result |
| --- | --- | --- |
| `8oCweR` | 4 / 2 / 49 | Default depth 1 blocked recursion; bundled Zod tool schema conversion unavailable |
| `VX8Exz` | 0 / 1 / 13 | Fixture's `z.toJSONSchema` unavailable in installed root Zod |
| `B2gNAs` | 11 / 4 / 122 | Native depth-3/report chain executed; RPC snapshot needed JSON normalization |
| `o6U6JH` | 35 / 14 / 383 | All earlier proof sections passed; final General-negative assertion failed because global `allow *` overrides the builtin deny |
| `HIV7Mc` | 34 / 13 / 379 | **PASS**, current source; General defaults preserved; complete bounded fixture and native storage reload |

Those roots all use prefix `C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-wrapper-`. Main provider budget is 200; total runtime watchdog is 220 seconds. Failed-run requests, events, transcripts, server logs and exact failure detail remain present. After the initial three correction iterations, explicit user steering authorized the supported native-permission configuration alternative: preserve General's deny and remove the fixture-wide override. That final full run passes; failures were not overwritten or hidden.

The independent **default-permission** proof passed at both `native-contract-default-kORuxM` and final-source `native-contract-default-DAhV5u`, under the same Temp parent. Each used **5 provider requests, 2 native sessions, 72 native events**. It omits broad `allow *`, demonstrates General's actual default recursion denial with no grandchild or contract bypass, accepts an exact explicit business report, proves native-parent consumption of the native return/report reference, and explicitly reloads the private Location runtime. Snapshot missions and all contract storage entries survive reload byte-for-byte as JSON. The scoped typecheck and esbuild bundle into the private plugin also passed.

Before final qualification, dependency-cycle validation gained memoization and fixture environments gained the stricter Windows allowlist. Both final broad and default-permission runs execute the current module/source. `verify-evidence.mjs` checks current module hash against the passing run, copies complete owned source files into its private artifact directory, checks native event-ID uniqueness/first-context bindings, and rehashes **all 2,225** original candidate files against the rollback manifest.

Actual depth-3 chain from retained broad proof `o6U6JH` (the final passing run's distinct identities are recorded in `acceptance-audit.json`):

```text
ses_efff52d47ffe2FB0hmuv3kKSta (root)
  -> ses_efff52d01fferLx3U30bxsVEUR (child)
    -> ses_efff52ccfffeoosdqK2CDHCCJo (grandchild)
      -> ses_efff52cacffeeA2NXy7mcg3xN8 (great-grandchild)
```

The retained broad proof's overlapping siblings shared parent `ses_efff52bc0ffee0sK1lhuIyeAS7`, agent, description, prompt, and assistant message ID `msg_1000ad451001FGLQpN07KOUIlF`, but had distinct runtime call IDs `call_894b64b2d205408d841dd60d11ceaf49` / `call_900e785fe85343d7af1c948d3afeb56b` and distinct actual child IDs. Both first provider requests were held simultaneously before either was released. The complete passing run repeats this independent wrapper proof with its own native IDs. Contract correlation is not dependent on text labels or serial completion order.

## Capability matrix

| Capability | Status | Evidence / qualification |
| --- | --- | --- |
| Real native root → child → grandchild → great-grandchild | CONFIRMED | Real `parentID` chain and first-context binding for three edges; configured all/subagent agents |
| Concurrent same-parent/agent siblings | CONFIRMED | Overlapping first model requests, same assistant message, distinct actual call/child IDs |
| Native input/options preservation | CONFIRMED | Struct field identity and other definition-field identity checks; unchanged options; live provider schema adds only envelope |
| Results consumed by actual native parents | CONFIRMED | Each parent's subsequent provider messages contain its actual child's terminal native output and business report reference |
| Continuation of exact child from same parent | CONFIRMED | No second child created; foreign parent rejected without another child provider request |
| Parent denies native subagent permission | CONFIRMED | Error tool result; no child; Mission map unchanged; no owner/binding |
| Wrong revision, unresolved dependency, wrong business acknowledgement | CONFIRMED | No launch/map change for preflight rejects; leaf's mismatched report rejected, exact report accepted |
| Native success ≠ task completed | CONFIRMED | Native child outcome succeeded; no explicit report; Mission task remains queued |
| General default recursion deny | CONFIRMED | Final broad and independent default fixtures: native catalog excludes subagent, attempted call errors, no grandchild |
| Global permission override of General deny | OBSERVED | Broad fixture's global `allow *` exposes/allows recursion; retained failed negative assumption |
| No duplicate synthetic report notification | CONFIRMED | Foreground transcript has no synthetic message; report reference uses native result |
| Durable map/storage across private native reload | CONFIRMED | Current-source broad and default fixtures; no FakeMap storage |
| Collision-free native event IDs | CHECKED by evidence audit | Captured stream IDs and journal-derived contract keys use real native identities |
| Coordinator-only plan admission | ENFORCED, not fully product-qualified | Authenticated private seed transport + real root/Location checks; no model-facing descendant plan writer |
| Background contracts, cancellation/pause, external host loss | UNKNOWN / NOT QUALIFIED here | Explicitly excluded, not an argument to abandon foreground native children |
| Per-child environment and production authority bridge | INTEGRATION GATE | Lane 4 / existing child-environment work; not claimed by this adapter |
| Crash between journal and contract writes; report/native failure races | UNKNOWN | Current separate JSON writes are not an atomic durable workflow transaction |
| Dynamic revisions, arbitrary-location children, >8-actor maps | NOT IMPLEMENTED / UNKNOWN | Sealed plan, exact owned Location, existing map actor cap |

## Error and integration contract

Unknown/stale ref, undeclared parent, unresolved dependency, foreign continuation, mismatched business acknowledgement, binding collision, disposed wrapper or unsupported schema fails closed without an alternate native invocation or mutation replay. Native permission errors remain actual native tool errors. Admission writes, context preparation, provider request dispatch, model consumption, native returned outcome and explicit business completion are different facts; the adapter never marks success from admission alone. A durable report currently projects the existing root-oriented `notificationStatus: pending`; no new outbox is invented to make that projection look settled. Future display integration must distinguish native-parent delivery/reference from root notification receipts.

The journal adapter's assignment `admissionID` currently records the actual **parent assistant message ID** available at native tool progress, not an asserted child user-inbox admission receipt. Contract binding is demonstrably pre-context; it is not proof that a child inbox item has already been durably admitted. Product integration must give that assignment-side identity its own field/phase rather than treating it as the existing root-dispatch inbox acknowledgement.

The proof supports pursuing the structured-envelope seam. It does **not** decide the overall Mission architecture or qualify lifecycle/authority/environment work owned by other lanes. Keep the old candidate and rollback untouched while those gates are considered.

## Subsequent mutable-contract integration

The sealed-plan ceilings and parent-message assignment note above describe the
historical W1-R source, not the subsequent assembled experiment. See
`MISSIONS_NATIVE_CONTRACT_INTEGRATION.md` for the changed scope and exact evidence.
The current experiment uses shared `task.native-bound` / `task.native-returned`
journal events, leaves `admissionId`/`delivery` unset for native binding, and
supports coordinator-controlled per-task generations, explicit native execution
choices and authorized different-task continuation of the same native child.
Its initial assembled coordinator/independent run passes **78/26/849**. A separate
review then finds capacity and failed-call/continuation projection defects;
corrected source passes **118/38/1295**, independently repeated, and the corrected
business/helper suite passes **375/375**. R1/R2 are independently closed for the
bounded process-local wrapper scope. An isolated explicit-child-selection native
control passes **10/2/122** at the coordinator and in its separate independent
repeat. Exact receipts, old-bundle reproductions and retained oracle failures are
in the integration document. These are not frozen whole-feature validation.
These changes do not qualify signed production authority, crash-atomic admission,
complete family ENV/lifecycle controls or desktop rollout.
