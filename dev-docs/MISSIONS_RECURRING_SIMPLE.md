# Recurring Missions — simple native contract

Authoritative user decision: **2026-10-08**.
This is the recurring-missions target, not a claim of implementation or acceptance.
It supersedes historical recurring authority and acceptance requirements wherever
they require signatures, grants, epochs, effect receipts/budgets or event-log replay.
One-time Missions published in PR #866 retain their existing receipts and are not
refactored here. The simple Wayfinder UI-answer mark below applies to both modes.

## Product boundary

Scheduled work runs in the OpenCode service/plugin with the CodeNomad UI and
intermediary backend closed. Neither a persistent CodeNomad backend nor a window
timer satisfies this contract. Do not modify OpenCode to implement it.
Creation stores a paused schedule; it never starts work or arms a timer.
Explicit user controls and native execution are separate responsibilities.

## Schedule document and revision

Store one schedule document in project-scoped plugin kv, including:

- `id` and a user-visible `title`.
- Instructions and daily `clock: { time, zone }`.
- Frozen coordinator/role profiles, `taskMode` and template.
- Watched conversations and their processed-message cursors.
- Desired `state: paused | running | stopped`; stopped is terminal.
- `lastDaily`, identifying the last settled scheduled civil day.
- `pending`, either null or the exact passage identity and its progress.
- Result history bounded to **30** entries.
- A monotonically checked custom `revision`.

Native kv provides **no CAS**. The plugin must serialize document updates and
compare the supplied expected revision before committing the new revision.
A read followed by an unguarded write is not CAS. Controls, due admission and
settlement use the same guarded document mutation path; concurrent attempts
cannot replace each other's pending identity or lose an archive.
Keep this small: no authority epochs, signing keys or per-effect ledgers.

## User controls

Create paused, Play, Pause, Stop, Resume and Run now are admitted only through:

1. The authenticated CodeNomad UI/backend route.
2. The existing HMAC-authenticated bridge.
3. The plugin's schedule-control RPC.

Never expose these controls as model tools. Validate project/Location ownership,
connection identity, inputs and frozen execution profiles at the existing boundary.
Each control has `requestID` idempotency and `expectedRevision` CAS.
A duplicate request must not start a second Job, passage or coordinator message.
A stale revision is a conflict, not permission to overwrite current state.

If a reply is lost, retain that request identity and reread its status.
Refresh, reconnect, remount and status reads never automatically resend it.
An uncertain control must not be replaced with a fresh request to evade the hold.
Explicit Resume is a new user action, not an automatic retry of an unknown send.
Stopped schedules cannot be played, resumed or run now.

## Honest threat model and rationale

HMAC authenticates the ordinary desktop bridge; it is not an OS sandbox.
An agent with unrestricted shell can read the service password and kv database.
No in-process mechanism, including signatures, prevents that agent from acting
with the service's own privileges. Native shell permissions and OS isolation are
the real security boundary. Do not describe simple marks as tamper-proof proof.

Ed25519 parent/child grants, signed standing authorization, epochs, effect budgets,
per-effect reservations/receipts and signed human-answer receipt state machines
are removed from recurring passages. They complicated ordinary useful work and
restart reconciliation without providing the claimed unrestricted-shell boundary.
Native execution identities, guarded schedule updates and conservative observation
cover the narrower product need. Unknown effects still remain unknown.
Existing ownership, authentication, permission and data-loss protections remain.

## Native guarantees and missing primitives

The implementation relies on existing native contracts, qualified at their callers:

- Session creation with a caller-supplied session ID is idempotent.
- Prompt admission with a caller-supplied message ID is first-admission-wins.
- Plugin tools receive native session, message and call identity.
- Jobs are process-local and disappear when the service restarts.
- A turn holds a durable execution claim (`session_v2.time_suspended`) until its
  terminal event. A hard kill leaves the claim with no terminal event. Observed
  with OpenCode 2.0.26 and an owned unmanaged `serve` (evidence `f60TKB`): after
  restart the coordinator stayed inactive with no resumed provider turn. Upstream
  sources sweep orphaned claims only in the managed service at boot; that path is
  not qualified here. Do not rely on native continuation.

First admission is not proof of model consumption, useful work or completion.
Resume never sends a continuation or replacement coordinator prompt. A claim
written before the current service process started and not live now is a turn
cut by a restart: once the rest of the family is quiescent, the passage settles
`ended-without-report` with reason `interrupted` ("Interrupted by a restart").
If native work later resumes such a claim anyway, its effects remain unknown.
These guarantees do not make arbitrary shell/tool side effects exactly-once.

Missing primitives are handled honestly:

- No native kv CAS: implement the small revision guard above.
- No native family-settled operation: observe the whole passage family and queues.
- No native Form answerer identity: use the simple backend UI-answer mark below.

Qualify actual capabilities/contracts, not an untested-version allowlist.

## Scheduler and civil time

Keep **one native Job per running schedule** in the live OpenCode process.
It sleeps until `min(nextDueAt, now + 1h)`, then rereads the wall clock and document.
This hourly ceiling bounds clock-change detection; it is not per-minute polling.
A native `session.execution.succeeded|failed|interrupted` publication (Bus
`listen`) also wakes the Job after a 3 s debounce, so settlement follows family
quiescence in seconds; it is only a wake hint. Without that native contract the
Job falls back to 30 s → 2 min → 5 min (capped) only while a passage is pending.
On waking, verify desired running, no conflicting pending passage and a due
civil day newer than `lastDaily` before attempting the guarded passage start.
If several days were missed, admit the **latest missed day only**, never a backlog.

Use the saved time zone and daily civil clock rather than 24-hour elapsed timers.
Preserve the clock contract for DST gaps, advancing day-end gaps; a wholly skipped
civil day has no passage. Repeated clock hours must not create two daily passages.
A wall-clock rollback must not make an already processed day new again.
`nextDueAt` is a display projection, not execution authority.

Pause and Stop cancel the schedule Job and interrupt the pending passage's registered root coordinator, without proving that coordinator or its descendants stopped; Stop is terminal.
Neither control alone proves the coordinator or descendants have stopped.
Retain pending passage identity and observations rather than clearing live work.

Desired running without a live native Job is displayed as **Interrupted** with
an interruption reason. Service restart therefore leaves scheduling Interrupted.
Do not rearm from plugin load, a read, UI reopen or backend reconnect.
Only explicit Resume may restore scheduling; pending work is reconciled first.
Scheduler-interrupted is not passage-stopped; a passage cut by the restart settles
as interrupted after Resume rather than waiting for a native continuation.

## Write-ahead passage start and recovery

Daily and manual passages use the same start/observation/settlement path.
Before any native effect, CAS-write a pending record containing:

- Deterministic `passageID`.
- `coordinatorSessionID`.
- Caller `messageID` for the coordinator's original instructions.

The daily identity is tied to its schedule/civil day; a manual identity is tied
to the accepted Run now request. Never use recovery to invent a new identity.
Create/admit only the original native identities after the pending commit.
If a crash occurs, inspect the exact native session, message and inbox.
Never resend under a new identity or infer missing work from a lost RPC reply.

Resume is allowed when a passage is pending, but it is **reconcile-only** for that
passage: no second coordinator message. Unknown native coverage leaves pending
uncertain and blocks a further passage. No expiry converts unknown into safe replay.
Run now cannot overlap an unresolved pending passage or bypass terminal Stop.
Manual runs do not masquerade as a different scheduled civil day's completion.

## Passage tools and journals

Register `mission_*` tools independently of CodeNomad backend presence.
Use native session identity to route a passage and its actors to its isolated
journal; otherwise route to the one-time journal. Do not accept arbitrary journal
selectors from the model. Native message/call identity remains available for
ordinary tool admission and journal ownership, not a new effect-receipt layer.

Native permissions govern every other tool. Read, shell, ordinary subagents and
business tools are allowed under those permissions; there is no Mission whitelist
and no per-tool receipt requirement. Preserve frozen profiles and taskMode.
Both native descendants and passage-owned independent actors must be accounted
for without inventing ancestry from task dependencies.

## Settlement, result and watched cursors

Settlement requires the coordinator and **all descendants** to be inactive,
their inboxes empty, no applicable pending Form/permission, and no running Shell
or background subagent. Passage-owned independent actors also cannot remain live.
Activity alone is insufficient; a final report alone is insufficient.
Use bounded native observations, recheck identities and retain pending on unknown,
incomplete or over-bound coverage. No exact event-log replay proof is required.

Supported outcomes are:

- `completed`: the settled passage has a final report.
- `failed`: native terminal failure, not guessed from prose or an idle flag.
- `ended-without-report`: settled native work ended without a final report;
  reason `interrupted` when a family claim was cut by a service restart.

Atomically archive the result, clear pending and update the scheduled `lastDaily`
in the guarded schedule document. Keep history at ≤30; do not let a crash between
separate document writes permit a second passage for the same settled day.
Advance watched processed-message cursors **only on completed**.
Failed and ended-without-report leave those cursors unchanged.
Keep watch cursor continuity when a watch is removed; removal does not prove
unprocessed source messages were consumed. No signed source-read receipts.

## Wayfinder human decision mark — both execution modes

When the user answers a native Form through CodeNomad's InterruptionDock, the
backend records `{ formID, sessionID, answeredAt, via: "ui" }`.
The Wayfinder human gate accepts only a native Form with the matching UI mark.
An ordinary native answer without that mark is not a proven UI human decision.
Do not infer identity from answer text, tool completion or the agent's assertion.

There are no signatures or reserved/replied/settled answer receipts.
OpenCode does not record answerer identity natively. Keep the ordinary answer
path's ownership and uncertainty checks; missing evidence leaves the gate unmet,
never causes automatic answer replay. This replaces signed answer provenance in
both one-time and recurring Wayfinder, not unrelated one-time lifecycle receipts.

## Per-schedule snapshot

Expose `id`, `title`, `clock`, display `nextDueAt`, revision and available actions.
Expose state including Interrupted and `interruptionReason` when applicable.
Expose pending status `starting | running | settling | uncertain`, exact identity,
latestResult and history. Do not expose epochs/grants/receipts/budgets.
Actions reflect terminality, unresolved controls and pending passage state.
Read-only projections and invalidations never start work or settle unknown sends.

## Acceptance journeys

1. **Daily useful work:** create paused → explicit Play → close UI/backend → due
   passage uses ordinary read/shell and Mission tools → final report → whole family
   settled → atomic archive → next day's passage. Verify no overlapping passage,
   one Job and one coordinator message, frozen profiles and completed-only cursors.
2. **Restart with pending:** restart the service during a pending passage → reopen
   shows Interrupted → explicit Resume reconciles existing session/message/inbox →
   no second coordinator message → settled archive (`ended-without-report` /
   `interrupted` when the restart cut the turn) → next day. Missing/uncertain evidence stays pending, not silently rearmed.
3. **Run now:** explicit authenticated Run now uses the shared write-ahead path;
   duplicate request/status reads produce no second passage. An unresolved pending
   passage blocks overlap. A lost reply is reread, never automatically resent.
4. **Pause/Stop:** cancel the Job, verify no later due admission; pending work is
   still observed honestly. Pause can be explicitly resumed; Stop cannot. Exercise
   CAS conflicts and cancellation uncertainty without claiming recursive suspension.
5. **Human gate:** native UI Form answer has the matching mark in both modes;
   an agent/native answer without it does not satisfy Wayfinder's human gate.

These are integrated journeys, not acceptance inferred from an isolated helper.
Native tests must use isolated service/database/provider fixtures, never the shared
daemon or user Mission. No install, daemon mutation or push is authorized by this doc.

## Out of scope

- Refactoring PR #866's one-time execution, lifecycle or cleanup receipts.
- Reintroducing signed standing/child authority or per-tool effect accounting.
- Exact event-log replay settlement or exactly-once arbitrary external side effects.
- Unattended cold wake, automatic scheduler restoration or missed-day backlog replay.
- A persistent CodeNomad backend, browser timer or upstream OpenCode modifications.
- OS isolation implementation or security against unrestricted same-user shell.
- Legacy namespace migration, automatic unknown-effect replay or disk reclamation.

Historical branch work remains preserved; superseded evidence is not deleted and
does not qualify this simplified contract. See `MISSIONS_REFACTOR_VALIDATION.md`.
