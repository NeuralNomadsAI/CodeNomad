# Authoritative session recovery

## Contract

`scripts/test-missions-native.mjs` also runs this reconciliation against a private
native session: `succeeded` clears a saved working marker; a queued `resume:false`
synthetic keeps the historical outcome and does not resolve pending admission;
resuming it yields a newer `time.idle` boundary that does.

A saved `working` marker plus idle activity is not evidence of interruption (work can
finish while the desktop is absent), so old saved `interrupted` markers are
revalidated, not trusted. Native `outcome` is historical, never current activity.

Recovery reconciles these separate facts:

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

## Validation

Store regressions use isolated in-memory clients and the real stores; mutation stubs
fail on any prompt/interrupt/update. Run (the browser condition is required by Solid
imports; `--test-force-exit` only ends test workers):

```powershell
node --conditions=browser --import tsx --test --test-force-exit packages/ui/src/stores/session-generation-recovery.test.ts packages/ui/src/stores/session-generation-recovery-integration.test.ts packages/ui/src/stores/session-generation-admission.test.ts packages/ui/src/stores/session-native-events.test.ts packages/ui/src/stores/app-session-workspace-hydration.test.ts packages/ui/src/stores/session-request-authority.test.ts
```

## Limits

- `failed` remains distinct in the native outcome field; missing outcome remains unknown.
- Existing terminal SSE handling is unchanged: native interruption events still
  set their proven marker and its stale-event tests pass. An idle event alone
  cannot settle pending work; authoritative outcome reads reconcile it later.
- The admission epoch is deliberately window-local, not persisted as a new
  execution identity. Native outcome has no execution ID in this client contract.
  Qualify queued-input `time.idle` behavior with the coordinator's isolated native
  continuity fixture; absent a newer boundary, recovery conservatively stays pending.
