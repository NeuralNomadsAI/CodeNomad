# Recurring Missions

The Wayfinder UI-answer mark below applies to both one-time and recurring Missions.
Qualification commands: `MISSIONS_RECURRING_QUALIFICATION.md`.

## Unified native schedules

Unified documents store a launch policy (`missions/launch-policy.ts`): one ordered
list `{ when }` of criteria, each a schedule (`{ kind: "now" }` once at Play, or
one cron with its IANA zone) or one of the events below. A sole `now` criterion
and an empty list use one-time journal admission at Play, with native-default profiles
available. Mixed lists use native calendars and their frozen explicit profiles. OpenCode
Automation rows own future dates and civil-time behavior; Missions owns admission,
non-overlap, frozen inputs, launch counts and settlement.

### Launch criteria

`missionCriteriaStructure` (`missions/mission-launch-kind.ts`) is the one parser the
codec, the engine, the editor and the list summary share. It reads the list as
alternating groups of consecutive schedules or events. Between two adjacent cards the
connector depends only on their kinds: same kind **or**, schedule → event **if**,
event → schedule **else**. Groups, not neighbours, carry the meaning:

- Events at the head trigger on each new occurrence (OR). A schedule group at the head
  triggers at its slots.
- Events after a schedule group are the conditions (OR) of every schedule of that
  group: at each of its slots the Mission launches only if one of them changed since
  the last successful passage. Such events never trigger.
- A schedule group after events is an **else** fallback of everything above it: at a
  slot it launches only if the criteria above its group launched no passage for a slot
  in that schedule's own period, from its previous slot (or, before any slot, from when
  its calendar was armed) to this slot. Events after a fallback group condition only
  that fallback.

For example, commits, 18:00, new messages, 20:00 launches at each commit; else at
18:00 if there were new messages; else at 20:00 without a condition. Each schedule
owns one principal calendar (slots 0..n-1); trigger events share one internal
principal that checks them every 15 minutes (slot n). Conditions own no calendar and
are read at the slots that need them. `missionLaunches` (`missions/mission-document-state.ts`)
decides every fan-in group; source snapshots report each changed event key
(`news.changed`), so a schedule group reads only its own conditions. A skipped slot
consumes no source: references advance only with a successful passage, so an
unconsumed condition can serve a retry after a failure.

A fallback period (`missionFallbackClear`) counts a passage by its slot once its
coordinator's first input was admitted (`admittedAt`), even if it later failed:
**Run now** passages, and wake or grouped passages launched by the event check, by a
group above, or by a schedule since removed or changed (its place in the list is
unknown, so it may skip a fallback slot but never doubles one). A wake passage counts
only for the calendars whose slot decided it (`launchedBy`, recorded at reservation; `origin.wakes`
keeps every grouped wake) at the latest slot of those deciding wakes; a grouped passage
counts for its `scheduleIDs` at its `dueAt`, and any other passage at its `dueAt`. Passages of the
fallback's own group or of a later group never count, so a fallback's own passage
never hides its next slot. A reservation without proven admission does not count; such
a pending passage makes the decision uncertain, so the fallback never launches then,
nor when its period's origin is not before the slot.
Each principal calendar records `armedAt` (the anchor the calendar owner armed it
with) and `lastDueAt` (its latest processed slot). A schedule changed or added by an
edit starts a new period at its new anchor; an unchanged schedule keeps its origin, even
when the edit re-arms its calendar (`calendarForSlot` carries it over with the replaced
calendars' identifiers in `formerIDs`, so their passages keep that schedule's current
group), and a kept calendar that never had a slot takes the activation time of a
launch-criteria edit. Document validation accepts these fields on principal calendars
only, with `armedAt` at or before every known slot of its calendar, `lastDueAt` at or
after its reserved slot and at or before the slot being prepared, and `deferred.scheduleIDs`
naming current principal calendars.

In a mixed list, `now` owns one native `at` principal, with its absolute due instant
frozen at Play plus one millisecond. That native clock tick gives an **else** fallback
a nonempty period from arming to its sole slot. `[event, now]` has a once-now fallback
and keeps checking its leading event for future launches; `[now, event]` evaluates
that event only at the one-shot slot. An unmet condition consumes that slot, so a sole
conditional one-shot can finish with zero launches. Adjacent `now` and cron criteria
share their schedule group's **or** and conditions.

Creation stores a paused document. Explicit **Start automatically**, or the user's
explicit request passed as `prepare.startOnCreation: true`, may continue its fresh
acknowledgement through guarded first Play. Recovery only observes its original result.
Pause/Resume, exact Play replay, restarts and Run now preserve
the frozen one-shot instant and processed slot. A timing edit that keeps `now` retains
that instant and its consumed-slot proof even when native calendars are replaced.
Adding `now` to an armed mixed policy freezes a new one-shot at the edit plus one
millisecond. Run now keeps its own explicit request/passage identity and ordinary
non-overlap and fallback-period rules. Native row completion and consumed high-water
allow ordinary cleanup after the final one-shot; recurring and event principals
continue on their own slots.

The codec requires unique schedules and unique events, at most 16 criteria, eight
events and eight principal calendars. Criteria have no end date.

A passage in progress is never doubled. With launch criteria, principal wakes consumed
while a passage is pending, or after it within its overlap window, record one `deferred` launch
(`{ afterPassageID, dueAt, scheduleIDs }`); slots due by the passage's reservation are
already answered by it. Each wake is decided at its slot with `missionLaunches`, from a
source read measured against the references the running passage will consume: a wake
that would not launch then (no changed trigger or condition, or a fallback period
already covered or uncertain) is not recorded, and a wake whose read is incomplete
stays unconsumed until the passage's window decides it. Settlement then launches
exactly one passage with origin `{ kind: "deferred", afterPassageID, dueAt, scheduleIDs }`,
whose deterministic passage ID admits it once; its source read only freezes the new
passage's inputs. Pause, Resume, Stop, Delete, a launch-criteria edit, an unsuccessful
settlement and a blocked or finished schedule drop it. A transient source read or open
fan-in window keeps it for the next wake. A stored legacy policy never groups: its
overlapping wakes are consumed without a launch or a source read, and document validation
refuses a `deferred` launch, a deferred passage or an overlap window on it. Saved launch
criteria never turn back into a legacy policy: `configure` refuses that edit, and
one-time preparation refuses it before recording its intent.

`missions/mission-launch-kind.ts` (`missionLaunchModel`) reads both stored shapes;
the codec accepts both, the editor writes criteria only, and one-time creation stores
the criteria-free `{ timing: { kind: "immediate" }, condition: null, ends }` shape.
Documents in the `{ timing, condition, ends }` shape keep their bytes, are never
rewritten on read and keep their native calendars without re-arming; they read as:
frequency → a schedule group (`every`, single-date `at` and delayed `in` keep their
exact legacy timing); frequency + condition → that group with the event as the
condition of every calendar; condition alone → one trigger event
launched once; `ends.at` keeps bounding the slots as the model's `until`;
`ends.afterMs` and `ends.maxLaunches` keep bounding the slots and admitted passages.
The editor decodes cron/multi frequencies (single zone) into schedule cards, then the
condition after them. An unchanged reopen saves the stored policy byte-for-byte, so a
stored end date or single launch keeps applying; saving any edit writes criteria,
which drops the end date and the single-launch limit. An equivalent criteria save of
a legacy policy without an end keeps the same temporal policy, so it neither replaces
calendars nor starts a new time generation. Interval, delay, single-date,
passage-limit and relative-end policies and mixed zones are retained read-only until
an explicit replacement.

### Visible timing, limits and editing

Scheduling labels use focusable **i** tips for secondary explanations, available
on hover, keyboard focus and touch. The editor's **Launch when** list adds cards
with **Add a criterion**; once now is selected in the initial card and adding a card
keeps it in place. Each card's native select groups schedule shortcuts (once now, every
N hours with N in 1, 2, 3, 4, 6, 8 or 12, every day, selected weekdays, day of each month,
advanced cron) and the supported events; a new daily card takes the first free hour from
09:00. Shortcuts write a cron; recognized crons decode back to their shortcut
and unedited cards keep their stored spelling. Cards reorder by dragging their grip
(`@thisbeyond/solid-dnd`, as for tabs) or with Alt+Up/Down on the focused grip; a live
region announces the new position and focus stays on the grip. The connector to the
card above sits in a fixed-height line above each card, small and secondary, and
follows the projected order while dragging, so nothing reflows. The form shows no
slot preview and no end date; it refuses a cron calendar without a future slot. The saved
zone defaults to the system zone; its field appears only when the draft's zone
differs (a schedule saved elsewhere, an invalid zone) and then stays for that editor,
so typing never hides it; a reopened schedule keeps its stored zone. **Launch when**
has a single focusable **i** that opens the localized `missions#native-scheduling`
help section. The list summarizes each criterion in order,
prefixed after the first with its connector; the detail shows a stored legacy end
date, and source checks only with events. The info tip beside the **Technical
details** disclosure explains technical activity and costs.

Cron runs at most once per minute. Civil rules use the saved IANA zone and native
DST behavior; months without the selected day are skipped.

Catch-up uses the native row's recorded `dueAt`, including when later slots were
missed. Multiple principal wakes fan in to at most one catch-up passage before
future slots resume. Explicitly paused recurring calendars resume at a future slot;
a paused legacy one-shot may arrive once, late. End bounds apply to the recorded due slot.

The end continues through Pause; an eligible recorded slot may arrive after it.
Launch counts record each passage once on admission of its coordinator's first
input, including Run now and a passage that later fails; checks, technical wakes and
refused admissions count zero, and uncertain admission keeps its reservation until
reconciliation. A legacy passage limit counts the same way. Counts and first-Play
origins survive edits, restarts and the thirty-result history window.

The event sources and their consumption rules are below. H9 editing
follows the [shared editor table](MISSIONS.md#user-journey-regression-checks): full
eligible preparation before admission, future configuration between recurring
passages, objective/notes during admitted work and read-only uncertain state.
Template changes require that no task has ever been created. Reopen preserves the
loaded draft; explicit conflict reload retains a comparison, and receipt reads
keep the original request/revision. Configuration and temporal generations remain
separate; unchanged timing and end groups preserve phase and absolute limits.

### Explicit coordinator conversation

Calendar-backed configuration accepts optional `coordinatorSessionID`. The editor's
**Coordinator session** defaults to a fresh root per passage; **Existing session** selects
an ordinary root in the same project and execution Location using native paged discovery
and owned point reads. Drafts and retained configure/create payloads keep this selection.
A pure immediate policy requires the new-session choice. The selected root is excluded
from its own followed-context/event sources and technical carriers are ineligible.

Each reservation retains its distinct passage, execution Mission and original message
IDs and isolated journal, with `coordinatorReused` identifying the explicit selection.
Adoption applies the frozen agent/model through public native switches and merges only
the Missions metadata key. Existing transcript, title, permissions and unrelated metadata
remain. After admission the coordinator conversation's agent and model stay its user's
choice: Mission tools keep working after a switch, while task roots keep their role profile. The user's choice authorizes ordinary Mission controls over that conversation
and its work, including Stop cancellation of existing queued user/synthetic inputs.
For human-authored choices, never add other-Mission-membership vetoes to the explicitly adopted root.
An agent can explicitly select its own eligible root when saving a schedule.
Selection and adoption check placement, source and ownership only: never add a busy-work veto.
An active, queued or waiting family is adopted as is; the passage prompt queues natively
behind its current turn, and its baseline records that turn as inherited work.
Deterministic coordinator selection refusals before a write return an exact
request-bound refusal; incomplete or ambiguous writes retain their recovery hold.
Preparation, configuration and every authoritative adoption revalidate this boundary before native
profile, metadata, environment or input effects; the current passage's own marker is allowed.
A missing chosen root stays missing; attempted admission retains its original proof rules.

Before adoption, one immutable `coordinatorBaseline` checkpoint captures the bounded
native family and its per-session message high-water, boundary, in-flight input and durable
aggregate sequence under document CAS and native-state fencing. Existing quiet histories
are separated from new descendants and later child inputs. A quiet inherited descendant
keeps its existing Location, such as an earlier worktree; passage-owned sessions and
inherited sessions with new activity must stay in the coordinator's Location. A native prompt hook records
the first actual child-input identity in `codenomad.passage-input` metadata for that passage;
later inputs retain it through pruning and restarts. Inherited running work keeps its actual
captured input and failures after the ownership boundary. Idle ancestors of inherited
active/queued work, and sessions awaiting identified background notices, retain their
existing input too. Missing/pruned new correlation
remains unknown. Whole-family activity,
claims, queues, requests, tools and background deliveries still prevent settlement.
The pending checkpoint is released at archive, which retains the journal revision/family
digest as `settlementProof`. Native source fences cover archive publication. Success-source
reads use that archived proof and isolated completed journal, so later work in the same
conversation leaves earlier results stable. Exact archive/deletion ownership releases
the root to ordinary routing, whether the passage reused it or created it, so a person
can pick it to coordinate another Mission; missing or mismatched owner evidence stays unavailable.
After archive, scoped cleanup clears only that exact old Missions marker. A changed
marker is preserved. `coordinatorReleases` retains unconfirmed exact release identities
independently of the thirty-result window, under the document byte bound. Those records
also prove inactive ownership for ordinary routing. Check retries their cleanup with no
pending passage; positive readback, absence or a replacement marker retires the record
under its native-state fence.
Deletion retains its original pending request until these obligations are confirmed.
Preserved descendants use the same validated inactive-owner classification as their root.

### Restart recovery

OpenCode reloads persisted calendars after service restart. A healthy schedule
desired running wakes its owning Location with CodeNomad UI/backend closed and
without prior project access or human Resume. At rest it returns to calendar work;
with pending work it reconciles the original passage/session/message identities.
The durable auxiliary reconciliation calendar remains until that passage settles.

A Mission whose calendar OpenCode migrated keeps its durable calendar and wake IDs.
The native adapter resolves that calendar to the matching `aut_` row, checks the
exact owned session, project, timing and fixed action, and verifies each pending
wake against its unique durable native message, or a code row's durable preparation.
An absent or conflicting row
does not authorize a new calendar, wake or passage.
OpenCode migrates active or paused timer rows that have a next due time and no
native condition or run count limit. Mission conditions and passage limits are
stored in the Mission document rather than in those native rows.

Explicit Pause, terminal Stop, proven failure and a proven end without a report
retain their admission barriers and human recovery controls. Incomplete native
correlation or uncertain effects keep the original pending record and block a new
passage. Native continuation is observed under its original identity. The technical
wake joins the exact existing service.

The authenticated product seam is `POST /api/workspaces/:id/missions/scheduled`
for paused creation, and `GET|POST /api/workspaces/:id/missions/:missionID/schedule`
for status and explicit controls. Requests pin the native directory, signed human or project-agent principal,
profile source, request ID and document revision through the existing signed bridge.
`scheduleRead({missionID,requestID})` reads an exact retained control receipt;
missing or evicted proof stays unknown. Passive reads send no controls.
Exact completed human or agent Play, Pause, Stop, Resume, Run now, configure and
delete replays read their own retained receipt without a document write or revision
change. Completion includes the actor-family control and original passage admission
proofs. Check always reconciles under its original request identity. Its receipt
read resolves the linked original control, or the latest retained actor control,
and checks actor-family completion; an evicted actor binding stays uncertain while
the passage is pending. Missing, evicted or partial proofs keep their original
reconciliation path and uncertainty.

Serialized calendar validation returns an identity/payload-bound refusal for an
expired first-Play date or a revision conflict before its first write. The initial
dispatch's exact refusal releases its backend and UI holds with a conflict response;
lost replies and applied partial controls retain uncertainty. An explicit Check or
original-request retry of a positively read partial control may use a retired
connection's replacement after revalidating the same owner, physical checkout,
Location, profile and exact partial receipt. It acquires fresh physical admission
before retiring the old permit and preserves the original request ID and revision.

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

Agent project inspection shares the pure panel and passage readers through
`mission.inspect({ project })`, preserving the same bounded pages and native
source identity. Any owned project conversation can inspect human-created documents,
their controls and observations; every read revalidates project ownership.

The panel publishes its loaded inventory and cursor independently of the selected
document's point read. A partial selected receipt keeps uncertainty visible beside
the valid inventory. Scoped retained controls keep their display and original
request/revision for automatic read-only reconciliation while the view is active. Only successfully read
documents enable new controls or representation changes; retained display metadata
and partial error-body receipts keep the original reconciliation active. Selection,
scope, connection and disposal fence late selected reads, including ABA changes.
Exact complete control or activation confirmation retains a minimum publication
revision R with its confirmed outcome in per-window memory across remounts. New
mutations and Edit remain disabled until a fully validated document for that object
and owner publishes at revision >= R. Same-owner revalidation and failed, partial or
older reads retain the barrier and confirmed feedback. During this phase, the active
view's automatic reread of the held request requests only the parent's display refresh. Confirmed deletion releases
matching retention and clears the current selection without waiting for publication
of a deleted document. Chained receipt reads and direct activation continuations retain
their original view and connection fences. A direct positive activation acknowledgement
may continue the same user intention; recovered activation leaves Play explicit.
Never replay a mutation or start Play from receipt recovery or display publication.

List and detail also expose `observation`, `availableActions` and `blockReason`.
The shared list mark uses the current observation's temporal generation and positive
active principal/next-wake evidence for **Waiting for scheduled run**. A missing,
stale, blocked or unresolved observation keeps **State unconfirmed**. Successful-history
attention and exact passage acknowledgement follow the shared marks contract in
`MISSIONS.md` (Agent conventions): accent icon with a static neutral underline for
confirmed waiting, accent alone for prepared, orange Pause or warning triangle for
pause/interruption, yellow during a passage and green for a new successful
passage awaiting review. Explicit attentive selection or **Mark as read** acknowledges
that exact passage and returns an armed schedule to waiting. The context menu captures
its passage identity when opened; a result arriving while it is open stays unread.
Unselected rows count requests from their live coordinator and loaded descendants;
the selected passage uses its authoritative request coverage. First-loaded history
starts read. Acknowledged finished schedules and terminal Stop use neutral.
Their `technical` projection exposes only the recorded current/retiring carrier
session and calendar identifiers, role, slot, temporal generation and pending
cleanup. It derives these from the same document read, including attempted
creation and deletion still awaiting reconciliation. Installation paths, provider
descriptors and profile environment stay private. The collapsed **Technical
details** disclosure keeps these conversations read-only, with the principal-wake
counter scoped to its current temporal generation. Source checks and business
launches retain their separate counters.
The native display adapter reads at most eight exact principal rows, validates
their adopted mapping and checks the document revision again after I/O. Missing,
foreign, partial or retired reads project `unknown`. `nextDueAt` is the earliest
active native principal's saved date; events label it as a check. Paused
rows contribute their counter but have no active next wake. `nativeStatus`
separately exposes active/paused/done/mixed principals beside the document's
desired state. `wakeCount` sums
native principal runs (prompt admissions or returned code programs) in the current `timeGeneration`; auxiliary
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
Create and Edit share empty-calendar validation; saved legacy intervals and
intentionally exhausted legacy passage limits stay retained read-only.

`checks: {count,since} | null` counts completed, revalidated source observations
committed with a principal fan-in's consumed high-water or passage reservation,
explicit Run now reservations and deferred launches. A group of up to eight principal
wakes counts once. Changed and unchanged events both count; baseline reads at Play,
auxiliary wakes, replays, overlaps, suppressed wakes, failed/incomplete source reads and
policies without events contribute zero. Admission or settlement retries preserve
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
connection's consumed API contract, effective automations setting and origin. Its
read-only activation check answers available or a refusal category,
responsible layer and discovered path. The native `scheduleSetting` read supplies
the effective state, provenance and deciding source. Environment OFF and every
discovered explicit document OFF refuse preparation, including an OFF hidden by a
higher ON.
The native document preparation endpoint records a ready proof for an enabled
Location and writes no configuration. Existing ready proofs are retained and
revalidated read-only.
Play/Resume perform this preparation automatically under the original view fences.
A structured refusal offers **Open scheduling settings** only for a server-openable
configuration ID; source/path and environment details use the focusable **i** tip.
The requested button shows loading and `aria-busy` during HTTP work, with a status
announcement. Uncertain activation keeps the exact receipt check available and
leaves the next Play explicit after recovery.
Both display routes revalidate workspace, connection, physical checkout and request
lifetime after asynchronous work. Missing methods or capabilities return an
explicit unavailable response. UI reads use the shared secondary HTTP budget.

Explicit events share the native source preparation boundary:
another schedule's successful passage, a completed one-time Mission, commits on
a local or remote branch, stable new messages in a followed conversation, and an explicit
file set; repository pull/merge request creation and merging, issue creation, GitHub account
notifications and Dependabot alerts.
One reader call per event key (`native-mission-condition-reader.ts`)
reads the listed events; within a group, any change is enough. Trigger events are
checked every 15 minutes; conditions are read at the slots that need them. Mission-source edges are checked
for cycles depth-first across every listed event. First Play establishes their baseline,
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

The editor groups Git branch commits and forge events in **Repository activity**. Its
single **Event** select groups Git and the detected forge with native optgroups;
event-specific fields stay in that card. `mission-editor-repository.ts` demands the
owned `repository-source` read only while such a card is shown. Detection never rewrites
a draft: selecting a forge event pins its provider, authority and repository path.
Stored GitHub and branch criteria keep their exact policy and source keys on unchanged saves.
`remote-branch-commits` pins the detected forge repository and exact `refs/heads/`
reference. The branch reader uses the forge's direct branch endpoint and the
existing account and repository checks. A changed remote tip triggers one
passage per observation, including force-updates. A missing branch blocks the
read. The tip is checked again before publishing a pending passage.

`mission-repository-source.ts` reads `repository-activity` through Contribute's
`ForgeWorkItems.openRepository`: shared remote selection, CLI discovery, anonymous
public access and request budget. `forge/activity.ts` reads all-state updated windows
for GitHub issues/PRs, GitLab issues/MRs and Gitea issues/PRs. Creation and merge times
select occurrences, with a normalized optional author. GitLab nested groups are encoded
as one project path. GitLab merge windows query `state=merged`, `merged_after` and
`order_by=merged_at`; their coverage follows merge timestamps independently of updates.
Gitea issue windows exhaust their unordered pagination; sorted
windows stop below the reference. All windows refuse incomplete coverage beyond four
50-item pages and ten seconds. Server Date and timestamp-tie IDs form each checkpoint;
repository, account and execution directory bind its placement. Revalidation checks
the fresh remote and account before publication. Summaries are frozen as untrusted
passage input and consumed only after success.
Inputs with only GitHub forge criteria keep their exact GitHub heading; configurations
containing repository-activity criteria use the repository heading.

GitHub account events and stored GitHub criteria use `mission-github-condition.ts` and `mission-github-source.ts` with the
existing `forge/transport.ts` read-only `gh` adapter. The CLI must be signed in on the
OpenCode host. `github.com` is the fixed authority; account ID and execution directory
bind each checkpoint. Notifications optionally select a repository; the other kinds
require `owner/repository`. Pull requests and issues accept a normalized optional author,
including `@` input and bot logins. The issues collection uses `state=all`, creation order
and `creator`, then distinguishes pull requests from issues locally. Notifications use
`all=true` and update timestamps; alerts use creation order with opaque `after` cursors
from pagination links and include all states. Requests keep their own endpoint and filters.
First Play uses the server Date as baseline; timestamp ties retain observed IDs. Each
observation is bounded to four 50-item pages, ten seconds and the checkpoint/input bounds.
Missing credentials/access, rate limits, malformed pages and incomplete windows remain
unavailable. Captured historical summaries enter the frozen input as untrusted data;
pre-publication revalidation checks the same signed-in account. Successful settlement
consumes only that frozen checkpoint.

The native calendar owner records create intents and reverse carrier ownership
before native effects. It acknowledges the reconciliation calendar before arming
principals. Temporal edits preserve retired proofs until cleanup, while relative
origins, the first Play and admitted counts remain durable. A first Play on a
calendar-backed policy requires ready settings activation. Creation remains paused.

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
With an owning CodeNomad backend present, passage coordinators, actors and descendants
can prepare a separate one-time or calendar-backed Mission through `mission.prepare`. The actual caller
owns its preparation and read-only target access in the ordinary project journal.
An explicitly requested `startOnCreation` continues only fresh creation through the
guarded first-Play contract in [Missions](MISSIONS.md#mission-profile-selection-and-creation-recovery).
Calendars run a fixed Code Mode program that calls the wake tool without a model
turn ([code wakes](MISSIONS_NATIVE_SCHEDULE_TRANSPORT.md#code-wakes)). An owned
prompt row can be paused, stopped or deleted and must be recreated to run.
Technical carriers use the reserved `ses_cn_schedule_` namespace, local title and
compaction hooks, and authoritative ordinary-input guards. Provisioning installs
only the Missions runtime. Ordinary sidebar browsing/search and conversation-source
pickers exclude carriers using the shared identity predicate, which also keeps
carrier compaction notifications silent. Native ownership and reconciliation readers
retain access. The thirty Mission result receipts keep their own retention bound.

Implementation contracts and isolated qualification commands:
[native contracts](MISSIONS_NATIVE_CONTRACTS.md) and
[schedule transport](MISSIONS_NATIVE_SCHEDULE_TRANSPORT.md).

## Threat model

HMAC authenticates the desktop bridge. An unrestricted shell can read the service
password and kv database and act with the service's privileges; native shell
permissions and OS isolation are the security boundary, so never describe marks as
tamper-proof. Ownership, authentication, permission and data-loss protections apply
to every passage, and unknown effects stay unknown.

## Settlement primitives

The implementation relies on existing native contracts, qualified at their callers:

- Session creation with a caller-supplied session ID is idempotent.
- Prompt admission with a caller-supplied message ID is first-admission-wins.
- Plugin tools receive native session, message and call identity.
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

Current passage display (`opencode/missions/native-recurrence-current.ts`) serves native
schedules. `recurrenceCurrent` returns a bounded owner identity before any journal slice:
project/Location, schedule and passage IDs, immutable execution mission ID, the digest of
frozen pending/root evidence and the configuration and time generations. `ownerRevision` separately fences
publication across owner document changes without invalidating unchanged execution sources.

`recurrenceCurrentPage` requires that exact source and an ordinary bounded header, task,
field or activity selector. Body selectors use `readMissionContent` through the same
64-KiB UTF-8 envelope and 16-KiB request boundary. Every transfer validates one accepted
isolated mission range, including entry bounds, damage, coordinator/profile identity and
the creation request carrying its passage ID. The owner is reread before publication.
Journal range/event limits bound source work; headers never serialize the full passage
map or concatenate all passage bodies. The isolated finish counter stays separate.

The HTTP current routes recheck project, Location, connection, ownership and source around
native observation. Their publication reread obtains only owner identity. Activity reuses
the bounded context/observation paginator, with source checks on every native slice;
separately observed windows retain partial/unknown coverage. Each native page request
observes its range once.

The UI reuses `createMissionPanelInventory` for selected passages, without project inventory
discovery or project completion seeding. `MissionPanelScope` supplies that exact owner to
the existing tree, graph, Needs-you, fields and row readers. Body cache identities include
the passage source, and historical reports retain their exact report selectors. Explicit
continuation/Retry, original deadlines, stream-slot ownership and last-good displays follow
the ordinary panel contract. Unrelated journal revisions revalidate the header without
rereading unchanged task windows or bodies. Scheduled inventory and schedule controls
retain their document-owned paths.

Each outstanding current body demand owns one monotonic 30-second deadline and
cancellation signal across semantic content offsets, automatic restarts/revalidation
and outer wire pieces. Assembly is staged before the final publication check. A
fulfilled demand ends its operation; a later user extension or explicit Retry can
start a fresh one. Need reductions and consumer releases reconsider aggregate coverage
even during a running continuation: fresh covered demand ends that read immediately,
while stale/invalidated data and outstanding peers keep their original operation.
Every current pending promotion shares the store's stale/mark, exact expected digest and
live-operation deadline eligibility, including accept, demand changes and completion.
Ending an operation discards unpromoted current data and retains its last good display.
Failed outstanding operations retain their budget through automatic revalidation.
Technical details exposes the scoped persisted-field/raw-page reader for
compact current maps.

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
  without native terminal failure.

The terminal reader uses native `session_message.seq`, anchored to the original
coordinator input or exact fresh managed-root assignment. Historical failures
before that input are excluded. Reused external roots retain uncertainty while
their entry/family provenance is unqualified. The bounded `job.background/` KV
projection (kind and session IDs only, ≤1024 records) blocks settlement while a
completed child still owes its native parent notification.

Advance watched processed-message cursors **only on completed**.
Failed and ended-without-report leave those cursors unchanged.

Watched sources (`opencode/missions/native-service-adapter.ts`, `opencode/missions/native-scheduled-passage-sources.ts`,
`missions/mission-document-passage-input.ts`):

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
SDK) never mints a mark. The dock sends `x-codenomad-human-answer` only for a
real pointer click or submit keydown on that exact question, never for
`element.click()`, `requestSubmit()`, synthetic events, developer automation,
automatic or SDK calls (`tests/browser/interruption-dock.test.ts`,
`automation-input.test.ts`). The input captures a one-use token bound to the exact
request, schema and answer (`lib/form-answer-interaction.ts`); it expires with that
input task and is consumed at the SDK send in `stores/instances.ts`. Only a dispatched mark reply with a lost outcome is
reported as uncertain.

Missing evidence leaves the gate unmet and never replays an answer; the ordinary
answer path keeps its ownership and uncertainty checks.

## Agent conventions

### Unified document foundation

`missions/launch-policy.ts` and `mission-document{,-state,-store}.ts` provide a
strict internal configuration codec and conditional document store. Their
`codenomad-missions/documents-v1` namespace owns paused creation, launch criteria
(triggers and conditions), the stored legacy policies read
through `missionLaunchModel`, the single deferred launch and an admitted-passage
count. Relative legacy origins are frozen at first Play; the slot end applies to
recorded due times, including late arrivals. Engine code reads launch policies only
through `missionLaunchModel` and its helpers, never their stored fields.
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
preserved.

The storage-only `documentActivation` RPC retains a namespace authority digest and
the original request/revision; a stored intent may also list up to two configuration
targets with their digests. `missionScheduleActivationJournal` in the server
routes adapts its `prepare` and `ready` phases to the settings executor. Ready follows that executor's
positive effective read and keeps the Mission paused. Immediate Play leaves this
field null. Keep credentials and raw configuration out of the document.

Scheduled admission, source baselines/changes, native adoption/cleanup, complete
fan-in coverage, terminal-turn correlation and family quiescence belong to their
own qualified adapters. Keep unknown data intact and qualification fixtures isolated.

- Never substitute a persistent CodeNomad backend or a window timer for OpenCode service/plugin autonomy. Apply the unified-calendar restart and settlement contracts above.
- Core: `missions/launch-policy.ts` and `missions/mission-document{,-state,-store}.ts` (native side `opencode/missions/native-mission-schedule-*.ts` and `native-scheduled-passage-*.ts`); omitting a profile variant is valid. Every rule in the sections above binds.
- Root and schedule admission read the family identity with `readFamilyAuthorityIdentity` (`workspaces/family-authority-claim.ts`) only for a directory WorkspaceManager already authorized: registered linked worktrees share their Git common directory's identity, and a Git-free conversation has none, so it can never infer a family.
