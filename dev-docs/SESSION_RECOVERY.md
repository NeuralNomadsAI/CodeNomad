# Authoritative session recovery

## Contract

`scripts/test-missions-native.mjs` checks a private native session: `succeeded`
clears a saved working marker; a queued `resume:false` synthetic preserves the last outcome
and pending admission; resuming it yields the newer `time.idle` boundary that settles admission.

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
Deferred statuses sharing an in-flight metadata read publish only while their
native lifecycle generation is current.

## Display acknowledgement

Remote app-tab Retry rebinds the saved server's inventory and runs this same read-only hydration. Explicit Open can create a missing workspace. See [remote opening ownership](PROJECTS.md#remote-opening-ownership) for placeholder preservation, cancellation and uncertain creation.

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
## Blank-session cleanup

Automatic cleanup and confirmed Scrub Sessions share `POST /api/workspaces/:id/session-cleanup/:sessionId`. Renderer checks preserve local drafts, attachments and generation admissions. The backend checks native ownership and the worktree deletion fence, rejects schedule carriers, archived sessions, forks and staged reverts, and requires a complete empty children page, no pending Forms or permissions, an empty inbox, an inactive session and a complete empty message page. The message proof and final protection lookup immediately precede native removal. Failed or incomplete proofs skip the candidate. Explicit row deletion uses its own confirmation and native proxy path.

The cleanup reservation is keyed by native session ID across every workspace in the backend. Addressed proxy writes and favorite additions for the reserved session or its descendants conflict with it. Favorite protection covers all stored scopes, including closed and narrower folders. The backend reuses its validated protection index while the state file identity and timestamps match.

Closing the client cancels preflight. After dispatch, cleanup and addressed native proxy writes keep their reservation through native settlement independently of that client. A lost acknowledgement or uncertain upstream failure leaves an in-memory hold for that ID; expiry never establishes cancellation and does not replay a write. A native deletion event or a current connection’s exact absence can retire the hold. A surviving session with an unprovable outcome stays held for the backend lifetime. `SessionRemoveInput` takes only `sessionID`; native clients and other backends can still write between the last proof and removal.

Local edits abort the requesting window's cleanup demand. Confirmed cleanup and unrequested native deletion recover unsent text and attachments together in the same tab. Startup and project reopening use the same transfer for a deletion tombstone or an exact native `SessionNotFoundError` for the draft's own session. Transport errors and ownership refusals leave the draft unresolved. Complete inventory refreshes may evict display rows and their runtime caches; draft text, attachments and their authority stay under the original session ID. Capture transfers saved prompts before merging deletion tombstones and retires the transferred source; recovery and explicit clears carry authority against replay. If the new-conversation composer is occupied, **Switch draft** swaps whole bundles in the existing client-state draft graph. Each draft keeps its text and references under the existing budgets.

Validation: the cleanup and instance proxy tests use held native requests and real downstream socket closure; they cover both admission orders and ambiguity. The isolated browser fixture checks the text and attachment bytes accessible in the recovery composer.

On reopening, prompt hydration supplies the tab's own snapshot before claiming vault bundles. An exact saved `workspaceId` in the same folder grants precedence to the vault's text, attachments and clears for that occurrence. Undelivered bundles return to their original owner after a failure or early close. Once delivered, the current bundle follows the receiving occurrence, and closing it retires the predecessor's saved copy. A plain folder opening fills empty, untouched slots from shared content or from a sole delivered successor without a competing bundle. An identified sibling uses its own saved state and matching bundles. Capture includes unresolved claimed bundles. A point-read absence carries the workspace/client generation and exact session record seen at admission; transfer and deletion recheck the proof per session after sibling reads settle.

The owned native `POST /api/experimental/session/:id/wait` observes execution settlement. It follows read admission and cancellation. Only writes reserve the session against cleanup or retain a hold after an uncertain native result.
