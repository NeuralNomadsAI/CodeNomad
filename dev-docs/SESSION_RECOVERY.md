# Authoritative session recovery

## Contract

Restored workspace state is keyed by execution server and directory. A missing
server ID selects `local-shared`; an explicit unknown ID retains its own saved
data. Seeding into a live occurrence checks that durable identity. Asynchronous
hydration additionally captures the client and native data generation and checks
the caller's removal/binding fence before publication. Replaced sources and closed
occurrences leave the preserved snapshot available for an authorized reopening.

Explicit occurrences absent from the backend reopen on their saved server and
directory. Their saved drafts, attachments, catalogs and selected tab remain in the
window graph across capture/reload. Recovery uses the existing capability guards
for pending requests and worktree inventories. The backend connection owner reuses
the profile's privately persisted pairing token or password across restarts.

Pending request display and reply admission have separate lifetimes. Known drafts
remain mounted through connection gaps; explicit live-only projects retain unknown
coverage after disconnect and backend restoration, including empty local queues.
Current live events restore their exact request's response admission. A held Form
also supports an explicit source-editor check of its native state; pending state
with matching editor fields admits only that captured Form, while terminal and
indeterminate states retain drafts with response actions blocked. One check uses
the shared secondary budget, a ten-second total deadline and four-MiB native
responses. Newer events and source/transport/placement retirement fence its result.
Placement retirement follows every accepted publication, so a move away and back
retains the retired result and reply admission until a new valid check or current
Form event. Matching initial hydration and same-placement metadata keep the owner.
The Form editor composes its check result and earlier uncertain reply into one
polite region; a pending read retains the earlier attempt's uncertainty. Its check
control keeps source keyboard focus while guarded and after pending completion.
Permissions await a current live event. Overall coverage remains unknown. Opening
a conversation reads its supported conversation state while leaving pending
discovery inactive. The dock's source details retain the server, stable ID and
opaque native directory. Current live candidates retain the captured connection and status boundary
while compatible metadata arrives, independently of HTTP/status publication order.
Matching metadata qualifies only those held candidates; older queues stay stale.
Backend transport, client, native-data, binding and session placement retain their
own fences. See [Native interruptions](NATIVE_INTERRUPTION_UX.md).
Capability snapshots also retain their backend-transport publication owner. A
fresh matching snapshot can qualify a current event after backend restoration,
including a reset connection counter; prior-transport display values stay stale.

Explicit catalog seeding retains only rows whose native Location exactly matches
the occurrence binding. Targeted hydration rereads requested native identities,
checks Location and current request authority, and follows at most 200 ancestor
IDs. A missing or foreign ancestor leaves the in-directory child as a display root;
selection restoration uses that same truncated-chain projection while preserving
native parent metadata. Inventory pages arrive on demand, and only a qualified
terminal exact inventory reconciles absent rows with concurrent-update fences.

`scripts/test-missions-native.mjs` also runs this reconciliation against a private
native session: `succeeded` clears a saved working marker; a queued `resume:false`
synthetic keeps the historical outcome and does not resolve pending admission;
resuming it yields a newer `time.idle` boundary that does.

Never infer interruption from a saved `working` marker plus idle activity (work can
finish while the desktop is absent); saved `interrupted` markers are revalidated
against native state. Native `outcome` records the last finished turn only.

Recovery reconciles these separate facts:

| Current native activity | Native last outcome | Projection |
| --- | --- | --- |
| Active / compacting | Any previous outcome | Active, no recovery marker; old outcome cleared |
| Idle | succeeded | Normal completion, no Interrupted marker |
| Idle | failed | `Session.outcome=failed`, no Interrupted marker |
| Idle | interrupted | Native Interrupted marker retained |
| Idle, saved work | Missing / unproven | `pending` |
| Activity unavailable | Last outcome alone | Existing activity/recovery retained |

`session-generation-recovery.ts` owns the projection and merge policy;
`session-api.ts` preserves native outcomes and wires it into list/runtime reads.
The activity read occurs after the list/inventory outcome reads, without blocking
publication of the root directory page. Active-only liveness refresh reads native
session info only for inactive rows with outstanding work/recovery, then rechecks
activity so unseen restarted work supersedes the last outcome.

`session-state.ts` passes outcome to saved-marker hydration and clears the old
outcome when native activity is observed or new input is admitted (rollback restores
the original outcome). An in-memory admission epoch survives acknowledgement,
fencing fetches even if recovery/status values return to identical values.
Queued/admitted idle input completes only on observed active work or a newer native
`time.idle` boundary; missing boundary evidence leaves it pending.
The admission captures that baseline separately as
`generationAdmissionIdleBoundary`. Non-blocking metadata publication can advance
`time.idle` while activity is unavailable without consuming the captured boundary.
Later authoritative list or liveness reads can therefore recognize the newer
completion; rollback restores the prior epoch/boundary as well as outcome.

The merge preserves activity/recovery/admission/outcome as an authority group
when newer SSE/local authority supersedes the captured baseline. Deletion,
instance/client-generation and abort fences apply. Recovery never prompts,
interrupts, updates a session or replays anything automatically.

Metadata merges share inventory request ordering and retain a weakly held HTTP
row baseline through native/local edits and pending/status projections. Fields
from an earlier HTTP snapshot can be refreshed by a current targeted read;
concurrent metadata changes retain precedence field by field. Runtime merges
continue using the row captured before the read for their authority group, and
runtime-only reads retain the metadata snapshot's provenance.
Transcript-derived agent/model fallback and partial native creation updates inherit
the held row's baseline through `withSession`; native changes keep their field-level
precedence while untouched fields remain refreshable from that HTTP snapshot.

## Display acknowledgement

`session-interruption-seen.ts` owns per-window, per-project-tab acknowledgement
watermarks keyed by session ID and the native `time.idle` boundary. The session
list's explicit badge click and sweep acknowledge
Interrupted through `markSessionInterruptionSeen`. Viewing a visible, focused
conversation clears only Idle through `markSessionIdleSeen`. Native outcome,
recovery, admission and pending-request facts keep their existing authority.

The native interruption event claims acknowledgement authority before its activity
read. It invalidates the prior acknowledgement and uses the event timestamp while
SessionInfo catches up. The accepted runtime merge retires that association once
the native idle boundary reaches the event timestamp. It extends a gap-time clear
only when native `time.busy` identifies a run started at or before the acknowledged
event; a later or unknown run start leaves the watermark unchanged.
An observed `session.execution.started` retires the pending association while
preserving the clear, including when successive native events share a timestamp.
Acknowledgements stay monotonic through older metadata, and later event
continuations preserve intervening clears. A newer native idle boundary shows
interrupted attention again; the same or an older boundary preserves acknowledgement
across refresh/reconnect.
Work and pending input/permission always retain priority.

`seenInterruptions` persists beside idle and recovery markers in window client
state, including each session's content-addressed leaf. Capture and hydration use
native graph byte/partition budgets and unavailable-session preservation; live
event tombstones fence late snapshot hydration. Native settlement past an
acknowledged boundary drops its marker. Authoritative deletion and inventory
pruning release both per-session maps; instance removal releases the whole scope.
Restoration revalidates recovery separately against native
activity/outcome while preserving the acknowledged boundary.

## Validation

Store regressions use isolated in-memory clients and the real stores; mutation stubs
fail on any prompt/interrupt/update. Run (the browser condition is required by Solid
imports; `--test-force-exit` only ends test workers):

```powershell
node --conditions=browser --import tsx --test --test-force-exit packages/ui/src/stores/session-generation-recovery.test.ts packages/ui/src/stores/session-generation-recovery-integration.test.ts packages/ui/src/stores/session-generation-admission.test.ts packages/ui/src/stores/session-native-events.test.ts packages/ui/src/stores/app-session-workspace-hydration.test.ts packages/ui/src/stores/session-request-authority.test.ts
```

## Limits

- `failed` is a distinct native outcome; a missing outcome is unknown.
- Native interruption events set their proven marker. Only authoritative outcome
  reads settle pending work; an idle event alone never does.
- The admission epoch lives in window memory, because native outcomes carry no
  execution ID. Qualify queued-input `time.idle` behavior with
  `scripts/test-missions-native.mjs`; absent a newer boundary, recovery stays pending.
