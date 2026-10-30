# Recurring Missions

The Wayfinder UI-answer mark below applies to both one-time and recurring Missions.
Acceptance status: `MISSIONS_RECURRING_QUALIFICATION.md`.

## Unified native schedules

Unified documents use `launch-policy.ts` for immediate, absolute/relative one-shot,
elapsed Every, cron and up to eight cron calendars. A source condition uses its
qualified reader. Native schedule rows own future dates and civil-time behavior;
Missions owns admission, non-overlap, frozen inputs, launch counts and settlement.

The authenticated product seam is `POST /api/workspaces/:id/missions/scheduled`
for paused creation, and `GET|POST /api/workspaces/:id/missions/:missionID/schedule`
for status and explicit controls. Requests pin the native directory, human principal,
profile source, request ID and document revision through the existing signed bridge.
`scheduleRead({missionID,requestID})` reads an exact retained control receipt;
missing or evicted proof stays unknown. Passive reads send no controls.

`GET /api/workspaces/:id/missions/scheduled/requests/:requestID` reads an exact
creation receipt when the HTTP response containing the document ID was lost.
It uses the retained physical permit, or derives the document ID from the acquired
native project owner after permit settlement/restart. A negative or incomplete
receipt retains uncertainty; the read performs exact observation only.

`GET /api/workspaces/:id/missions/scheduled` brokers the read-only `scheduleList`
RPC. It reads at most eight key-ordered unified documents per page, selected by an
optional `after` Mission ID and `limit`. Tombstones consume page capacity and the
cursor advances across them. Each page validates project identity and document
bounds; malformed entries fail the page. Immediate unified documents carry
`kind: one-time`, calendar-owned documents `kind: schedule`, allowing the panel
to merge journal rows by Mission ID and retain their owning control path.
List and detail projections include the full launch policy/configuration, frozen
one-shot/end instants, admitted/settled/successful counts, structural/template locks,
pending passage identity and the thirty retained passage receipts.

List and detail also expose `observation`, `availableActions` and `blockReason`.
The native display adapter reads at most eight exact principal rows, validates
their adopted mapping and checks the document revision again after I/O. Missing,
foreign, partial or retired reads project `unknown`. `nextDueAt` is the earliest
active native principal's saved date; a condition labels it as a check. Paused
rows contribute their counter but have no active next wake. `nativeStatus`
separately exposes active/paused/done/mixed principals beside the document's
desired state. `wakeCount` sums
native principal prompt admissions in the current `timeGeneration`; auxiliary
wakes, source-verification counts and lifetime business launch/success totals
have separate meanings. Available actions are durable-state candidates; the
authenticated mutation rechecks capabilities, source/actor proofs and CAS.
Prepared wakes lock structural editing through the same H9 projection used by
the document mutator.

During an admitted passage, a text-only configure validates H9 and persists its
original request, document/journal revisions, passage identity and payload in the
calendar operation before publishing `mission.updated` in its isolated journal.
An exact retained event confirms the future objective/notes under document exclusion,
including after passage archive. Reconciliation only reads that event; explicit replay
uses the saved original revision and payload. Missing proof retains the operation and
the editor's original uncertain request. Frozen passage inputs, task contracts, profiles and
session/message identities remain intact. Never send a prompt from this edit path.
Create and Edit share empty-calendar validation; saved unknown interval phases and
intentionally exhausted launch quotas retain their explicit display. Preview end
bounds apply to both the persisted next slot and subsequent slots, including late slots.

`checks: {count,since} | null` counts completed, revalidated source observations
committed with a principal fan-in's consumed high-water or passage reservation,
and explicit Run now reservations. A group of up to eight principal wakes counts
once. True and false conditions both count; baseline reads at Play, auxiliary
wakes, replays, overlaps, suppressed wakes, failed/incomplete source reads and
unconditional policies contribute zero. Admission or settlement retries preserve
the count. Configuration changes and temporal generations retain it. New documents
track from creation; documents without tracking begin at their first committed
check. The UI displays `since` alongside the count and treats `null` as unavailable
history, preserving the unknown earlier total.

`node scripts/test-native-mission-schedule-list.mjs <absolute-isolated-cli>`
qualifies the production read handlers and public native `storage.scan` against
fixture-owned documents: bounded pagination across a tombstone, cursor semantics,
list/detail parity and unchanged revisions. One document has real adopted native
calendars; its exact next date/counter is read through the invocation-scoped
adapter, with zero model requests.

`GET /api/workspaces/:id/missions/scheduled/capabilities` reads the acquired
connection's consumed API contract, effective schedules flag and origin. Its
read-only activation plan exposes the target scopes/paths or a refusal category.
The native document preparation endpoint owns authenticated configuration writes.
Both display routes revalidate workspace, connection, physical checkout and request
lifetime after asynchronous work. Missing methods or capabilities return an
explicit unavailable response. UI reads use the shared secondary HTTP budget.

Five explicit source conditions share the native source preparation boundary:
another schedule's successful passage, a completed one-time Mission, commits on
a local branch, stable new messages in a followed conversation, and an explicit
file set. Event-only policies check every 15 minutes; calendar-backed conditions
are read only at those calendar slots. First Play establishes their baseline,
Pause/Resume preserves it, and configuration retains removed source checkpoints.
A pending freezes the observed proof; only successful settlement consumes it.
Success counters outlive the 30-result window, and missing retained success proof,
cyclic dependencies, moved/deleted sources or incomplete reads block admission.
Missing native correlation is an explicit unknown block; positively active source
families retain their prior checkpoint while waiting. Historical journal-only
sources use their validated coordinator placement under an explicitly authorized
root. Followed conversations exclude the Mission's own passage families through
their bounded native parent chains.
Local file and Git reads yield the service event loop and share a cancellable
ten-second budget with their final pre-publication revalidation. Exact native
input/terminal bytes remain fenced synchronously inside the document CAS.
Bounds, transaction fences and qualification are in the native contracts' event
source readers section.

The native calendar owner records create intents and reverse carrier ownership
before native effects. It acknowledges the reconciliation calendar before arming
principals. Temporal edits preserve retired proofs until cleanup, while relative
origins, the first Play and admitted counts remain durable. A first Play on a
calendar-backed policy requires ready settings activation. Creation remains paused.

Human Play also calls the shared service-supervision default-ON path on its exact
acquired connection. An explicit OFF remains OFF; creating, configuring, pausing,
stopping and deleting a Mission preserve that service-wide preference. Supervision
preparation precedes the signed control proof and native schedule dispatch. Runtime
namespace/storage failures remain explicit at the product boundary; independent
OS protection and native calendar admission keep separate status contracts.

Each technical wake enters an exact-file, own-process HTTP RPC with an eight-second
deadline. A read-only preflight freezes complete fan-in coverage before a dispatch
claim. Technical high-water advances at durable reservation; the pending business
reference remains separate, so auxiliary observation can reconcile the last passage.
Native persisted schedules load their owning Location on wake after service startup.
Pause/Stop, failures, unqualified observations and uncertain effects retain their
admission barriers. Never resend an attempted original whose proof is missing.

Context hooks and tool execution use the fixed-method internal business bridge;
its receiving RPC acquires fresh Session/Database/Location services. Each business
mutation takes the document exclusion before the existing journal writer. Native
permissions, original message identities and whole-family H11 settlement apply.
Technical carriers use the reserved `ses_cn_schedule_` namespace, local provider,
local title/compaction hooks and authoritative ordinary-input guards.

Implementation contracts and isolated qualification commands:
[native contracts](MISSIONS_NATIVE_CONTRACTS.md) and
[schedule transport](MISSIONS_NATIVE_SCHEDULE_TRANSPORT.md).

## Daily document product boundary

Daily documents use `NativeMissionRecurrenceStore` and the daily controls below.
Journal-only missions keep their existing execution path. Storage representation
selects the owning adapter; reads and reconnects preserve it.

Creation stores a paused schedule, never starts work or arms a timer, and is never
resent; Play requests carry the then-current revision so CAS refuses a duplicate.
New titles follow the 1–60 Mission title rule; stored schedules keep their
120-character bound.
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

Ceilings (`missions/recurrence-contract.ts`): 64 schedules per project, a 64 KiB
configuration, a 256 KiB document and 64 remembered conversations
(watched plus cursor-retaining); beyond that ceiling the document is refused, so never
reset deduplication silently. Never add signing keys, authority epochs, grants,
standing/child authority, per-effect receipts, per-tool budgets or ledgers, per-tool effect
accounting or exact event-log replay to schedules, settlement or snapshots; the
unified document owns the user-visible admitted-passage limit and count. Human
answers use the UI-answer marks below.

Native kv offers no compare-and-swap, so the plugin serializes document updates and
compares the supplied expected revision before committing the new revision; never
follow a read with an unguarded write. Controls, due admission and settlement use
the same guarded document mutation path; concurrent attempts cannot replace each
other's pending identity or lose an archive.

## User controls

Create paused, Play, Pause, Stop, Resume, Run now and Check passage are admitted only through:

1. The authenticated CodeNomad UI/backend route.
2. The HMAC-authenticated bridge.
3. The plugin's schedule-control RPC.

The route's human principal, with local auth enabled, is a live login cookie
session or, from the Remote Control ingress (socket membership), a paired device
that is still authorized; the bridge callback revalidates the same principal and
never treats a device as a cookie. Any other principal is refused before a
deletion permit or control hold exists, so a refusal is definitive, never uncertain.

Never expose these controls as model tools. Validate project/Location ownership,
connection identity, inputs and frozen execution profiles at the existing boundary.
Each control has `requestID` idempotency and `expectedRevision` CAS.
A duplicate request must not start a second Job, passage or coordinator message.
A stale revision is a conflict; never overwrite current state with it.
Native stays the authoritative CAS: the exact status read reports `rejected`
(`revision-conflict` or `control-conflict`) only when storage proves a request with
no record never applied and never can — a later revision whose record provably was
never evicted (the document bounds evicted revisions), or a pure pre-write refusal
at its own revision. The route then releases the permit and answers 409
`recurrence-revision-conflict` / `recurrence-control-conflict`. A control or Run
now that fails before the route dispatches it (connection unavailable, Location
ownership or deletion admission, another request's held permit) answers
`recurrence-not-dispatched` (409 when another permit or a deletion blocks the
hold or the permit table is full;
otherwise 503). The code proves only that this attempt sent nothing: it means
"no effect" solely for an identity the client never sent before. A refused
repeat of an identity the backend still holds stays uncoded, but a backend that
no longer holds it (for example after a restart, failing before any native read)
cannot know an earlier send, so clients that repeat an identity must keep it
uncertain and read its exact status. `/control`
refuses `run-now` with 400 before any permit; Run now has its own endpoint. The
UI releases these coded refusals and the route's pre-permit 400/401 for a
request's first attempt only, refreshes the row and explains the refusal; a
refused exact partial retry keeps the original held request and server permit.
After a backend restart, an explicit partial Pause/Stop retry may take a fresh
physical admission. Before dispatch, an authenticated exact native status read
must prove the original action, request ID, expected revision, recorded revision
and partial result in the current owned Location. Missing, foreign, completed or
unknown records cannot authorize it. This never transfers an old permit, starts
a Job or changes the request identity; native idempotency still decides effects.
Failed preparation releases this fresh admission, but preserves a surviving
original partial permit.
Within one backend, a partial or uncertain Pause/Stop permit can outlive its
retired OpenCode connection (event-stream end, failed request, new daemon).
An explicit exact retry through the current connection may then prepare a fresh
admission beside it, never transfer it: the same backend workspace object,
native project ID and canonical path (which OpenCode derives from the Git root),
directory, checkout, physical root and Settings profile must be re-proven, plus
the same exact native partial record (random request ID, revision and state).
Limit: these gates cannot distinguish a byte-identical copy of the native database
served by another daemon at the same project/path; a retry's effects would land in
that copy while the backend retires its permit. The old permit is retired
only at dispatch, after the fresh one is entered. An in-flight, still-preparing
or already-replacing original, a live original connection, or any mismatch
refuses without effects; a deletion already waiting on the old permit blocks the
fresh entry. Status reads through the current connection may still settle that
permit (committed and complete, with the owner re-proven) while such a deletion
waits, and never resend.
A dispatched control or Run now that native refused before writing any record
(transport-proof callback timeout, transient Git/family read, profile check,
Resume not interrupted, service death) first reads unknown, as does a timeout.
Every record-creating CAS (`beginControl`, `reserveManual`) rechecks the signed
proof's 30 s freshness synchronously inside its write
transaction. Once the backend's clock considers the exact proof it still holds
expired, its status reads (and the route's immediate read after a lost reply)
send that backend-signed `issuedAt` — never a browser value. Native, serialized
with those CASes, answers `rejected` (`control-conflict`) only when its own clock
also finds it expired by a further 5 s grace (so a CAS racing the boundary in
another process sharing the storage has committed) and the request has no record that could ever have been
evicted; it then retires the request ID in that native host, so an in-flight
original (or any later attempt of that ID) fails at the CAS even if the wall
clock moves back, and keeps answering `rejected` for it. The route releases the
permit holding exactly that `issuedAt`, Location and request (with the owner
re-proven through a replaced connection), unblocking controls and deletion. An
unexpired proof or a mismatch stays unknown, and an unheld identity (for example
after a backend restart, with no hint) cannot trigger retirement: it stays
unknown unless native has already retired it. Retirement is process-local and bounded
(4096 IDs); another daemon sharing the same storage relies on the expired proof
alone, and clients must not reuse a rejected request ID.
Everything else (including an unprovable profile change) stays unknown.

If a reply is lost, retain that request identity and reread its status.
Refresh, reconnect, remount and status reads never automatically resend it.
An uncertain control must not be replaced with a fresh request to evade the hold.
Resume is only ever an explicit user action. Stopped schedules cannot be played, resumed or run now.

A schedule document keeps at most 64 control records. Admitting a new control
evicts the oldest completed record; unresolved records are never evicted, and an
evicted request's exact status reads unknown, which never authorizes a resend.
Pause/Stop freeze every actor of the pending passage as targets, however many it
has (`missions/recurrence-store.ts` `recordControl`); a record keeps its targets only
until it completes, when every one was acknowledged, so only the single unresolved
Pause/Stop a schedule admits lists them and the document stays within its 256 KiB.
`evictedControlRevision` bounds every evicted record's revision; a document without
it starts from its current revision as the bound.
A Play/Resume/Check whose Job or observer start stayed unknown is resolved by a
later completed control that restarted or cancelled it. While such an intent, or
a reserved but unadmitted Run now, stays unknown, the snapshot offers only
Resume/Pause/Stop/Check and the UI enables exactly those that native offers once
its snapshot records the intent; the original is never resent. The backend admits
that new request with its own permit only after a fresh exact native read through
the current connection shows the original recorded and incomplete under the same
owner; a committed superseding control retires the original permit, a no-effect
refusal restores it. If another client's exact read proves a retained middle
intent had no effect while a newer control still supersedes it, only that
intent's permit is released and the newer control inherits its predecessor, so
a later no-effect restores (and a commit retires) the earlier intent instead of
orphaning its permit. Run now itself completes only on admission or archive.
In-flight, preparing and partial Pause/Stop permits are never superseded. A Play/Resume whose native
Job start fails while a fresh read positively shows no running daily Job completes
its record with the schedule Interrupted (reason `error`), releasing the backend
permit for an explicit Resume/Pause/Stop; a failed or running read stays unknown.
Interrupted(error) and the completed record are one CAS revision, so no crash can
separate them; a crash before that write is an ordinary unknown start. A status
read also resolves an incomplete current start intent already marked
Interrupted(error) (for example by the daily Job's own fatal exit) when a fresh
definite read shows no running daily Job. A Job writes that reason inside its own
run, before native reports it not running, and Resume admits only after such a
read, so a stale reason cannot land after Resume cleared it.
Nothing retries the start. A Run now is resolved by
its own passage's admission or archive; archiving also resolves Checks of that
passage. Pause/Stop on a reserved passage without a journal mission has no actor
to interrupt (dispatch of an unadmitted passage is refused once paused/stopped).

## Threat model

HMAC authenticates the desktop bridge. An unrestricted shell can read the service
password and kv database and act with the service's privileges; native shell
permissions and OS isolation are the security boundary, so never describe marks as
tamper-proof. Ownership, authentication, permission and data-loss protections apply
to every passage, and unknown effects stay unknown.

## Native guarantees and missing primitives

The implementation relies on existing native contracts, qualified at their callers:

- Session creation with a caller-supplied session ID is idempotent.
- Prompt admission with a caller-supplied message ID is first-admission-wins.
- Plugin tools receive native session, message and call identity.
- Jobs are process-local and disappear when the service restarts.
- A turn holds a durable execution claim (`session_v2.time_suspended`) until its
  terminal event; a hard kill preserves that claim. Managed native recovery can
  resume it asynchronously after a restart.

Resume observes the original coordinator input and native continuation. Every
remaining claim blocks settlement, including an old claim absent from
`Session.active`. Require the original input and a later durable idle in native
`session_message.seq` order, then recheck the whole family, claims, inboxes,
requests and outstanding background deliveries. Missing/pruned input, an
uncorrelated terminal or a changed second observation keeps the same pending
uncertain. Never infer a terminal from age, inactivity or a timeout; never send a
second original prompt after admission has been recorded.

Plugin-side mechanisms cover three native gaps:

- Compare-and-swap: the revision guard above.
- Family settlement: observation of the whole passage family and queues.
- Form answerer identity: the backend UI-answer mark below.

## Scheduler and civil time

Keep **one native Job per running schedule** in the live OpenCode process.
It sleeps until `min(nextDueAt, now + 1h)`, then rereads the wall clock and document.
This hourly ceiling bounds clock-change detection; never poll per minute.
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
`nextDueAt` is a display projection only; never schedule from it.

Pause and Stop cancel the schedule Job and interrupt the pending passage's registered root coordinator; Stop is terminal.
Retain pending passage identity and observations rather than clearing live work.

Desired running without a live native Job is displayed as **Interrupted** with
an interruption reason. Service restart therefore leaves scheduling Interrupted.
Do not rearm from plugin load, a read, UI reopen or backend reconnect.
Only explicit Resume may restore scheduling; pending work is reconciled first.
An Interrupted schedule keeps its passage pending. Resume reconciles its original
identities and observes native continuation until terminal correlation and full
family quiescence are available.

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
uncertain and blocks a further passage. Never let an expiry turn unknown into a replay.

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
  native absence of the start message (pruned history) keeps terminal correlation
  uncertain and the original message is never sent again.
Run now cannot overlap an unresolved pending passage or bypass terminal Stop.
A manual run never counts as another scheduled civil day's completion.

Run now without a live schedule Job (paused, or Interrupted after a restart)
starts a separate **settlement-only observer Job** using the same sleep/wake seam,
including the native execution-event wake and the pending fallback backoff. It is
reconcile-only (never a second coordinator message; at most the original start
identity while dispatch is allowed), never starts daily passages and exits once
the passage settles. Pause cancels it. Stop keeps (restarts) it for a pending
passage so the passage still archives honestly; the schedule stays terminal. A
live running schedule's own Job observes its manual passage instead. The observer
starts only on a definite native read that no daily Job runs, or on an unknown read
of a schedule not desired running; an unknown read of a desired-running schedule
starts nothing (if its Job is in fact gone it shows Interrupted and Resume
reconciles the passage), so no second observer runs beside the daily Job. After a
service restart with a pending passage on a paused or stopped schedule, the
snapshot offers an explicit **Check passage** (`check`) control, admitted like the
others (requestID, expectedRevision, authenticated route), which only restarts
that observer and keeps the schedule paused or stopped.

A failed wake keeps the Job running: it records a display-only `lastError
{ code, at }` in a sibling kv key (outside the document revision) and retries with
a capped backoff (30 s, 2 min, 5 min, 15 min, 1 h). A wake whose fresh passage
reservation is followed by a thrown admission (outcome unknown) is a failed wake:
it publishes `admission-failed` at once and the retry reconciles the same pending
identities. Its start may already be delivered (a lost native ACK), so a missing
receipt never proves native absence and the UI says the start is unconfirmed, never
that it has not started. The next successful wake clears the warning. Each warning
that appears, changes or clears emits the schedule invalidation at the current
revision. Only definitively fatal
causes (Location or Job binding gone) end the Job as Interrupted with reason `error`; a missing or stopped schedule simply exits.

## Passage tools and journals

Register `mission_*` tools independently of CodeNomad backend presence.
Use native session identity to route a passage and its actors to its isolated
journal; otherwise route to the one-time journal. Do not accept arbitrary journal
selectors from the model. Native message/call identity serves ordinary tool
admission and journal ownership.

Native permissions govern every other tool: read, shell, ordinary subagents and
business tools run under those permissions alone. Preserve frozen profiles and taskMode.
Both native descendants and passage-owned independent actors must be accounted
for without inventing ancestry from task dependencies.

The current-passage reader (`opencode/missions/native-recurrence-current.ts`, behind
`recurrenceCurrent` and `recurrenceCurrentContent`) is read-only and takes one
`missionView(passage.missionID)` observation of the passage's isolated journal: the
map, the range's damage flags and the creation event that must carry the passage ID
come from the same events, followed by the schedule re-read that refuses a changed
passage. Its scans count the entries' canonical bytes against 32 MiB, so one read of
a journal up to that size serves the full map; a larger passage journal answers
`Current passage journal capacity`.

## Settlement, result and watched cursors

Settlement requires the coordinator and **all descendants** to be inactive,
their inboxes empty, no applicable pending Form/permission, and no running Shell
or background subagent. Passage-owned independent actors also cannot remain live.
All of these conditions must hold together, whatever the activity or final report.
Use bounded native observations, recheck identities and retain pending on unknown,
incomplete or over-bound coverage.
The family walk shares the 4096-session whole-family control ceiling
(`MAX_CONTROL_FAMILY_SESSIONS`) with one-time lifecycle control, so ordinary
recursive delegation settles; a larger family stays pending as unknown coverage
(no archive, no cursor advance); it is never assumed complete.

Supported outcomes are:

- `completed`: the settled passage has a final `mission_report(outcome: "completed")`.
  It stands even if a native failure occurs later during wrap-up.
- `failed`: either a final business `mission_report(outcome: "failed")`, or a native
  terminal failure in the family without a completed final report. Never guessed
  from prose or an idle flag.
- `ended-without-report`: settled native work ended without a final report and
  without native terminal failure; reason `interrupted` requires a correlated
  native idle whose outcome is interrupted.

The terminal reader uses native `session_message.seq`, anchored to the original
coordinator input or exact fresh managed-root assignment. Historical failures
before that input are excluded. Reused external roots retain uncertainty while
their entry/family provenance is unqualified. The bounded `job.background/` KV
projection (kind and session IDs only, ≤1024 records) blocks settlement while a
completed child still owes its native parent notification.

Atomically archive the result, clear pending and update the scheduled `lastDaily`
in the guarded schedule document. Keep history at ≤30; do not let a crash between
separate document writes permit a second passage for the same settled day.
Advance watched processed-message cursors **only on completed**.
Failed and ended-without-report leave those cursors unchanged.
Keep watch cursor continuity when a watch is removed.

Watched sources (`opencode/missions/native-service-adapter.ts`, `missions/recurrence-input.ts`):

- Read only the configured conversation IDs, in order, through exact native
  `get`/`message`/`messages` calls, each source placed in the project at its exact
  directory/workspace under a configured root; never list sessions, discover
  ancestry or fall back to full history.
- Read at most 32 messages per source, ascending after the exact cursor, as a stable
  complete-message prefix: a streaming assistant or tool, running Shell or compaction
  ends it, every message is point-read again and changed bytes defer it and every
  later ID, and a location switch fails the read. After the query the anchor's full
  native bytes and the source placement are rechecked; a deleted, rewritten or moved
  anchor is never read as no change.
- Project only user/synthetic text and assistant text parts with the message ID,
  type, native digest and completion time; never tools, reasoning, images, skills,
  provider state or credentials.
- Keep messages whole. The whole start text fits the 16,384-character lifecycle
  input; each source gets the room left after the instructions, the worst-case
  envelope (descriptors ≤ 48 KiB), earlier sources' messages and a 1 KiB reserve per
  remaining watch (`recurrence-read-budget.ts`). A message that does not fit ends the
  batch as an unconsumed `needsDecision: "source-input-capacity"` reference with
  empty text.
- Cursors keep each source's placement digest: re-adding a moved source fails closed
  instead of resetting its high-water mark.

## Wayfinder human decision mark — both execution modes

When the user answers a native Form through CodeNomad's InterruptionDock, the
backend records `{ formID, sessionID, answeredAt, via: "ui" }` in two phases:
a `pending` mark with a fresh `attemptID` before forwarding, promoted to
`confirmed` only after the native reply returns positively for that attempt.
A definitely failed forward (Form still observed pending) removes the mark; a
lost/uncertain reply leaves it pending forever. Pending never qualifies, so a
later non-UI answer cannot borrow an earlier failed UI attempt; the coordinator may ask again.
A Wayfinder decision readout that claims the human's answer passes only with a native
Form carrying the matching confirmed UI mark; the coordinator's own decision
(`decidedBy: "coordinator"`) needs no mark and is never shown or counted as the
human's (`MISSIONS.md`, §Human questions and decisions). A refusal reaches the model
as "Human decision required: the user must answer this question from the CodeNomad
interface", with the gate's cause as a detail.
The gate also proves the asking conversation natively. The coordinator asks from its
own root conversation (`coordinator-form-answer`): the Form's session must be that
mission's coordinator and a root, the cited field's own question must end with the
cited decision task's `questionTag` with no other tag in its question or header, the
answer must postdate the task's declaration, and one Form field settles at most one
live decision task. A decision conversation's own question (`native-form-answer`, missions whose
decision workers asked themselves) needs a fresh child of the expected parent's exact
`subagent` call whose prompt carries the declared assignment. Answers
and execution failures are read from durable message projections (completed question
part, `idle` outcome). Native question and delegation evidence counts only from
local tool parts and events: `isLocalNativeTool` (`missions/native-call-observation.ts`)
accepts `executed === false`; `true` (provider-hosted) or a missing flag never qualifies.
Do not infer identity from answer text, tool completion or the agent's assertion.

Only Forms whose session belongs to a Mission family take the mark path: a root
with `codenomad.mission` metadata, or a metadata-less root (an attached
existing coordinator) that the plugin finds as the coordinator actor of a
Mission in the project's durable one-time journal, after walking the bounded
native parent chain to exactly that root. Every other Form uses the ordinary
native reply unchanged and gets no mark. Marks live under
`codenomad-missions/human-marks-v1`.

The UI principal is explicit in the private bridge proof: a local login cookie
session (auth enabled), or a paired Remote Control device chosen by ingress
socket membership. A device qualifies only while Remote Control is connected
and the device is still paired, unrevoked and unexpired; the route and the
bridge callback revalidate that principal across native I/O. A device ID never
poses as a cookie session. When the mark cannot be prepared before forwarding
(no authenticated principal, plugin/binding unavailable, revocation or a
session move), the answer falls back to the ordinary reply without a mark; the
user is never blocked from answering. The human-answer header alone (automation,
Yolo, SDK) never mints a mark. The dock sends `x-codenomad-human-answer` only for a
real pointer click or submit keydown on that exact question, never for
`element.click()`, `requestSubmit()`, synthetic events, developer automation,
Auto/Yolo or SDK calls (`tests/browser/interruption-dock.test.ts`,
`automation-input.test.ts`). The input captures a one-use token bound to the exact
request, schema and answer (`lib/form-answer-interaction.ts`); it expires with that
input task and is consumed at the SDK send in `stores/instances.ts`. Only a dispatched mark reply with a lost outcome is
reported as uncertain.

Missing evidence leaves the gate unmet and never replays an answer; the ordinary
answer path keeps its ownership and uncertainty checks.

## Per-schedule snapshot

Expose `id`, `title`, `clock`, display `nextDueAt`, revision and available actions.
Expose state including Interrupted and `interruptionReason` when applicable.
Expose pending status `starting | running | settling | uncertain`, exact identity,
latestResult and history. `starting` means a live Job/observer is handling a not
yet admitted start; `uncertain` (with reason `not-observed` or `admission-failing`)
when no observer is live, admission is unconfirmed, or terminal correlation stays
unknown. Native activity remains a separate observation. History and pending
items carry their `daily | manual` trigger; a non-blocking `lastError` is exposed
while relevant.
Actions reflect terminality, unresolved controls and pending passage state.
Read-only projections and invalidations never start work or settle unknown sends.

## Acceptance journeys

1. **Daily useful work:** create paused → explicit Play → close UI/backend → due
   passage uses ordinary read/shell and Mission tools → final report → whole family
   settled → atomic archive → next day's passage. Verify no overlapping passage,
   one Job and one coordinator message, frozen profiles and completed-only cursors,
   in both task modes.
2. **Restart with pending:** restart the service during a pending passage → reopen
   shows Interrupted → explicit Resume reconciles existing session/message/inbox →
   observe native recovery with no second coordinator message → archive only after
   correlated terminal and whole-family quiescence. An old claim or missing
   correlation stays pending and uncertain through repeated wakes; only Resume
   rearms the daily Job.
3. **Run now:** explicit authenticated Run now uses the shared write-ahead path;
   duplicate request/status reads produce no second passage. An unresolved pending
   passage blocks overlap. A lost reply is reread, never automatically resent.
4. **Pause/Stop:** cancel the Job, verify no later due admission; pending work is
   still observed honestly. Pause can be explicitly resumed; Stop cannot. Exercise
   CAS conflicts and cancellation uncertainty without claiming recursive suspension.
5. **Human gate:** native UI Form answer has the matching mark in both modes;
   an agent/native answer without it leaves Wayfinder's human gate unmet, and a
   coordinator decision is recorded as the coordinator's.

Acceptance requires these integrated journeys; isolated helper tests never count.

Coverage: the offline `recurring-day.e2e.test.ts` fixture drives the real plugin,
scheduler, storage and `mission_*` tools with a scripted model that only records
`read`/`shell` call names. Real shell/backend execution under native permissions is
covered by the isolated native qualification fixture
(`MISSIONS_RECURRING_QUALIFICATION.md`, journeys A–G, L, W, Q and N).
Native tests must use isolated service/database/provider fixtures, never the shared
daemon or user Mission.

## Agent conventions

### Unified document foundation

`missions/launch-policy.ts` and `mission-document{,-state,-store}.ts` provide a
strict internal configuration codec and conditional document store. Their
`codenomad-missions/documents-v1` namespace owns paused creation, immediate/at/in/
every/cron/multi launch policies, one optional source condition, combined end
bounds, and a global admitted-passage count. Relative origins are frozen at first
Play; the absolute slot end applies to recorded due times, including late arrivals.
Each passage references its execution journal by immutable mission ID. The existing
journal ranges, deletion reserve and activation index own execution history.

Configuration generations advance separately from temporal generations. Per-calendar
high-water, exact pending/preparing wake references, the monotone task-created mark,
and first-Play/budget counters survive the 30-receipt window. Checkpoint payloads are
bounded JSON snapshots; successful settlement consumes the pending snapshot.
Deletion retains the full stopped document through reconciliation, then reserves a
per-project tombstone entry before compacting it; the registry holds at most 4096
entries and 1 MiB and refuses further compaction at capacity.

The store requires transactional revision compare-and-set and a synchronous fresh
ownership guard. `opencode/missions/native-mission-document-storage.ts` acquires
the private Database in the current RPC graph and performs revision/byte-checked
publication inside an immediate transaction. One-time product creation and first
Play use this adapter through `mission-document-one-time.ts`; their immutable
creation receipt reserves the coordinator identity before native creation, and the
first Play retains its original lifecycle request/message and admission count.
Panel reads project bounded document metadata through the existing map RPCs.

`documentCapabilities` qualifies new unified document creation. Journal-only
one-time maps keep their existing execution controls, declarations, continuations
and final reports through the journal path, with their stored representation
preserved. Daily entries remain visible with the controls of their daily contract.
The authenticated daily controls documented above use `NativeMissionRecurrenceStore`.

The storage-only `documentActivation` RPC retains at most two exact configuration
targets, a namespace authority digest, original request/revision, attempted barriers
and acknowledged result digests. `missionScheduleActivationJournal` in the server
routes adapts those phases to the settings executor. Ready follows that executor's
positive effective read and keeps the Mission paused. Immediate Play leaves this
field null. Keep credentials and raw configuration out of the document.

Scheduled admission, source baselines/changes, native adoption/cleanup, complete
fan-in coverage, terminal-turn correlation and family quiescence belong to their
own qualified adapters. Keep unknown data intact and qualification fixtures isolated.

- Missions autonomy target is explicitly native: the OpenCode service/plugin runs scheduled passages with both CodeNomad UI and intermediary backend closed; neither a persistent CodeNomad backend nor a window timer is a substitute. One process-local native Job per running daily schedule sleeps until min(nextDueAt, now + 1h), then rereads clock/document and admits only the latest due civil day newer than lastDaily. A native session-execution terminal event (Bus `listen`, 3 s debounce) also wakes the Job so archives follow family quiescence promptly; the event is a wake hint, never settlement evidence. Pause/Stop cancel the daily Job; desired running without it is Interrupted until explicit Resume. Resume observes native continuation under the original identities. Every remaining claim and missing terminal correlation keeps the pending uncertain; a correlated idle and full family/background-delivery quiescence are required for archive. Never infer interruption from claim age or inactivity, and never resend an admitted original prompt.
- Core: `missions/recurrence-{contract,clock,store,runner}.ts` (native side `opencode/missions/native-recurrence-*.ts`); omitting a profile variant is valid. Every rule in the sections above binds.
- Root and schedule admission read the family identity with `readFamilyAuthorityIdentity` (`workspaces/family-authority-claim.ts`) only for a directory WorkspaceManager already authorized: registered linked worktrees share their Git common directory's identity, and a Git-free conversation has none, so it can never infer a family.
