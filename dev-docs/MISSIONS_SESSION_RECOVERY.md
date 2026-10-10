# Authoritative session recovery

Date: 2026-10-02. Narrow implementation for mission
`msn_4666b8eba4241165c8bc49f5`, task `authoritative-session-recovery`.

## Contract and changes

### Additional isolated native evidence

`scripts/test-missions-native.mjs` now exercises the actual product reconciliation
functions against a private OpenCode 2.0.21 session: normal `succeeded` completion
clears a saved working marker; a queued synthetic with `resume:false` leaves the
historical outcome but does **not** resolve pending local admission; explicitly
resuming that private inbox produces a newer `time.idle` boundary and resolves
recovery. Run PASS:
`<TEMP>/opencode/missions-native-1osQGf`.
This supplements the deterministic store tests, not a real desktop quit/relaunch
or recursive cancellation guarantee. It performs no replay of user work.

The previous recovery inferred `interrupted` from a saved `working` marker plus
an idle activity map. This is not evidence of interruption: work can finish
successfully while the desktop is absent. Old saved `interrupted` markers can
also originate from that inference and are therefore revalidated, not trusted.

Installed `@opencode/client` 2.0.21 declares
`SessionInfo.outcome?: "succeeded" | "failed" | "interrupted"` and `time.idle` in
`node_modules/@opencode/client/dist/promise/generated/types.d.ts:2817-2836`.
The reliability audit records an actually running actor with an earlier
`outcome=succeeded`: outcome is historical, not current activity.

Recovery now reconciles these separate facts:

| Current native activity | Native last outcome | Projection |
| --- | --- | --- |
| Active / compacting | Any previous outcome | Active, no recovery marker; old outcome cleared |
| Idle | succeeded | Normal completion, no Interrupted marker |
| Idle | failed | `Session.outcome=failed`, no Interrupted marker |
| Idle | interrupted | Native Interrupted marker retained |
| Idle, saved work | Missing / unproven | `pending`, not inferred Interrupted |
| Activity unavailable | Historical outcome alone | Existing activity/recovery retained; no terminal inference |

`session-generation-recovery.ts` owns the projection and merge policy;
`session-api.ts` preserves native outcomes and wires it into list/runtime reads.
The activity read occurs after the list/inventory outcome reads and still does
not block publication of the root directory page. Active-only liveness refresh
reads native session info only for inactive rows with outstanding work/recovery,
then rechecks activity so unseen restarted work supersedes the historical outcome.

Minimal `session-state.ts` wiring passes outcome to saved-marker hydration and
clears the old outcome when native activity is observed or new input is admitted
(rollback restores the original outcome). An in-memory admission
epoch survives acknowledgement, fencing fetches even if recovery/status values
return to identical values. Queued/admitted idle input is not completed from an
old outcome: without observed active work, a newer native `time.idle` boundary
is required. Missing boundary evidence leaves it pending.
The admission captures that baseline separately as
`generationAdmissionIdleBoundary`. Non-blocking metadata publication can advance
`time.idle` while activity is unavailable without consuming the captured boundary.
Later authoritative list or liveness reads can therefore recognize the newer
completion; rollback restores the prior epoch/boundary as well as outcome.

The merge preserves activity/recovery/admission/outcome as an authority group
when newer SSE/local authority supersedes the captured baseline. Deletions,
instance/client-generation and abort fences remain intact. No native prompt,
interrupt, session update, automatic replay or new recovery dispatcher is added.
No dependency, backend, Mission component or script changes belong to this task.

## Validation

Real store regressions use isolated in-memory clients, the actual `fetchSessions`,
`refreshSessionRuntimeStatus`, hydration/admission stores and native event handler.
Mutation stubs fail immediately if recovery attempts a prompt/interrupt/update.
They cover saved working **and legacy interrupted** markers across all outcomes,
delayed activity, active-over-old-outcome, SSE/fetch races, admissions completing
while a fetch is pending, acknowledged queued input, newer idle boundaries and
an activity restart without SSE during an outcome lookup.
Two additional store regressions cover acknowledged input at idle boundary 2,
provisional successful metadata at boundary 4 with a failed activity read, then
authoritative reconciliation through either list or runtime refresh. Both retain
pending recovery during unavailable activity and resolve the proven success later.
The focused admission/recovery/startup suites now pass **50/50**, with UI
typecheck passing. A startup fixture's `session.get` stub was added to match the
already-delivered native outcome lookup; native read behavior was not weakened.
Independent bounded re-review closes the baseline finding, repeating 50/50 tests
and UI typecheck. Private actual-store probes confirm repeated failed reads retain
the admission baseline, authoritative list/runtime reads resolve the newer success,
historical idle remains pending, stale fetches cannot settle newer admissions,
overlap retains the first boundary and rollback restores prior authority fields.
No native mutations occur. The separate Mission visibility/event findings remain
open; this is not whole-UI or whole-refactor acceptance.

Executed successfully: **121 tests, 121 pass, 0 fail**:

```powershell
node --conditions=browser --import tsx --test --test-force-exit packages/ui/src/stores/session-generation-recovery.test.ts packages/ui/src/stores/session-generation-recovery-integration.test.ts packages/ui/src/stores/session-generation-admission.test.ts packages/ui/src/stores/session-native-events.test.ts packages/ui/src/stores/app-session-workspace-hydration.test.ts packages/ui/src/stores/session-request-authority.test.ts
```

The browser condition is required by transitive Solid/solid-toast imports.
Without it, store suites fail at import with a client-only API error. These
store suites leave singleton background handles alive; `--test-force-exit`
terminates only the completed test workers, not an application or daemon.
An earlier invocation without that flag timed out after a completed hydration
test; no product process was restarted or stopped.

UI typecheck was initially green, then concurrently changing Mission contracts
introduced this unrelated gate failure on two intermediate runs:

```text
npm run typecheck --workspace @codenomad/ui
src/stores/mission-store.test.ts(7,64): TS2322
Property 'activity' is missing ... required in 'MissionListAvailableResponse'.
```

No files outside the assigned recovery scope were edited to bypass that error.
The parallel owner's fixture update resolved it; the final UI typecheck passed.

## Limits / next validation

- This is real-store validation with deterministic native-read fixtures, **not**
  a new end-to-end native daemon/provider or rendered-desktop quit test. The
  desktop, shared daemon, user profiles/storage and live sessions were untouched.
- `failed` remains distinct in the native outcome field; this task adds no new
  failure badge or Mission component. Missing outcome remains unknown.
- Existing terminal SSE handling is unchanged: native interruption events still
  set their proven marker and its stale-event tests pass. An idle event alone
  cannot settle pending work; authoritative outcome reads reconcile it later.
- The admission epoch is deliberately window-local, not persisted as a new
  execution identity. Native outcome has no execution ID in this client contract.
  Qualify queued-input `time.idle` behavior with the coordinator's isolated native
  continuity fixture; absent a newer boundary, recovery conservatively stays pending.
- Request independent review of the recovery diff and merge/admission fences.
- Existing oversized touched files: `packages/ui/src/stores/session-api.ts`
  approximately 1,985 lines; `packages/ui/src/stores/session-state.ts`
  approximately 1,375 lines. No unrelated size-only refactoring was performed.
