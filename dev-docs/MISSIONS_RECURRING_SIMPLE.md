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
The UI's single **Create** button only creates; the schedule runs after its separate
explicit Play, whose requests carry the then-current revision so CAS refuses a
duplicate. Creation is never resent. New schedule titles follow the
Mission title rule (1–60 characters); stored schedules keep their 120-character bound.
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

Create paused, Play, Pause, Stop, Resume, Run now and Check passage are admitted only through:

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

A schedule document keeps at most 64 control records. Admitting a new control
evicts the oldest completed record; unresolved records are never evicted, and an
evicted request's exact status reads unknown, which never authorizes a resend.
A Play/Resume/Check whose Job or observer start stayed unknown is resolved by a
later completed control that restarted or cancelled it. A Play/Resume whose native
Job start fails while a fresh read positively shows no running daily Job completes
its record with the schedule Interrupted (reason `error`), releasing the backend
permit for an explicit Resume/Pause/Stop; a failed or running read stays unknown.
Nothing retries the start. A Run now is resolved by
its own passage's admission or archive; archiving also resolves Checks of that
passage. Pause/Stop on a reserved passage without a journal mission has no actor
to interrupt (dispatch of an unadmitted passage is refused once paused/stopped).

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

An unadmitted pending passage is reconciled by reading natively whether its
deterministic start message exists (delivered or inbox):

- Present: record the admission and continue observing.
- Absent, and the start input can never be built (watched conversation deleted or
  moved, input capacity) or the schedule no longer allows dispatch: archive
  `failed` with reason `not-started`. This is the only archive without an
  admission; nothing was sent, so nothing can replay. The coordinator session is
  kept, `lastDaily` advances normally and watched cursors do not.
- Absent for a transient cause: retry admission on a later wake with the **same**
  session and message identities (native first admission wins), never a new one.
  Retry applies only while no admission was ever recorded. Once recorded, a later
  native absence of the start message (pruned history) is observed history: the
  passage settles by family quiescence and the message is never sent again.
Run now cannot overlap an unresolved pending passage or bypass terminal Stop.
Manual runs do not masquerade as a different scheduled civil day's completion.

Run now without a live schedule Job (paused, or Interrupted after a restart)
starts a separate **settlement-only observer Job** using the same sleep/wake seam,
including the native execution-event wake and the pending fallback backoff. It is
reconcile-only (never a second coordinator message; at most the original start
identity while dispatch is allowed), never starts daily passages and exits once
the passage settles. Pause cancels it. Stop keeps (restarts) it for a pending
passage so the passage still archives honestly; the schedule stays terminal. A
live running schedule's own Job observes its manual passage instead. After a
service restart with a pending passage on a paused or stopped schedule, the
snapshot offers an explicit **Check passage** (`check`) control, admitted like the
others (requestID, expectedRevision, authenticated route), which only restarts
that observer and keeps the schedule paused or stopped.

A failed wake does not end the Job. It records a display-only `lastError
{ code, at }` in a sibling kv key (outside the document revision) and retries with
a capped backoff (30 s, 2 min, 5 min, 15 min, 1 h). The next successful wake clears
it. Only definitively fatal causes (Location or Job binding gone) end the Job as
Interrupted with reason `error`; a missing or stopped schedule simply exits.

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

- `completed`: the settled passage has a final `mission_report(outcome: "completed")`.
  It stands even if a native failure occurs later during wrap-up.
- `failed`: either a final business `mission_report(outcome: "failed")`, or a native
  terminal failure in the family without a completed final report. Never guessed
  from prose or an idle flag.
- `ended-without-report`: settled native work ended without a final report and
  without native terminal failure; reason `interrupted` when a family claim was
  cut by a service restart.

Atomically archive the result, clear pending and update the scheduled `lastDaily`
in the guarded schedule document. Keep history at ≤30; do not let a crash between
separate document writes permit a second passage for the same settled day.
Advance watched processed-message cursors **only on completed**.
Failed and ended-without-report leave those cursors unchanged.
Keep watch cursor continuity when a watch is removed; removal does not prove
unprocessed source messages were consumed. No signed source-read receipts.

## Wayfinder human decision mark — both execution modes

When the user answers a native Form through CodeNomad's InterruptionDock, the
backend records `{ formID, sessionID, answeredAt, via: "ui" }` in two phases:
a `pending` mark with a fresh `attemptID` before forwarding, promoted to
`confirmed` only after the native reply returns positively for that attempt.
A definitely failed forward (Form still observed pending) removes the mark; a
lost/uncertain reply leaves it pending forever. Pending never qualifies, so a
later non-UI answer cannot borrow an earlier failed UI attempt; Wayfinder may ask again.
The Wayfinder human gate accepts only a native Form with the matching confirmed UI mark.
An ordinary native answer without that mark is not a proven UI human decision.
A refusal reaches the model as "Human decision required: the user must answer this
question from the CodeNomad interface", with the gate's cause as a detail.
The shipped bundle publishes no native task binding, so the gate also proves the
decision session natively: a fresh child of the expected parent's exact `subagent`
call whose prompt carries the declared assignment. Native 2.0.26 `serve` writes no
`event` rows; answers and execution failures are read from durable message
projections (completed question part, `idle` outcome).
Do not infer identity from answer text, tool completion or the agent's assertion.

Only Forms whose session belongs to a Mission family take the mark path: a root
with `codenomad.mission` metadata, or a metadata-less root (an attached
existing coordinator) that the plugin finds as the coordinator actor of a
Mission in the project's durable one-time journal, after walking the bounded
native parent chain to exactly that root. Every other Form uses the ordinary
native reply unchanged and gets no mark. Marks live under
`codenomad-missions/human-marks-v1`, never the retired `authority-v2` namespace.

The UI principal is explicit in the private bridge proof: a local login cookie
session (auth enabled), or a paired Remote Control device chosen by ingress
socket membership. A device qualifies only while Remote Control is connected
and the device is still paired, unrevoked and unexpired; the route and the
bridge callback revalidate that principal across native I/O. A device ID never
poses as a cookie session. When the mark cannot be prepared before forwarding
(no authenticated principal, plugin/binding unavailable, revocation or a
session move), the answer falls back to the ordinary reply without a mark; the
user is never blocked from answering. The human-answer header alone (automation,
Yolo, SDK) never mints a mark. Only a
dispatched mark reply with a lost outcome is reported as uncertain.

There are no signatures or reserved/replied/settled answer receipts.
OpenCode does not record answerer identity natively. Keep the ordinary answer
path's ownership and uncertainty checks; missing evidence leaves the gate unmet,
never causes automatic answer replay. This replaces signed answer provenance in
both one-time and recurring Wayfinder, not unrelated one-time lifecycle receipts.

## Per-schedule snapshot

Expose `id`, `title`, `clock`, display `nextDueAt`, revision and available actions.
Expose state including Interrupted and `interruptionReason` when applicable.
Expose pending status `starting | running | settling | uncertain`, exact identity,
latestResult and history. `starting` means a live Job/observer is handling a not
yet admitted start; `uncertain` (with reason `not-observed` or `admission-failing`)
only when no observer is live or that admission keeps failing. History and pending
items carry their `daily | manual` trigger; a non-blocking `lastError` is exposed
while relevant. Do not expose epochs/grants/receipts/budgets.
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

Coverage boundary: the offline `recurring-day.e2e.test.ts` fixture drives the real
plugin, scheduler, storage and `mission_*` tools, but its scripted model only
records `read`/`shell` call names; it executes no real shell or backend tool.
Real shell/backend execution under native permissions is covered only by the
isolated native qualification fixture (`MISSIONS_RECURRING_SIMPLE_QUALIFICATION.md`,
journeys A–G, W, Q and N; acceptance remains partial), not by the offline e2e.
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
