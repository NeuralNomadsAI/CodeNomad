# CodeNomad Missions / Session Mesh

Missions coordinate native OpenCode V2 execution through a durable project map,
dependency-aware tasks, human controls and results.

Native integration boundaries, private Core service shapes and per-invocation
lifetime requirements: [Missions native contracts](MISSIONS_NATIVE_CONTRACTS.md).

Programmed Missions run in the OpenCode service with CodeNomad closed (§Mission calendar tool); never run them
through a persistent CodeNomad backend.

The plugin exposes `mission.inspect`, `mission.delegate`, `mission.revise`,
`mission.report`, `mission.briefing`, `mission.interrupt`, `mission.prepare`, `mission.program`,
`mission.control`, `mission.configure`, `mission.delete` and `mission.settings`.
The coordinator is the topology writer.
Native RPC schemas use the decoder's portable primitives; strict server codecs
validate principal exclusivity and identifier/digest formats before authentication
or effects. `missions/native-wire-schema.test.ts` converts every Missions RPC input,
output and event through the native schema representation.
Native task declaration returns the canonical assignment for ordinary OpenCode
subagent calls. Native helpers return through their actual parent; the coordinator
alone records the declared task's business readout. Explicit independent actors
retain correlated report notifications and native queue delivery.

Model-facing mutation results stay compact (`missions/tool-result.ts`): the
disposition, current revision, run state, frontier and the affected tasks
(status, generation, dependencies and lineage), never briefs, reports or the
objective. Each result stays within the inspect bound below (`boundedMutation`): a
frontier or a declared task's `assignmentPrompt` too large for it gives way, largest
first, to `{ omittedCharacters, read }` naming its exact `mission.inspect` read, and a
revision lists the affected tasks that fit, in map order, with `taskPage` counting the
rest. A coordinator reads such a prompt whole before passing it (the delegate tool says
so; the prompt is context, never admission). Among Wayfinder decisions, only a human
answer claimed from an unbound decision-worker conversation must prove that conversation
was born of the exact canonical prompt; a coordinator decision and a coordinator-asked
answer keep their own gates (§Human questions and decisions). `mission.interrupt`
returns a receipt that fits whole; a larger one keeps `complete`, the totals and each
conversation's outcome with its descendant counts (their session IDs left out, paged in
receipt order with `sessionPage` if even those exceed the bound) and names in `receipt`
a `{ kind: "receipt", digest, offset }` read of the whole original receipt. The plugin
holds that receipt (`missions/interrupt-receipts.ts`) as its serialized original,
content-addressed and owned by the interrupting coordinator. A task's slot is the
coordinator, mission and task the interruption resolved, whether the call named the
mission or not, and every successful interruption replaces the slot's previous receipt,
a newer result that fits whole retiring it. All held receipts share one budget per
registration, 32 MiB counting each body as UTF-16 code units (the digest's encoding). The
largest accepted receipt shape (200 conversations of 64 descendants, 240-character IDs)
counts about 6 MB with plain IDs, so several of those, or dozens of ordinary ones, stay
held. Beyond it the least recently held or read receipts go first, with their slots; a
receipt larger than the whole budget (possible when its IDs need heavy JSON escaping)
is never held, so its marker is refused from the first read, and disposal or a reload releases
them all. Receipts outlive their mission's deletion, which runs in the separately
registered RPC plugin: a deleted mission's coordinator may still read its own receipt
until the budget, a replacement or a reload removes it. A read the plugin no
longer holds is refused, never answered by replaying or re-observing the interruption.
Every `mission.inspect` result,
as the tool serializes it (two-space indented JSON, page metadata and markers
included), stays within 100,000 characters (`missions/inspect-view.ts`): a value
that cannot fit is replaced by
`{ omittedCharacters, read }`, and `mission.inspect(read)` (a `content` read naming
an inspection, map, task, report or plan-change field at the map's revision, the
native catalog or a held interrupt receipt) returns that value in slices, the string itself or the value's JSON,
each with the `next` read until the last. Every read carries the `digest` (SHA-256 of
the UTF-16 code units, base64url, so unpaired surrogates keep distinct digests) of the
exact text its slices are cut from, and each slice re-reads its
value and is refused when that text's digest differs: values read afresh on every
call (the catalog, a task's `native` conversations and `humanAnswers`) can change
without a new revision, and slices never join two observations. Map reads are also
refused at another revision. The catalog read (`{ kind: "catalog", digest, offset }`)
names no mission: it is the caller's Location's catalog, read afresh after the
project-ownership checks alone (`MissionControl.ownedRoot`, no mission or journal read), so an
owned conversation without a mission pages a large catalog too, and a failing mission journal
never blocks it. A marker names its value as read before any value nested in it gave
way. Fitting serializes the result once and keeps its exact size as values give way
(each change counted at the value's indentation), so it stays linear in the result's
source. A map within the
limit is returned whole. A larger one pages its tasks in map order: the plain call
returns the header (the inspection and the map without tasks, its largest fields
replaced, largest first, until the whole page fits) with the whole tasks that still
fit, and `mission.inspect({ taskOffset })` returns whole tasks from that position,
following `taskPage.nextTaskOffset`; a task too large for a page alone keeps its
identity and its reports' IDs and outcomes in place, with reads for its largest
values, so every explicit page progresses. Tasks carry their reports (`report`,
`lateReports`) and pages leave out `mission.reports`, which repeats them.
`missions/tool-inspection.ts` builds this view inside the owning journal invocation.
The scheduled business bridge calls `inspectTool`, so task/list pages, observed
conversations, human-answer candidates, reports and exact content slices fit before
crossing its bounded RPC response. Mutations share `missionMutationToolResult` with
the ordinary tools and carry the already fitted result, including its exact omission
reads and task pages, in `toolResult`. The 100,000 UTF-16-unit JSON bound costs at
most 300,000 UTF-8 bytes plus fixed RPC envelopes, within the 1 MiB transport limit.
`mission.inspect({ list: true })` pages every project Mission the same way (`listOffset`,
`listPage.nextListOffset`). `mission.inspect({ taskKey })`
rereads one task with its contract, exact current assignment prompt and every report
of that task, each once, its largest values replaced the same way. A native
Wayfinder `decision` declaration also states how the coordinator settles it
(`WAYFINDER_DECISION_REQUIREMENT`), the rule `settleDecision` enforces (§Human
questions and decisions).

Coordinator actions that need native reads or effects outside the plugin's
Promise API cross the authenticated desktop bridge (`sendMissionInput`, fixed error
codes in `missions/recovery-error.ts`), so they work only with backend presence and
refuse otherwise. Coordinators retain `mission.interrupt`; any owned project session
can use `mission.prepare`, including descendants, task actors and scheduled passages.

- `mission.inspect({ taskKey })` adds the task's observed native conversations
  (`server/routes/mission-task-native.ts`): the coordinator's direct children
  whose first user message carries that task's canonical assignment header
  (`missions/task-sessions.ts`, shared with the UI). This is advisory display
  evidence; never settle a task from it.
- `mission.interrupt({ taskKey })` stops a retired native task's conversations:
  each one's family deepest first through `interruptNativeMissionFamily`, then the
  conversation itself, then the same post-interrupt recheck, settle and quiet
  verification as lifecycle Stop, cancelling its queued inputs. It is refused while
  an open task lives in that conversation's family: a continuation or a nested
  task along `reuseFromTaskKey`/`parentTaskKey` chains, or its actor. The coordinator, other tasks and the plan are
  untouched, under the worktree-deletion fence; `complete: false` is reported
  honestly, and an empty result notes that only canonical assignments are visible.
- `mission.prepare` creates a separate one-time or scheduled hand-off through the same
  `prepareMissionCreation` pipeline, holds and fences as the editor, at the
  author's Location. `startOnCreation` defaults false; the user then starts it with
  Play. An explicitly requested `true` may continue only its fresh creation
  acknowledgement through the ordinary guarded lifecycle operation. The trusted `preparedBy`
  (`{ coordinatorSessionId, missionId? }`) records its author for immutable replay
  (`inspect({ missionID })`, `inspect({ list: true })`). The stable
  `coordinatorSessionId` field names the actual author session, including a descendant;
  `missionId` records the source from native membership, passage metadata or bounded
  native ancestry when available. Stored provenance with both fields uses the same
  journal, index and RPC readers. Ordinary roots, coordinators, current or historical
  task actors, descendants and scheduled-passage sessions share the author admission.
  Native control and the backend independently validate project and placement;
  ambiguous ownership is refused. Passage preparation uses the ordinary project
  journal, preserving its isolated source journal. Project target reads use that
  same ordinary journal; passage lists combine it with isolated passage membership.
  Scheduled documents retain the author and original inputs before their first journal
  exists; project list and point reads use bounded native document pages without reconciliation.
  The calling conversation stays unchanged. Follow
  the [creation and retry discipline](#mission-profile-selection-and-creation-recovery).

The human-answer gate's `discover` finds fresh children of the expected parent
whose `subagent` call carried the exact assignment prompt, and the coordinator's
answered question fields that bind this task (`fieldDecisionTag` in
`missions/decision-question-tag.ts`): its bounded lookup counts only marks whose
question fields (question text or header) hold the task's `questionTag`, so
unrelated or older Forms, and answers or options quoting the tag, never spend its
bound. It keeps only answers
its own `verify` accepts; each candidate names who asked (`askedBy`). A reached
bound, a pending mark or a confirmed answer that fails verification makes the
discovery incomplete. `inspect({ taskKey })` lists the candidates as ready
artifacts with their completeness. A native decision readout may omit its
artifact when the discovery is complete with exactly one candidate; every
candidate answers this exact task, and the gate still verifies it. Never infer
candidates from free text, titles or timing.
`mission.briefing` treats requestID `"auto"` as `auto:<revision>` and may omit
`basedOnRevision`: the server then uses the current revision, or refuses a
different summary when the latest automatic briefing is still the last event. One replacement task may merge several retired tasks; it names one
of them in `replacesTaskKey`.

## Mission profile selection and creation recovery

Explicit `missionID` reads any Mission in the owned project, including human-created
Missions and another agent's preparation. `mission.inspect({ project })` exposes
fixed pure native reads through the unique owning backend: `panel` for summaries,
cleanups and mission fields; `current`, `current-page`, `current-content` for an
admitted passage; and `sources` for local
branches, native conversation pages, coordinator roots and the detected forge.
`playbook` reads one template's exact steps, roles and prompts for the selected
taskMode, sharing the UI recipe builder. These reuse the panel's codecs, native
page bounds and physical-directory admission.
Every backend read revalidates the actual native caller, project and Location.
Source continuation is explicit; file criteria use relative paths discovered with
the ordinary file tools. Schedule list/read retains counts, observations, control
receipts and the bounded result history. Reads keep all execution identities intact.

`mission.inspect({ start })` attaches the calling root conversation as the
coordinator of a paused mission for human Play. `mission.prepare` creates a separate
mission, preserving the calling conversation: a new coordinator for one-time work,
or a fresh root per scheduled passage unless an eligible root is explicitly selected.
Its `startOnCreation?: boolean` defaults false; true requires the user's explicit
automatic first-Play request. `missionID` selects an existing mission;
combining it with `start` is refused before routing, preference discovery or creation.
Both creation inputs accept an optional trimmed, single-line title of 1–60
characters and preserve notes verbatim, including empty and whitespace-only notes.
An exact `start` retry compares the original creation title, objective, notes,
template and requested choices even after human edits.

### Editor and agent-tool options

| Editor option | Agent-tool contract |
| --- | --- |
| Configuration | `inspect({ configurations: true })` lists saved records; `configurations: "<id>"` reads one. Copy its chosen creation fields explicitly. `settings` with scope `configurations` saves, replaces/renames by ID, deletes or resets the library. |
| Objective, Title, Notes | `prepare` and `inspect.start` accept `objective`, optional `title` and verbatim `notes`. |
| Playbook | Both accept `template`: `custom`, `debug`, `wayfinder`, `delivery`, `compare`. |
| Task sessions | Both accept `taskMode`: `native` or `independent`, with the same preference resolution as the editor. |
| Subagent depth | `settings` with scope `depth` reads the project snapshot and saves 1–10 or `null` (Inherit), with the exact document expectation. Never change it to bypass a delegation limit. |
| Agents and models | Both accept `profiles.coordinator` and `profiles.roles`, with `agent`, `model.providerID`, `model.id` and optional `model.variant`. Omitted slots inherit preferences. |
| Start automatically | `prepare.startOnCreation`, default false; true requires an explicit user request and continues only a fresh creation acknowledgement. `inspect.start` waits for human Play. |
| Keep coordinator active with /goal | `prepare.coordinatorGoal` and `inspect.start.coordinatorGoal`, default false (one-time missions). Arms OpenCode `/goal` on the coordinator after Play using a short deterministic objective, pauses/resumes it with Mission Pause/Resume, clears it when the Mission ends, arms it again when a failed Mission is recovered, and auto-resumes restart pauses (`The server restarted while the goal was active`) at most once per dead boot (up to 3 times) both on plugin startup and unattended via a project-level Code Mode watchdog automation (`codenomad.mission_goal_reconcile` on `ses_cn_goal_<projectToken>`). Runtime state lives beside the journal (`codenomad-missions/coordinator-goal-v1/<projectToken>/<missionID>`) while the Mission runs, without advancing mission revision or consuming journal capacity; foreign goals, a goal the user cleared while the Mission runs, and manual/stall/round-limit pauses stay untouched. Every Mission change reaches the runtime through `MissionControl.coordinatorGoalMission`, answered by the control's own journal projection: never read a Mission's range again on that path. |
| Scheduling | `prepare.launch.when` accepts ordered `now`, cron and event criteria with the editor's grouping and validation. Hourly/daily/weekday/monthly shortcuts use cron expressions and their IANA zone. |
| Coordinator session | `prepare.coordinatorSessionID` selects an eligible idle root for calendar-backed work; omission selects a fresh root per passage. |
| Followed conversations | `prepare.watchedConversationIDs` carries followed context; a `conversation-message` criterion also supplies its selected conversation. |

Repository activity, GitHub account events, local branch commits and file changes use the shared
[launch-criteria contract](MISSIONS_RECURRING.md#launch-criteria).

`mission.inspect({ configurations: true })` lists the owning backend's saved
configuration IDs, names and templates. `configurations: "<id>"` reads one complete
saved record plus the editor's suggested `title` (collapsed whitespace, bounded to
60 characters). These read-only requests work from any owned conversation outside a mission
and from a scheduled-passage coordinator. Lists, point reads and content slices
use the ordinary owning backend, select no journal and use the same strict
unique-backend discovery as profile preferences. The backend reads `ui.settings.missionModels` through
`getRawConfigOwner("ui")`; the shared `missions/model-library.ts` codec validates
every record. An absent field returns an empty list; invalid data and unavailable
or ambiguous owners return their respective preference errors, with bytes preserved.
The list stays short (at most 20 entries); a record exceeding the inspection bound
returns a `{ kind: "configuration", configurationID, digest, offset }` content read,
whose slices reread the owner and reject changed content. Pass each `read` whole and
follow `next`. Copy the selected objective, suggested title, notes, template,
profiles and task mode explicitly into creation so its retry contract freezes
the supplied values.

Both `mission.prepare` and `mission.inspect({ start })` resolve omitted
coordinator/role profiles and `taskMode` from the owning CodeNomad backend's
`ui.settings.missionProfileDefaults`. The editor and server share
`missions/profile-defaults.ts` and `freezeCompareProfiles`: a playbook's slot
overrides the global `all` slot; the global `specialist` supplies task roles,
with the Compare judge using the coordinator's model by default. Each supplied
profile slot wins whole, including `{}` (OpenCode defaults) or an agent-only
profile; `profiles: {}` leaves every slot eligible for preferences. After slot
selection, Compare fills any missing judge model from the known coordinator
model through `freezeCompareProfiles`, including explicit/preference `{}` or
agent-only slots; a judge's own model stays unchanged. An explicit `taskMode`
wins over the playbook preference, then the global preference; the final fallback
is `native`. Missing profile preferences fall back to OpenCode defaults.
Supplying the coordinator, every exact role of the selected template and
`taskMode` skips backend preferences entirely; `{}` counts as an explicit profile
slot. All origins are `explicit`, and preference availability stays unobserved.
Partial or omitted selections read the owning backend's preferences.

Preparation tool replies and inspections with creation metadata expose
`selection: { profiles, taskMode, origins }`: the saved coordinator and every
role of the selected playbook, plus origins `explicit`, `preference` or
`opencode-default` for the coordinator, each role and task mode. The journal,
document and authoritative backend snapshot retain `creationDefaults`, including
the original request, for replay; tool replies project that metadata only as
`selection`. A chosen Compare judge slot retains its explicit/preference origin
even when its model is inherited; an absent judge slot inherits the coordinator's
origin. These are saved requested selectors; catalog validation and native
execution checks establish availability and actual execution separately.
`inspect({ start })` uses the caller as coordinator. A conversation that coordinates,
the caller's or one a creation names, is put on the resolved coordinator agent and
model (`switchAgent`, `switchModel`); one that cannot be changed coordinates as it is.
A chosen conversation is never refused for the agent or model it runs.

`inspect({ start })` reads preferences before entering the project mutation
lane. Admission rereads creation events and document defaults under that lane;
already recorded choices win over concurrent preference results. Document-mode
replay rechecks the coordinator Location and original creation digest.

When preferences are needed, with no bridge presence or zero proven owning
backends, `inspect({ start })` uses explicit inputs and OpenCode defaults for
omitted choices (`native` task-mode fallback), with origins `explicit` or
`opencode-default` and `selection.preferences: "unavailable"`. The saved metadata
retains that warning on retries, including after a backend appears. Multiple
owning backends, failed or incomplete backend discovery, or an unreadable
preference document return `mission-preferences-unavailable`; invalid preferences
return `mission-preferences-invalid`. Restore backend discovery and session
ownership, then reload preferences, or supply fully explicit choices.

Strict discovery follows the shared [registration liveness and pruning rules](BROWSER_AUTOMATION.md#integration-and-shared-bridge).
Unreadable registrations with a live or indeterminate local publisher retain
indeterminate ownership and refuse resolution. WSL skips unparseable Windows
registrations (unsupported schemas, oversized files and invalid URLs): they offer
no usable authenticated endpoint or supported contract. Valid Windows
registrations require endpoint evidence. A refused
connection establishes absence; timeouts and HTTP/authentication failures leave
ownership indeterminate. A typed missing-session reply, an empty backend workspace
inventory or a successful ownership read proving an unrelated project establishes
non-ownership, including with other workspaces open. Actual Git/WSL ownership-read
failures remain indeterminate and refuse resolution.

Missing Windows interop executables (`ENOENT`/`ENOEXEC` from `cmd.exe` or
`wslpath`) establish absence of reachable Windows backends for that WSL process;
local discovery continues. Timeouts, failed commands and uncertain path results
refuse strict discovery. Strict requests retry failed path lookups after two
seconds. Legacy backends without
negative ownership proof or preference-command support return
`mission-preferences-update-required`: update CodeNomad before inheriting defaults.
A live backend's preferences stay protected by this refusal.

`mission.prepare` requires an owning backend for fenced creation even when profile
resolution can use the no-owner fallback. Fully explicit choices make no preference
request; preparation still requires its owning backend. Before sending creation
provenance, preparation requires the backend's positive `missionCreationDefaults`
and `missionPreparationStart` capabilities. Preparation also requires the native
document's positive `automaticStart` capability before creation dispatch.
Missing backend support returns the update-required refusal before dispatch
and releases only newly reserved choices; previous uncertain outcomes remain retained.
Calendar-backed preparation additionally requires the native document's positive
`agentSchedulePreparation` capability before reserving or dispatching creation.

Preparation results separate `outcome: prepared | activated | refused | uncertain`
and a `target: { kind: "one-time", mission } | { kind: "schedule", document }`, retained after a start refusal or
uncertain start. Confirmed outcomes carry `acknowledgement: fresh | recovered`;
`activated` confirms the original first Play. Refusals name their phase and code;
uncertainty retains the original request and Mission identities. Tool targets expose
compact state and saved selection; `inspect` reads the complete map.
The returned uncertain `requestID` identifies the native creation or first-Play
operation; retries keep the original tool inputs, never substitute that derived ID.

Native creation decides the acknowledgement: an existing event/document, including
a document whose journal publication completes in this invocation, is recovered.
Only `startOnCreation: true` plus a fresh acknowledgement may continue. The immutable
`creation` binding retains the author, normalized original inputs and creation
defaults. Its single `automaticStart: { requestID, attempted }` slot uses a
creation-derived lifecycle identity. The ordinary lifecycle RPC consumes it by exact
document CAS before first-Play intent or effects, retaining the native operation and
message identities in `oneTime.firstPlay`. Concurrent human controls keep their exact
journal/document revision guards. An attempted slot stays consumed after any failure.
Recovered creation with an unattempted slot stays prepared; an attempted slot reports
only the original first-Play acknowledgement or uncertainty. Never send another Play
from prepare replay, receipt reads, inspection, listing, reconnect or restart.
For scheduled preparation, `launch?: { when: [...] }` uses the editor's ordered
criteria codec and its OR/IF/ELSE grouping, limits, event sources and cron zones.
An absent or empty list and a sole `now` select one-time preparation.
`watchedConversationIDs` freezes followed sources; `coordinatorSessionID` explicitly
selects an eligible root for a schedule, with a fresh root per passage as the default.
Calendar profiles resolve to complete explicit agent/model selections and pass the
native catalog check. Launch policy, followed sources, coordinator choice, target kind
and automatic start participate in the original immutable retry identity.
The first-Play intent CAS consumes the single automatic-start slot.
Document recovery reads the backend's exact retained receipt to release its physical
permit; its internal observation-only path keeps absent or partial receipts uncertain.

### Agent one-time controls

Every owned project conversation can use `mission.control`, `mission.configure`
and `mission.delete` on any project Mission, including human-created Missions.
All mutations take a stable `requestID` and the owning read's `expectedRevision`.
`control` maps Play/Resume to the existing Start operation, Pause to graceful
Pause, Interrupt to immediate Pause and Stop to terminal Stop. Recovery targets
the coordinator (including reopening a failed Mission) or one missing report by
`taskKey`. Recovery deduplicates the mission/revision/target contract. Request
update uses the shared fixed briefing text and ordinary native prompt admission,
with `delivery: "steer"` and the coordinator's existing native profile.

`configure.save` accepts objective/notes for the journal's recorded text edit, or
the editor's complete `configuration` for the shared schedule configuration and
immediate/calendar conversion admission. Its document guards apply before
admission and between passages. `delete.delete` freezes `deleteManagedSessions`
from the supplied option or the owning profile's `missionDeleteSessions` preference.
Its ordinary cleanup preserves excluded native conversations.

Each tool's `read` observes the Mission and optionally its exact `requestID`;
deletion reads retain cleanup after the map disappears. Native project-tool
intents and bounded receipts retain the original action, payload and revision.
Text-edit replies project the request identity and payload digest; native storage
retains the original text.
Reads also recover the panel's existing lifecycle and deletion identities;
an original native Start is returned as the canonical tool action `play`.
Uncertain requests reserve their physical permit and block replacement agent
identities. Exact completed replays return their saved receipt. Explicit
`retry: true` requires a positively read partial original lifecycle/cleanup
receipt; structural configuration uses its existing partial-receipt contract.
Keep every original field unchanged, including Pause's graceful intent.
Never resend from passive reads or replace an unknown request identity.
Explicit Stop retains the panel's ability to supersede a positively saved partial
lifecycle action at the current revision; reads preserve that original receipt
with its superseded outcome.

The private bridge discovers and revalidates the native caller and owning
project, connection and physical checkout. It signs an agent-only principal,
exact command, project, directory and issue time. The native controller asks the
owning backend to verify its signature and fresh ownership before effects.
Public HTTP keeps its human entry. The authenticated human-answer mark remains
behind its separate human gate.

### Agent library and preferences

`mission.settings` is available to every owned project conversation through the
unique owning backend. Its fixed scopes share the UI's existing write owners:

- `configurations`: `read` returns validity, presence, a raw-field `expectation`
  and the short ID/name/template list. `save` takes `configuration` with a stable
  UUID `id`, name, objective, verbatim notes, template and optional profiles/taskMode.
  A new ID appends; an existing ID replaces/renames that record. `delete` takes
  `configurationID`; `reset` writes an empty library, including for invalid data.
  `inspect.configurations` reads complete records with bounded slices. To save
  an existing Mission's instructions, read its recorded objective/notes and
  template/profiles/taskMode, then supply those fields to `settings.save`.
- `preferences`: select `field: "missionProfileDefaults"` or
  `"missionDeleteSessions"`. `read` returns validity, presence, expectation and
  the decoded value when valid. `save` replaces the `defaults` array (scopes
  `all`, `custom`, `debug`, `wayfinder`, `delivery`, `compare`) or supplies
  `deleteSessions`. Omitted scopes, roles and taskMode inherit; a role's `{}` is
  an explicit OpenCode-default selection. A scope's profile reset keeps its
  taskMode by supplying that entry with `profiles: {}`. `reset` clears defaults
  or removes the deletion preference to restore its false fallback. A complete
  valid save or reset can repair invalid data using its original expectation.
  Both fields and the library belong globally to the owning CodeNomad profile,
  across its projects.
- `depth`: `read` returns the existing `SubagentDepthSettings` snapshot.
  `save` takes `depth: 1–10 | null` with `snapshot.project.expectation`;
  `null` inherits and repairs a redundant empty project `experimental` object.
  The native owner keeps neighboring settings, comments and its marked nesting rule.

The private authenticated bridge supplies the actual agent principal and rechecks
caller/project/Location ownership before the write. Profile expectations hash
the exact raw field together with its presence as UTF-16LE JSON using SHA-256;
absence, `{}` and normalized values remain distinct. The bridge reads through
`getRawConfigOwner`, validates with the shared library/default codecs, then
uses `applyConditionalMissionPreferences`. Its authoritative write-base check
refuses intervening edits, preserving neighboring fields through the ordinary
owner merge. A changed field returns `settings-conflict`; after a conflict or
unknown acknowledgement, read afresh before choosing another edit.

### Human action / agent surface

The Mission components, Missions Preferences and public Mission routes use these
equivalent agent surfaces:

| Human action | Agent surface |
| --- | --- |
| Create with title, instructions, notes, playbook, profiles and task sessions | `prepare`; `inspect.start` attaches the calling root |
| Load a configuration; save instructions; replace/rename, remove or repair a configuration | `inspect.configurations`; `settings` / `configurations` |
| Global/playbook defaults, role inheritance, resets and deletion preference | `settings` / `preferences` |
| Project depth, Inherit, empty experimental repair and refresh | `settings` / `depth` |
| Launch criteria, the coordinator conversation of a programmed Mission; followed conversations of a one-time Mission | `program`; `prepare` |
| Discover branches, conversations, coordinator candidates and forge | `inspect.project` / `sources`; ordinary file tools for relative file criteria |
| Read playbook steps, roles and complete instructions | `inspect.project` / `playbook`, with template and optional taskMode |
| Read lists, tasks, reports, plan changes, passages, history and cleanup | `inspect`, its bounded project views and content/page continuations |
| One-time Start/Resume, graceful Pause, Interrupt now, Stop | `control` |
| Recover coordination or a missing report; request an update | `control` |
| Edit text | `configure` |
| Delete and explicitly continue partial controls, edits or cleanup | `delete`; `control`/`configure` exact receipt reads and `retry` |
| Save, pause, resume or delete a programmed Mission | `program` |

Presentation gestures (selection, copy, mark read, opening conversations) remain
window-local. Authenticated human answers use the human question gate. Scheduled
preparations can explicitly select the agent's own eligible root. One-time
preparation uses a fresh root, while `inspect.start` attaches the calling root.

### Preparation identity

Preparation requestIDs are scoped to the actual author and native source mission
when present; authors outside a mission use their stable `outside-mission` domain.
The original author/source binding owns replay after source completion or release
of a reused passage root. Before creation, the author/request lane searches the
journal, paged documents and retained preparation bindings for existing identities;
multiple existing identities refuse as a conflict. Documents with an extended creation
binding compare its frozen inputs; historical one-time documents use their original
journal inputs and available creation choices. Each author retains its original
replay identity. Compaction keeps the original author/source, creation request and
input digest in the existing bounded document tombstone. Preparation identity reads
include these tombstones, so deletion refuses replay after source release and restart
for both scheduled and one-time targets; display inventories omit them.
Preparations with the
same requestID are serialized. Reuse that requestID and the original inputs:
a retry first reads the saved creation event/document and returns the saved
mission or a conflict. `mission.prepare` alone reserves a standalone durable
pre-dispatch intent for the chosen profiles, task mode and origins across
uncertain attempts, preference changes and restarts. `inspect({ start })`
retains its choices through its journal/document receipt under the native
invocation identity.

A positive preparation result or a definitive refusal proving that the attempt
had no effect releases its retained choices. An unknown outcome keeps them; a
retry refused during prevalidation leaves the preceding attempt's uncertainty
intact. At most 128 unknown preparation choices are retained per project, each
for 24 hours from its first reservation; retries preserve that deadline. At
capacity, retry the original requestIDs to recover completed preparations and
release their slots, or wait for their 24-hour retention to expire.

Capacity scans skip unreadable intent entries while preserving their bytes.
Retrying that exact requestID still refuses unreadable evidence, preventing
replay of a possibly dispatched preparation; unrelated requests remain usable.

A clock rollback keeps future-dated intents fresh until their stored creation
time has aged through the retention window; retries reuse their saved choices.

After expiry, preferences may be read anew only when the creation event and
document are both absent. A positive receipt or saved document keeps its
choices frozen. Expiry affects retained choices alone; native holds and
authorization keep their own settlement rules. Check the mission and original
conversation before choosing a new requestID for an uncertain outcome. Never
duplicate uncertain work or resume automatically after expiry. Never create an
intermediate mission solely to access `mission.prepare`. A held uncertain attempt
is reported uncertain.

## Human questions and decisions

Only the coordinator talks to the human. Every assignment prompt and helper policy
(`NATIVE_WORK` in `missions/recipes.ts`) tells task actors and their helpers never to
ask or answer for the human: they return each open question to their parent with
options, evidence, consequences, reversibility and a recommendation, and continue
the work that does not depend on it. Every coordinator, one-time or recurring, gets
`HUMAN_QUESTIONS`: resolve first (inspect the repository, research, delegate an
investigation, adopt a reversible default recorded as an assumption), ask only
irreducible items (consent, credentials, choices expensive to reverse, product
decisions the objective leaves open), batch pending questions into one native
question call and launch unrelated ready work before asking, since the call waits.
OpenCode's General subagent denies the question tool, so this also matches what
native children can do.

A completed native Wayfinder `decision` readout is settled by `settleDecision`
(`missions/decision-gate.ts`, artifacts in `missions/decision-artifact.ts`):

- **Coordinator decision**: `{ kind: "decision", decidedBy: "coordinator", question,
  decision, rationale, alternatives?, reversal? }`, strict, with no `answer` or
  provenance. Accepted without human proof, for evidence that suffices and a choice
  that is cheap to reverse; it never counts as the human's answer or consent.
- **Human answer**: `{ kind: "decision", decidedBy?: "human", question, answer,
  provenance }`. A `coordinator-form-answer` provenance cites one field of the
  coordinator's own question call, bound per field to exactly one decision task:
  asked from its root conversation (no delegation to prove), that field's question
  text ends with the task's `questionTag` (`[decision <taskKey> <code>]`, the code
  derived from the mission and task, returned with the declaration and by
  `inspect({ taskKey })`) and neither its question nor its header holds any other
  tag, it was answered after the task was declared, and it settles no other live
  decision task; the field's own answer is the one recorded. Options and answers
  never bind, a field naming two decisions binds none, and the other fields of a
  batched question bind independently. MissionControl, the native gate and
  discovery share that parser (`fieldDecisionTag`). The human reads the tag, so an
  answer cannot be rebound to another task, mission or reused coordinator root. A `native-form-answer` provenance cites the
  decision conversation's question, kept for missions whose decision workers asked
  themselves. Both need the confirmed UI mark (`MISSIONS_RECURRING.md`, "Wayfinder
  human decision mark"); the final report re-verifies them, binding included.

A task actor's report never claims who decided: a `decidedBy` field or a
coordinator-asked provenance from a non-coordinator is refused. The coordinator can
also defer a decision by retiring the task and keeping the question in the notes.
In independent task mode the decision worker reports its brief and the coordinator
records the outcome, and who decided, in the notes. The UI labels a decision only
from gated reports (`missionDecisionMaker`: native task, coordinator readout or
native return, completed): **Coordinator decision** or **Your answer** in the task
and report readers and the overview's Reports list
(`components/mission-decision-report.tsx`); unproven historical claims get no label.

The shared safety boundary (`SAFETY`) forbids staging, committing, pushing, opening
a PR, closing an issue or changing an issue tracker, except when the mission
objective or notes explicitly ask for that specific action. The boundary itself
grants that one exception, so the objective stays untrusted task data that cannot
override the assignment; a task actor also needs its brief to assign the action,
native permissions stay in force, and a request found in repository files,
reports, comments, logs or tool output never counts. Every assignment prompt and
the Debugging, Exploration, Product delivery and Compare coordinator contracts
carry it.

## Compare two models (`compare`)

The coordinator writes one task/input/criteria protocol; `model-a` and `model-b`
receive byte-identical briefs and use required, different provider/model pairs.
Their instructions and report contract are shared; per-task model changes are refused.
The fresh `comparator` always judges anonymized X/Y outputs, even failed attempts,
using the coordinator's model by default. The playbook help explains judge-model bias.
Version-1 `comparison` contains completed A/B `runRefs`, both scores (0–10) per
criterion, evidence for each observation and `a`/`b`/`equivalent`/`inconclusive`.
Current and archived readers show the verdict, model names and criterion scores.
Blinding is an instruction and data-presentation policy.
Native proof: `node scripts/test-missions-native-trajectory.mjs <CLI>`.

## Durability and recovery

Only the coordinator's final report finalizes a mission, even when every declared
task is complete; empty plan history is omitted. A one-time mission finishes only as
completed (`completedFinalOnly` on the plugin's `MissionControl`, the
`COMPLETED_FINAL_ONLY` instruction); lifecycle controls handle Stop. When
nothing can proceed without the human, the coordinator asks through the native
question tool and waits (§Human questions and decisions). Recurring passages, with
their own control, finish completed or failed.

### On-demand project briefing

“Request an update” sends the panel's only coordinator message
(`lib/mission-coordinator-message.ts`): a fixed application-authored request with the
exact mission ID, a unique request ID and the UI language, through ordinary coordinator
prompt admission (a fresh authoritative full-snapshot read of that mission, its project damage included, exact project/coordinator, view/connection/lifecycle
fences, targeted hydration). It sends that one prompt to the coordinator conversation
with `delivery: "steer"` and the actor's native agent/model preserved; the selected
session, composer draft, plan and lifecycle stay as they are. Never use it to
dispatch, replay or Play. Its instructions forbid new execution while native tools stay
available under native permissions.

The coordinator publishes a bounded `mission.briefing` (summary and at most three
entries each for achieved/ongoing/obstacles/next, with exact live task-key sources).
This coordinator-only journal event records its assessed revision/time and a
server-assigned publication timestamp. Its exact immutable request replay is
idempotent; conflicting IDs, stale revisions, missing/retired sources, damaged
journals, moved roots and non-running/pending-control missions fail closed. The
event only records the narrative: tasks, results, notifications and the final
outcome stay as they are, and nothing is sent.
The reducer independently checks author, lifecycle, source identity and the
assessed journal prefix.

The briefing is attributed to the coordinator, never labelled as an observed
execution fact; closing the reader clears the Summary/node highlights. New current
task results since the assessed snapshot are counted; other map changes produce a
separate stale-map notice. Sources that later retire remain reader targets, never
fresh proof. A stale briefing is
retained; terminal mission summaries take precedence. Each milestone briefing
(`auto:<revision>` with a freshly inspected `basedOnRevision`) advances the
revision, so the ordinary idempotency/conflict/stale-revision contract applies unchanged.
Report and briefing summaries are written for the human (user's language, 3–5
plain sentences, outcome first; IDs, tool/fixture names and commands only in
`evidence`); the final report states delivered/remaining/decision in ≤6 sentences.
Recurring passage coordinators receive the same milestone and summary
instructions through their actor context; the frozen passage start text remains
the verbatim instructions. “Request an update” exists for one-time missions only.

Request admission is shown separately from receiving the matching request-ID
briefing. Pending/uncertain requests survive navigation/remount in per-window memory
until restart; a seen exact response stays recognized when a later briefing replaces
it. Snapshots project `briefingResponses` for the 16 most recent explicit requests
(never `auto:` milestones), so only 16 newer answered explicit requests can evict an
unseen answer. Never replay, retry or poll automatically; an explicit, confirmed
separate request is possible after checking the conversation. When the
`mission.briefing` tool is missing, the fixed prompt forbids a substitute task and
asks the coordinator to explain the missing tool.

To steer a mission or ask the coordinator something, the user opens the coordinator
conversation ("Open conversation" in the selected mission's toolbar) and writes in
the ordinary composer: an ordinary native prompt under native admission, permissions
and the per-send profile environment. Plans and profiles change only through their
own controls. For a recurring schedule, the same action opens the admitted passage's
coordinator.

Reader pages retain exact surrogate-safe source slices. `mission-markdown-pages.ts`
adds bounded display-only continuation fences for standalone fenced code; interrupted
or oversized fence contexts fall back to literal source pages. Copy always uses
the complete original section. List/table/quote excerpts render page by page and
can differ from the full document's rendering.

### Defaults, saved configurations and separate executions

A missing requested profile never authorizes an unrelated replacement; identical
requested profiles are summarized together without a catalog read. A saved configuration
(version 1) holds only its name, objective, notes, template, optional requested
profiles and optional taskMode. Its existing version-1 `name` prefills the new Mission's
title within the Mission title bound; loading keeps the stored record intact.

### User-journey regression checks

`components/mission-scheduling.tsx` supplies directly visible compact scheduling
rows, defaulting to a once-now criterion. Its owner supplies the draft, a frozen prospective Play instant, native
project source choices, capability state and the document's structural lock reason.
Every draft change emits either a valid `MissionLaunchPolicy` or `undefined`;
missing source coverage retains the draft and invalidates its policy. Calendar
previews share `missions/mission-calendar-preview.ts` with native calendar planning.
For persisted Every phases and live next-wake display, read the native schedule rows.
The owning editor retains revision/request fencing and performs authenticated writes.

`mission-editor.tsx` shares its preparation form between Create and Edit. Calendar-owned
documents open through `MissionEditorAction.scheduleID`, read their exact configuration
and retain the loaded document revision in `MissionEditorDraft`. Title, instructions,
notes, playbook, requested agent/model/variant profiles, task mode and
scheduling use the same controls. Followed conversations have editable selector rows with
Add and Remove actions; drafts and retained creation requests keep their exact IDs.
Immediate creation stores those IDs in its initial document and shares first-Play source
reading with converted preparations.
Structural/template guards and their explanations
come from the document; incomplete native observation also fences editing. The
execution-journal format exposes objective/notes edits. A Mission never started is edited
whole in the creation form: saving creates its replacement, in the same coordinator
conversation when the coordinator profile is unchanged, then deletes the Mission it
replaces. A programmed Mission is edited whole in the same form, which saves its programming.
Returning to immediate keeps followed conversations. First Play freezes their bounded
stable prefix with the shared native source reader and launch envelope; unavailable,
moved, excluded or over-capacity sources block with an explanation. The original
first-Play intent retains this text across acknowledgement loss and exact retries.
Stored execution roots outside the editor's single directory-only scope stay read-only.
The form keeps schedules above events (`orderMissionCriteria`, `mission-scheduling-data.ts`): a card that becomes
a schedule joins the schedules, and a card added after an event is an event. The service directory its sources need
is the native Location's, read once an event criterion, an existing coordinator conversation or a followed
conversation needs it. Followed conversations show for a Mission launched once.
Create stores a paused Mission, or a paused programmed Mission when its launch criteria repeat or name an event.
**Start automatically** defaults off, outside Scheduling. When selected, only the direct positive creation
acknowledgement may continue the captured user intention through guarded Play;
receipt recovery leaves Play explicit. The editor supplies discovered project identity
reactively; the continuation freezes project, physical directory, client and native
generation at submission and retains schedule requests under that same control owner.
Scheduled autostart requires a discovered project; an unidentified owner leaves the
created schedule paused for explicit Play.
The saved-configuration picker is the form's
first row. Separators distinguish instructions, Options, Agents and models and
Scheduling. Agents and models uses the shared Settings disclosure with an inline
requested-profile summary and Agent / Model / Thinking columns. Its fold state
survives editor drafts; catalog demand follows its visibility. Options and Scheduling
stay open. Notes begins at one line and grows with its content. Blocking profile
errors remain beside the disclosure; scheduling activation is prepared at Play.
Objective, Title and Notes share the instructions group. The footer names Save
configuration with a text button; the Configuration picker uses the bookmark glyph.
Catalog reads use the panel's existing read indicator and preserve form geometry.
Scheduling starts with its first criterion, with contextual help beside its title;
Add a criterion uses the shared primary button. Public help follows this group order,
with delegation and scheduling explained in their own sections.

H9 editing uses the document projection and the mutator's fresh guards:

| Document state | Editable configuration |
| --- | --- |
| Before first launch, with complete observation and no unresolved intent | Title, objective, notes, profiles, task mode, sources, launch criteria and end; template while no task has ever been created. |
| Between recurring passages, paused or running, with no pending passage/wake/control | Future-passage configuration under the same structural guard. An armed calendar reconciles its replacement before admission; a paused document stays paused. |
| Admitted passage, or an already launched one-time preparation | Objective and notes through the recorded text-edit contract; admitted inputs, profiles, task briefs and identities stay frozen. |
| Uncertain admission/control, incomplete integrity evidence, or terminal document | Read-only until its owning reconciliation/recovery permits editing. |

The template lock survives completed and retired tasks. Structural edits preserve
history, source checkpoints, launched count and first-Play origin. Configuration
and temporal generations advance independently; unchanged timing/end groups retain
their phase and absolute end. Editor reopen restores the loaded draft; conflict
reload and original-receipt reconciliation keep their contracts below.

Editor drafts retain decoded stored-policy metadata and the loaded baseline through
panel remounts; the editor shows no slot preview. An explicit conflict reload adopts the current configuration and keeps one
comparison containing only the preceding user fields. Refreshing observation at the same revision
preserves those editable fields.

Immediate creation retains its original request and physical scope before dispatch.
`GET /api/workspaces/:id/missions/creation/:requestId` reads the backend's original
HTTP outcome. Unknown native transport outcomes use `creationReceipt` under project
exclusion: the immutable creation event and document digest confirm the exact input.
Positive proof releases the original physical hold and selects the Mission; a
coordinator's Supervised block is recovered separately from a fresh, unique
match without altering native rules. A certified terminal refusal restores the
form. Missing or unreadable creation evidence retains
the request with read-only Refresh, silently. Scope conflicts reconcile that retained
request in its original Location. The backend retains at most 128 outcomes; terminal
entries may be evicted, while unresolved entries stay reserved for its lifetime.
Successful requests retain their original outcome and preparation through repeated
POSTs, which direct callers to receipt recovery. Receipt HTTP reads have one
30-second deadline through body consumption. Confirmed renderer results stay held
until a current owning view consumes them; client and native-generation fences
separate concurrent reads and reject late responses from a replaced connection.

`stores/mission-schedule-editor-holds.ts` retains a serialized journal edit
and its exact draft before dispatch. Transport loss and incomplete replies keep
that identity across mountings. While the editor is active, automatic read-only rereads
check the original receipt on mount and periodically until a matching complete original
receipt releases the hold. A journal edit's retained history entry
includes its `requestID`, revision and accepted text. Missing/evicted evidence keeps the hold. Never resend a held edit or
creation automatically, and never use
a negative read as permission for another identity.
Journal editor reloads and retained edit receipts resolve objective/notes through
content reads pinned to the display map's body descriptors. Plan-change reads name
the original revision and compare its accepted text. Missing or changed
content retains the hold.
Editor reads and the body display cache share only the pure wire-slice validator
(`lib/mission-content-slice.ts`); editor receipt checks fetch their own exact,
descriptor-pinned content independently of the display cache.

Source choices use explicit project pages on demand, one reader per event kind listed
in the criteria (`mission-editor-sources.ts`);
conversation choices use native session pages, and local branch choices use the owned
directory's bounded local ref listing (`GET /api/workspaces/:id/git-branches`, at most
200 refs under `refs/heads/`, including branches without a worktree). The read uses
the Git worker, a ten-second/output bound and physical ownership/deletion fences;
over-bound inventories expose source unavailability. Never fetch for source choices.
Each event card owns its searchable, virtualized source popup (`mission-source-select.tsx`);
opening it and approaching its list end requests continuation for that source kind.
Conversation search uses a debounced native candidate query and matches the full query
locally without letter-case distinctions. The native filter folds ASCII; the candidate
keeps the longest substring guaranteed in the original title, excluding Unicode-to-ASCII
lowercase outputs, with an unfiltered bounded page when the query has none. Opaque
continuation cursors retain that candidate. Every search continuation requires the
popup's explicit action, including when earlier matches remain, so sparse matches keep
the same read bound. Browsing without a query uses ordinary end-of-list continuation.
Pointer focus preserves scroll position; keyboard focus scrolls only to reveal its row.
The source selector binds both inputs' active descendant to the focused collection key's
mounted option ID. Each selector owns a reactive registry; options publish their actual
ID after mount, revoke changed keys and remove only their own registration on cleanup.
Closed popups and absent collection or mounted entries expose an undefined descendant.
Selected off-page sources resolve through bounded owned point reads.
Selected labels remain pinned across searches. Failed reads retain the loaded display
and offer Retry inside the popup. Changing a card's type disposes its selector and clears
its source; hiding or locking the editor closes open popups. Source reads follow semantic
owner, native generation and visibility changes; transcript retirement and unrelated
typing preserve the loaded display. A conversation-message criterion supplies its
conversation to native passage context alongside stored `watchedConversationIDs`.

`MissionActionBar` retains its primary glyph for an unchanged action key, preserving
the native pointer target while a fresh action object updates its other fields.

`mission-scheduling-decode.ts` reconstructs criteria rows from a validated stored
policy, including legacy frequency/condition documents. Exact cron equivalence
selects every-N-hours/daily/weekday/monthly shortcuts; other expressions stay
advanced. An unchanged draft returns the stored policy byte-for-byte and each
unedited row keeps its stored criterion, so adding an event or an end preserves
the native temporal generation. Retired legacy options, mixed zones and precision
beyond the controls stay in an explicit retained-policy view, with a deliberate
full-policy replacement action. A branch bound to another directory keeps its
identity visible and blocks submission. Validation errors stay beside their fields.

Run real Solid/HTTP fixtures, never a user's live mission, for these questions:

| Moment | User question | Required evidence |
| --- | --- | --- |
| Before | What will run, and with which requested agents? | Loaded owner preferences, visible requested choices, explicit brief copy and prepared creation |
| During | What has happened, what remains, do I need to answer? | Current recorded results/counts, separately observed native activity, real open Forms/permissions |
| Blocked | Is this my decision, or a work obstacle? | Blockage result is readable without manufacturing a human request or a coordinator task link |
| After | What did I get and can I verify it? | Full bounded result/evidence/next pages, late results marked separately, technical details collapsed by default |
| Reuse | Can I launch it again without changing yesterday's run? | Fresh manual mission creation, copied brief/profile payload, removal preserves executions |
| Failure | Will a retry duplicate work or lose my input? | Exact held create/send identity, no uncertain replay, conditional preference writes and stale-view fencing |

`packages/ui/tests/browser/mission-control.test.ts`, `mission-briefing.test.ts`,
`mission-task-reader.test.ts`, the editor/default/model fixtures, the
`src/components/mission-attention.test.ts` open-request projection and the
progress projection unit tests cover these surfaces. Native `test-missions-native.mjs`
provides a separate isolated execution/storage proof; its deterministic provider
covers the native transport and result lifecycle.

`node scripts/test-missions-native-trajectory.mjs <absolute-isolated-cli>` drives
prepared → Play → two independent declarations → native sibling/grandchild work
→ native returns → coordinator readouts → terminal completion. It requires real
simultaneous native activity and separately verifies that only coordinator readouts
settle Mission tasks. Its private receipt retains checkpoint snapshots and
provider-turn evidence. An optional third argument supplies only a read-only
bare-dependency resolution root for checkouts with missing test packages.

The baseline native fixture also qualifies explicit independent-root assignments.
Managed-root reuse keeps original creation ownership separate from immutable cleanup
provenance; a later assignment cannot recreate the original root or bypass a lost
creation acknowledgement. Native request-conflict and a desktop HTTP uncertain-create
response are deliberately different boundaries, with exact parked request identities.

Mission preference arrays use field-level compare-and-merge against their raw owned
document. Failed/malformed reads never authorize writes; explicit repair compares the
actual invalid field. Conditional writes reread disk synchronously and preserve
unrelated fields. This prevents renderer lost updates; an OS writer between read and
atomic replacement can still race it.
Intervening UI events make save acknowledgement ordering ambiguous: reconcile through
at most three fresh bounded owner reads, never another write. A successfully accepted
but unreconciled save leaves creation fenced until a reload succeeds: Settings issues
one read-only reload by itself and offers an explicit Reload only if that read fails,
while the creation form and the saved-configuration library keep their explicit Reload.
Earlier GETs/ACKs never substitute stale cached defaults as authoritative creation input.
Settings also rereads after failed default writes, clearing the save alert only when
the valid stored defaults match the encoded submitted document. Changed or invalid
values retain the alert. Agent/model catalog failures offer Reload through the same
demand-gated invalidation as configuration and reconnection events.

### Parallel workstreams and context reuse

The coordinator charts every explicitly requested workstream as soon as its work is
clear, including actionable preparation for a blocked deliverable. It launches
independent ready assignments with runtime-supported background/concurrent native
calls before waiting for one result. Unrelated ready work proceeds when one
workstream lacks tooling or consent. Real evidence/permission gates, resource limits
and conflicting shared writes are the reasons to serialize; the coordinator must
name that reason.

`blockedBy` is a business prerequisite. `reuseFromTaskKey` is an explicit native
context/actor choice, independent of `blockedBy`. A fresh native child is preferred
for independent work; eligible reuse requires the exact live native source,
unchanged parent, actual source return and fresh idle observation at admission. It
never permits concurrent work on the same actor. The Debugging playbook's resolver
requires dependency-connected implementer/review evidence, and its
reviewers/validator are fresh distinct actors. Mixed admission cycles are rejected.

Never rewrite or replay existing mission plans automatically; observe real native
concurrency separately from declaration/frontier tests.

Lifecycle RPC methods declare expected mutation failures as `mission.rejected` with a structured `data.code`. Plugin handlers convert only recognized `MissionControlError` failures via the native invocation's `context.error`; the HTTP routes map those codes to 409 (conflict), 404 (missing), or 403 (ownership). Ordinary exceptions remain opaque plugin failures (503). The isolated native fixture exercises stale update/delete, request-ID conflicts and unknown missions through the real HTTP-to-RPC boundary.

The map is an append-only event journal in native plugin storage. Events have deterministic identities, and native prompt/synthetic admissions use deterministic message IDs. Retrying after a plugin or CodeNomad restart therefore resumes an incomplete dispatch without creating a second task, actor, or inbox item.

Report persistence and coordinator notification are separate steps. A saved `task.reported` without a matching `report.notified` acknowledgement is a pending notification. Active plugin instances recover these notifications on activation and retry with bounded backoff through the same authenticated bridge. They reuse the deterministic native message ID, skip acknowledged reports and prepared/paused/terminal/deleted missions or incomplete native control actions, and stop recovery when disposed. When a delivery fails and the session store answers that the coordinator no longer exists, the activation stops offering that coordinator's notifications (in memory; the journal keeps them pending), so a deleted coordinator never costs another bridge claim or native read. This outbox only delivers already-written reports; it never dispatches tasks or chooses a workflow transition. The snapshot exposes `report.notificationStatus` (`pending` or `admitted`), and Mission Control shows pending notification delivery separately from task completion.

Once a report is saved, the report call succeeds even when its notification fails or the admission acknowledgement is lost. Failed journal persistence fails the call and sends nothing. A report from an actor moved out of its exact admitted location is rejected. Reports arriving after terminal Stop are preserved as late evidence without completing withdrawn tasks, reopening the mission or waking its coordinator.

### Targeted recovery

`POST /api/workspaces/:id/missions/:missionID/recover` brokers only the typed `recover` RPC (`missions/recovery-input.ts`, `missions/native-recovery-observation.ts`), with `{ expectedRevision, target: "coordinator" | "report", taskKey? }`. This explicit intervention derives one deterministic native synthetic message identity from the existing mission revision and target; it never replays an assignment. Report recovery requires an existing unresolved admitted task; coordinator recovery references the saved map and reports. Paused, prepared, terminal and pending-control missions reject recovery, except that coordinator recovery resumes a failed mission: under the mutation lock it first appends `mission.reopened` at the exact revision the user saw, `already-member` when one of its sessions has since joined another active mission, as at creation (the reducer resumes only a failure, drops its summary and lets a later Stop end the mission), then nudges the coordinator at the new revision. A later finish uses a revision-bound event identity.

The authenticated owning backend reconciles saved actor locations and checks native activity, bounded descendant inboxes and inventory, uncorrelated running Shells and applicable (including global) Forms and permissions before preparation and again after applying the fresh full profile environment. Recovery never changes the plan. Incomplete/failed reads fail closed; unknown Shell ownership and running descendants block the nudge. The bridge exposes only fixed, redacted recovery error codes. The response `admitted: true` acknowledges admission only. These bounded checks are separate reads, so native state can change between them, and recovery cancels nothing.

### Snapshots, journal locking and map routes

Snapshots are authoritative reconstructions of the journal. RPC events are only invalidations; the UI always reloads its list after reconnect because native event subscriptions are live-only.

**Native journal ranges.** The one-time plugin qualifies the local SQLite range
reader against the database service in the current native invocation. Background
work uses the activation's qualified reader when available. Ordinary reads enumerate
mission keys, then reconstruct each selected map in replay order. The source
holds one transaction per range and reads batches of at most 128 rows and 1 MiB
of event bodies, except that an oversized existing row is read alone. Receipt
and report lookups stay inside the same observation. The activation retains up
to 64 derived maps and folds, weighted by a total of 64 MiB of source bodies.
This is a cache weight, not a heap limit. A disposable SQLite head table stores one stamp
per changed range; triggers publish it in the transaction that changes the
event, including same-size replacements by another connection. The head and
the event rows are read in one SQLite snapshot. Installation uses one immediate
transaction and checks the exact schema. A changed schema cookie requalifies the
definitions and renews the incarnation before reuse. An unavailable index uses
the exact byte-hash fallback; a failed installation can retry on later demand,
at most once per read. Stamps are scoped to the range and index incarnation.

An unchanged head transfers no event bodies. A single strictly ordered task
declaration or briefing advances the fold from its own event if it cannot
occupy a prior receipt slot. Other changes, eviction and restart replay in
bounded batches; total cold bytes and scalar headers grow with history. Selected
declaration and briefing still inspect every range for project damage and
timestamps, and verify document bindings, but copy only the selected map. An
evicted range needs replay even during warm project operations.
The first reconstruction reads source bodies and retains live text in the fold.
An explicit panel header read may persist a display-only record of at most
48 KiB in the head table, including descriptors and original event identities
for objective and notes. A qualified reopen reads that header without loading
event bodies. Reading either recorded input point-reads its event in the same
SQLite snapshot and verifies the body descriptor. Document bindings stay live
reads. Misses, changed stamps and invalid records reconstruct from the journal;
an event write updates its head and does not regenerate display projections.
The first task window and the header's exact pinned selection each retain one
compact record of at most 96 KiB. The records include only display rows,
descriptors and event keys for their task briefs and unambiguous reports.
Requests for those bodies verify their descriptors against the original event.
The directory, later windows and bodies outside those selections retain the
normal projection path. Compact panel and body reads copy only their projected result.
While the fold is cached, an old
objective pair is read by its two event keys, fenced by the range stamp.
Other explicit old plan changes and cleanup/purge authority can materialize
historical events. The head table and
triggers are derived; the event format and keys stay unchanged. A range-capable
build can read those same events on rollback; scanner-only builds retain their
entry limit. On an offline copy, remove the three
`codenomad_mission_head_v1_*` triggers and then the `codenomad_mission_head_v1`
table in one transaction to remove the optimization while retaining `kv`.

Briefing replay checks the exact ordered event position and preceding timestamp during
reduction. Prefix run state is derived from creation and control events; the returned
map still projects control receipts at their actual journal positions. Run
`node --import tsx --expose-gc scripts/benchmark-mission-journal.mts --quick` from the
repository root to measure synthetic journals only, with fresh processes and a warm read
in each process. `--long` measures one 10,020-entry journal; `--bench` also includes
large bodies. `npm run test:long-mission-journal` runs standalone write preflight, then cold
open → declare → briefing → restart and exact replay → declare → Stop → deletion
on the same synthetic database. Output includes counts and bytes by event type and read,
latency and memory samples by operation. The warm read uses the same fixture copy as the
measured operation; both modes use the system's current filesystem cache.
`--read-budget` compares 128 and 10,148 events with the same live work and
different superseded objectives. It asserts the warm historical byte budget,
then verifies that a declaration whose write acknowledgement was lost is
reconciled after reopening the database without issuing another write.
`--compare 1` compares both builds on byte-identical synthetic databases and
checks cold and warm resume from the same paused copy.
`--panel-io` measures the registered HTTP header and body reads on a synthetic
SQLite copy and verifies reopen, damage handling and index removal.
`node scripts/test-mission-journal-head-native.mjs <absolute-isolated-opencode-cli>`
qualifies the index on the daemon's transaction and storage adapters using
synthetic rows in a private database.

**Panel reads** (`missions/mission-summary.ts`, `MissionControl.list`/`mission`, `server/routes/missions.ts`). The panel never loads every full map. The read-mostly `list({ include?, summariesVersion? })` RPC takes the open missions (`openIDs()`) plus at most four `include` IDs, re-reads each range with `missionView`, and returns their compact maps (§Compact maps) stamped with the project damage flags, one `MissionSummary` row per live map in snapshot order (id, title, objective label of 502 code points with whitespace runs collapsed and a newline kept, enough for the row title, status, runState, coordinator and actor session IDs, updatedAt, a finished map's `finishSequence`, revision, its plan's task count (a compact map's from its task page); rows of re-read ranges come from their fresh maps, and an included map the hints missed gets its row), the hints' cleanup history and discarded count, and `summariesVersion`, a content hash of the rows; `summaries` is omitted when the caller sent that version. The `mission({ missionID })` RPC returns one range's compact map (absent when it holds no live map), that range's own cleanups and the project flags. Both are hints-based reads (§Journal index): rows and cleanup history can miss a foreign write until the rebuild, while included and open maps are read from storage on every call; neither authorizes anything, and every write keeps its authoritative read in the plugin. `GET /api/workspaces/:id/missions?include=<id,…>&summaries=<version>` brokers `list` and projects activity over the returned maps only; `GET /api/workspaces/:id/missions/:missionID` brokers `mission` for display reconciliation (the editor's lost-acknowledgement checks, cleanup retries). `GET /api/workspaces/:id/missions/:missionID/admission` answers the same shape from the full `snapshot` RPC, its map full: the admission read of an application-authored native prompt (the coordinator message), which hints must never authorize. The list and single routes compact the maps they return too (`compactMissionReads`, `compactMissionMap`), since a reload can briefly pair this backend with an older plugin that returns full maps, with or without descriptors (§Compact maps); the admission route never does. A plugin build without `list` (`rpc.method_not_found`) answers `plugin-unavailable`: its only other read, the snapshot, carries every full map, which the panel never loads. A plugin without `mission` answers the single read from its snapshot, that one map compacted; any other RPC failure stays a failure. Bridge routes (assignment, report, lifecycle, prepare, root creation, task conversations) keep the full `snapshot`: they authorize native effects. The UI store (`stores/mission-store.ts`) keeps the project's rows (`summaries`) and the compact maps (`missions`) of the wanted Missions. Consumers register the maps they need with `want(instanceId, owner, missionID)`: the selected Mission (MissionControl) and the central reader. The store reads only the rows; the panel inventory (`stores/mission-panel-inventory.ts`) reads each wanted map's header and hands it over with `adoptPanelMaps`. `want` runs untracked, and components register through a memo of the target ID only, so store publications never re-run a registration; a failed read stays parked until new demand, an invalidation or an explicit refresh. Publication keeps the generation fence and trailing coalescing, and a reader's want needs no panel demand. Picker rows, marks, completion seeding, empty states and the reader's absence check use the rows; the selected detail, the task tree, its questions and the readers use the compact maps, and a selected row waits for its map with a loading line. A parked failed read leaves the refresh button available. Native queue requests count for a Mission's declared and observed actors, their observed family and its proven native task conversations (`nativeMissionQuestions`: exact task-session evidence survives unknown family coverage; unknown descendants and global requests never count). A closed row's questions are its declared actors' open native requests; observed-family members count only for open and wanted missions. The row's flag turns red only for the questions it carries (`components/mission-question-owners.ts`, pure; `components/mission-questions.ts` reads the queues and the known task conversations): the coordinator's own, one of the coordinator's family no known task conversation carries, and, once its map is read, one no loaded live task row carries; the rest are its tasks', carried by its chevron (`data-child-activity`, the session list's rule: once the map is read, the task rows' own states through `missionTaskRowState`, input before active before an unseen finished task; before, `working` while a task actor works). Observed activity states, the coordinator's included, cover whole families and never redden the flag: only a question it can open does. Questions and session membership read only current observation pages (`currentMissionObservations`): a Mission's own current activity windows, else its current marks-lane window (a closed row's, `markObservations`); superseded or failed windows read as `unknown` and never count, for the red, the schedule's request count or navigation.

**Body reads** (`missions/mission-content.ts`, `MissionControl.content`). The read-mostly `content({ missionID, kind, field, taskKey | reportId | change, digest?, offset })` RPC returns one mission body for display in slices, from one `missionView` read of that mission's range alone (never the index or another range). Its selector names a value in the live map: a map field (`kind: "mission"`), a task's own field or its `reports` (`task`, `taskKey`), any report by ID, current, earlier or late, never the task's current one in its place (`report`, `reportId`), or a plan change's field by revision (`change`), among every change the same observation's events record (`missionPlanChanges`, the reducer's own changes, of which the map's `history` keeps the last 50), never the nearest or a newer one. The answer carries the map's `revision` and a slice: the string itself or the value's JSON (`json`), `characters`, `digest` (the inspect digest: SHA-256 of the UTF-16 code units) and `next`, the following slice's offset; each answer, as two-space JSON, stays within the inspect bound of 100,000 characters (`sliceEnd`). A first read starts at offset 0 without a digest; every later slice repeats it and is refused (`content-changed`) once the value reads differently, while revisions that leave the value alone keep its slices valid. `mission-not-found` and `content-not-found` answer the rest; a later slice without its digest or a selector naming another kind's identity is invalid input. `GET /api/workspaces/:id/missions/:missionID/content?kind&field&taskKey|reportId|change&digest&offset` brokers it with the list's ownership, plugin and project checks; a plugin without the method answers `plugin-unavailable`, never another read in its place. It is a display read: never a write's or admission's authority. Its wire types live in `missions/mission-content-wire.ts`, which the UI imports.

**Body display** (UI `stores/mission-content-store.ts`, `stores/mission-content.ts`, `lib/mission-body-pages.ts`, `components/mission-reader-body.tsx`, `components/mission-report-prose.tsx`). One-time and current scheduled readers resolve exact body descriptors: overview summary/objective/notes/briefing, task briefs and results, reports, plan changes, Compare/decision artifacts, edit inputs and Save configuration. The display cache keys workspace, project, mission and selector, plus the exact source for a current passage. Instance connection, folder and native generation fence every publication.

Shown text reads only through the displayed page's end and final line (`missionBodyNeed` / `missionMarkdownPage`), or whole for Copy. Lists, artifacts, briefings and plan-change pairs read whole within their logical assembly budget. Ordinary task histories can read their aggregate report body; current passage history explicitly pages compact report rows. Current passage results always read immutable report IDs. Ordinary current/late task results retain their task-owned `report` / `lateReports` selectors; other reports use IDs. One body's readers share one active read, serving new demand on settlement.

`missionBodySource` carries the map's descriptor and expected revision, or the later owning row's revision (`missionBodyRevision`). Descriptors provide presence (`missionBodyPresent`, `missionReportHas`); excerpts and `decidedBy` provide labels. A briefing's summary stays reading until its whole value settles. Rows without history descriptors use `missionHistoryMark` (report count/newest report) as a version fence. Unchanged descriptors retain their bodies through unrelated revisions. Current passage reads pin known digests on the first request and reject a differing newer digest before cache adoption. Structured current bodies enforce depth/token budgets before final concatenation and parsing.

`plugin.updated`, reconnect and a new event stream invalidate shown bodies and fence earlier answers. Last-good text stays until a newer value covers the shown page. `content-changed` restarts at offset zero within four retries; failures park with explicit Retry until demand or invalidation. Copy retries its required failed read and stops on a new failure. Released/switched readers abort their transfers and reject late publications. Idle bodies are retained LRU within 4 MiB UTF-16 and 128 bodies; workspace stop clears them. Closed disclosures read nothing. Transfers share the secondary background budget, original deadlines and cancellation ownership.

Recorded-input intents (`mission-target-bodies.ts`) accept only the captured snapshot's digest or its recorded absence. The edit form stays read-only at its original CAS revision until objective/notes match; a changed field offers Reopen on the newest map, preserving typed drafts. Save configuration restarts changed inputs from the newest map at most three times; unrelated revisions preserve its inputs, and further changes require Retry. Admission, mutation, lost-acknowledgement checks, Stop, Delete and recovery retain their authoritative full/single-mission reads. Missing content capability produces the normal parked `plugin-unavailable` failure with Retry.

**Compact maps** (`missions/mission-compact-map.ts`; panel types in `mission-panel-map.ts`; descriptors in `mission-body-descriptors.ts` / `mission-content-wire.ts`). Display reads use `compactMissionMap` and `projectMissionPanel`. `MISSION_BODY_FIELDS` become `{ characters, digest }` descriptors in `bodies`: map objective/notes/summary/briefing; task brief/execution mode/results; report summary/next/evidence/artifact; and plan-change reason/objective/notes/task lists. `missionBodyDescriptor(map, selector)` resolves them using `contentText` and the UTF-16 `contentDigest`.

Display labels use bounded excerpts: objectives at 502 code points, report summaries at 240; briefings retain their identity/revision/timestamps, reports retain `decidedBy`, and independent modes retain kind/reason plus an explanation excerpt. Other metadata follows the task/collection bounds in §Task pages, including late reports, invocation observations, frontier and claims. Maps lacking descriptors are described before display; unpaged compact maps are paged before use. Compact wire schemas refuse body fields. Snapshot, admission, mutation, `mission.inspect` and internal `MissionControl` reads keep complete bodies; model-facing authority stays on those full reads. Each displayed body's serialization/hash is computed once per projection.

**Task pages** (`missions/mission-compact-map.ts`, `missions/mission-task-order.ts`, `MissionControl.tasks`; constants and types in `missions/mission-panel-map.ts`). A compact map holds a page of its tasks, whatever the plan's size. Its `tasks` are its window, the first `MISSION_TASK_PAGE` (50) of the display order, and up to `MISSION_TASK_PINS` (20) pinned rows of what the panel must show of any task, in this priority: the tasks needing action (with a pending notification, blockages and failures newest first, then reports to recover: `missingReport`), the 8 newest reports' tasks and the briefing's source tasks, all in display order. The display order (`missionTaskOrder`, the tree's `orderMissionTasks`) takes rounds of the tasks whose dependencies among the map's tasks are taken, each round in map order, then the tasks a cycle holds back in map order; it is linear in tasks and dependencies. Each row adds `order` (its position in the whole order), `dependents` (tasks depending on it in the whole map), `reportCount` (its reports in the map) and, beside its own descriptors, `bodies.reports`: the descriptor of its whole history, the content field `reports` exactly as `missionContentValue` answers it (computed from reports without descriptors, and only from a map holding them whole), so a reader of that history reads it again once a report arrives; it keeps its newest late report (`MISSION_LATE_REPORT_ROWS`, beside `lateReportCount`) and its invocation without `observations`, both of which the content route reads whole (`lateReports`, `nativeExecution`). The map's `reports` are its rows' own, at most `MISSION_TASK_REPORT_ROWS` (3) a row (the current one, then the newest pending notifications, the newest late one and the newest), plus the 8 newest whose task the map does not have (`MISSION_PINNED_REPORTS`); a task's every report is its content field `reports`. `taskPage` describes the page: `order` (the digest of the order's keys), the window `[offset, end)`, `total`, `counts` by status, the map's report count `reports`, `pinsOmitted` and `attention` (`MissionTaskAttention`): the whole map's tasks needing action counted by kind (`notifications`, `blocked`, `failed`, `recovery`; a task can be of several), how many of them the map holds neither in its window nor among its pins (`omitted`), `sequence` (the digest of their keys in pin priority, which changes whenever that list does, even in the same display order) and, in a map, the keys of the first 50 of those. `actorEvidence` names the actors whose report or native call the map's tasks (all of them) say is owed; the activity projection reads it instead of the tasks a page holds. The read-mostly `tasks({ missionID, order?, offset? | attention? | keys?, ids?, reportIds? })` RPC (`missionTaskRequestSchema`: one of a window, an attention window or names, at most 50 names in all, so a named read answers every task it names) answers from one `missionView` read of that range: the window of 50 at `offset`, the window of 50 of the omitted tasks needing action at `attention` (in pin priority, its `taskPage.attention` naming that window's `offset` and `end`), or the named tasks, each in display order, as rows with their reports and the named reports, with `taskPage` and the map's `revision`; it refuses `order-changed` once `order` no longer names the display order (a plan change) and answers `mission-not-found`. Following each page's `end` from offset 0 to `total` reaches every task once, in display order. `GET /api/workspaces/:id/missions/:missionID/tasks?order&offset&attention&keys&ids&reports` (comma lists) brokers it with the list's ownership, plugin and project checks; a plugin without `tasks` (`rpc.method_not_found`) is answered from its single-mission read, paged by the route (`missionTaskPage`). It is a display read: never a write's or admission's authority.

**Budget per response** (UTF-8 bytes of the JSON; `mission-task-pages.test.ts` builds rows of maximal width and checks every bound): a task row stays within 32 KiB (scalars, a 240-character title and role, its execution profile, at most 24 dependency keys of 64, native identifiers of 240, descriptors and its report rows), a report row within 8 KiB (identity, native call, an excerpt of 241 code points, descriptors), a plan change within 4 KiB (descriptors and a reason excerpt). A page holds at most 50 rows, their 150 report rows and 50 named ones: 50 × (32 KiB + 4 × 8 KiB) = 3,200 KiB. A map holds at most 70 rows with their 210 report rows, 8 taskless reports, 50 plan changes and a header within 40 KiB: 70 × (32 KiB + 3 × 8 KiB) + 8 × 8 KiB + 50 × 4 KiB + 40 KiB = 4,224 KiB, besides its actor-scale lists. A mission of 2,400 tasks with 20,000-character briefs and a plan change rewiring 1,224 tasks takes 49.4 MB as a full map, 54 KB listed and pages of at most 43 KB; a row of 1,997 observations or of 100 late reports of 20,000 characters stays under 5 KB. The read bounds no actor-scale list: a list response carries the compact map of every open mission and of up to four included ones, one row per live mission and up to 2,000 cleanups, and `actors`, `control` receipts, `actorEvidence`, the activity projection's actors and observed families and the rows' `actorSessionIds` grow with a mission's actors.

**Reading further** (UI `stores/mission-task-pages.ts`, `stores/mission-store.ts` `loadTasks`, `components/mission-task-tree.tsx`, `components/mission-graph.tsx`, `components/mission-task-open.ts`). The store keeps, per instance and listed paged map, the list read's own map (its base) and a page cache: the display order, rows and reports by ID each with the revision of the page that answered it, every read made (window and attention offsets, keys, IDs, report IDs) with the revision of its last answer, the reads parked by a failure, the failed reads no read has answered since, and the attention windows answered for the newest attention sequence (`taskAttention[missionId]`: windows answered under another sequence cover nothing of this one, whatever the order). A page vouches only for what it answered, and a row or report it answered carries its revision to the bodies it describes (`missionBodyRevision`, §Body display). `missionStore.loadTasks(instanceId, missionId, request)` reads one page in the order the shown map names and resolves to how it ended (`read`, `failed`, `reordered`, `skipped`); a mission's reads run in turn, an identical read still waiting is that read and a running one is followed by one more, each read is recorded before it is sent, reads share the secondary background budget, and `clear` fences reads in flight. An answer in the shown order merges into the base (`mergeTaskPages`: rows in display order; a row or report the base holds stays unless a page answered it at a later revision, one it does not hold shows as last read); a refusal or an answer in another order reads the list again. Each list publication takes its maps as bases, shows them with the cached rows of the same order, drops the bases and caches of maps it no longer lists and reads again each read last answered before the map's revision, except one parked by a failure at that revision or later; another order drops the rows and reads every recorded read from scratch. `taskReads[missionId]` says whether a read runs (`loading`) and holds the oldest failed read (`failure`, with its request) until a read answers every name or window of it; other reads succeeding keep it. The rows shown stay and the tree offers Try again.

The tree's header counts every task (`taskPage.total`). Rows and pins form one continuous virtualized list in display order. A single end sentinel (`li.mission-tree-more`) observes the active scroller, loading the earliest unread position as it approaches view through pointer or keyboard scrolling. The selected row's tree, with its task-session demand, mounts only while its chevron is open; its toolbar keeps the selection's map. Collapsed trees and failed reads suspend automatic continuation; failures expose explicit Retry. The header's info tooltip states the supplied whole-mission attention counts by kind; ordinary windows reach every attention task and recovery action. Keep these counts scoped to the whole mission: window coverage alone cannot establish which attention members remain unread. A row's title and assistive text name its unread dependencies and dependents. The graph uses cached virtual offsets for offscreen rows and measures mounted anchors, with a dashed stub (`path.mission-graph-omitted[data-omitted]`) for unread endpoints. Reader links load their target task by key (`openMissionTask`), and restored task/report targets load by ID once per display order. Readers show Loading, a failure with Try again, or confirmed absence according to the actual read outcome. Show all reads a task's whole report history and stays open across refreshes, rereading when its descriptor changes. Questions come from actors and the observed family.

`MissionPanelPaging` keeps coverage/search explanations in info tooltips and stable continuation labels. A lane that has shown a continuation retains its info slot across refresh cycles. Loading alone never mounts a body block. `missionStore.reading` includes inventory lanes, selected headers and task reads. The top-right refresh icon spins, and is disabled, only during the panel's first journal read and an explicit refresh; passive revalidation shows no indicator. `mission-panel-inventory.test.ts` holds real event-triggered reads and checks geometry, labels, DOM identity and screenshots before, during and after refresh.

Project mutation and journal-append exclusion is shared by all bundle incarnations in the native host. An in-flight mutation keeps its lock across registration disposal: a content-addressed replacement waits before reading its CAS revision. `missions-reload.test.ts` loads two independent compiled bundles and races updates across dispose/setup to verify that only one can succeed.

Mission Control manages map metadata through the authenticated CodeNomad routes `POST /api/workspaces/:id/missions`, `PATCH /api/workspaces/:id/missions/:missionID`, and `DELETE /api/workspaces/:id/missions/:missionID`. These broker only the typed `create`, `update`, and `delete` methods of `codenomad.missions`. Create uses a stable request ID, may attach an owned root session or create a new root without prompting, and accepts an optional `title` (trimmed, single line, 1–60 characters, `missions/mission-title.ts`). The title is part of the exact creation request and `mission.created` event, is exposed as `MissionMap.title`, and names new coordinators `Mission · <title>` (otherwise a title derived from the objective's first sentence). Missions without a stored title stay untitled; the UI derives a label. Roots that Missions creates (new coordinators, recurring passage coordinators and independent task roots) take OpenCode's descending session identifier (`missions/session-identity.ts`): `ses_`, 12 lowercase hex encoding the real creation time, then 14 hex derived from the mission or task identity. OpenCode Zen's free models refuse a session whose identifier lacks a recent OpenCode creation time, and native children send their root's ID as session affinity, so one foreign-format root blocks its whole mission family on free models. Ownership checks (managed-root creation and cleanup, recurring passages, creation readback) match the derived suffix and also accept the `ses_` + 26-hex derivation held by existing journals. Reading time-prefixed roots requires a build that knows this format: an older build rejects a recurrence document whose passage holds one (the project's recurrence list then becomes unavailable on that build) and leaves such independent task roots out of managed cleanup and managed-root retries. Keep a compatible build available for rollback recovery and never rewrite stored session IDs. Update uses revision compare-and-swap for objective/notes. Delete appends a tombstone: the map disappears from snapshots and membership. By default every conversation is preserved. Late reports for a tombstoned mission cannot recreate its map. Settled tombstones are purged (below).

Deletion optionally accepts `deleteManagedSessions: true`. The panel's trash button deletes at once, without a form or confirmation prose, taking that option from the `missionDeleteSessions` UI preference (Settings › Missions, a lone checkbox) fixed for its one request; the editor's delete form appears only when the deletion failed or is unconfirmed, with its error and Retry. Immutable targets are recorded in the tombstone, and per-session receipts reserve journal capacity before removal. Only deterministically created specialist roots with matching native creation metadata and exact project/location identity qualify. Coordinators, reused sessions, actors referenced by another mission (including finished/deleted maps), and roots with children are retained. Native removal is recursive, so descendants are outside this opt-in. The plugin delegates removal to the authenticated desktop bridge, because native plugin contexts lack `session.list/remove`. The bridge obtains authoritative intent through the narrow read-only `cleanupTarget` RPC, revalidates ownership/connection/worktree fences and calls the native HTTP client. It never modifies OpenCode storage directly. An incomplete cleanup returns `503 cleanup-pending` after the tombstone is committed; replay the exact original request ID, revision and option. The editor retains that request through live snapshot refreshes and locks the option after the first attempt. Only an explicit retry resumes cleanup.

`MissionCleanup.pending` counts native session targets; optional `documentPending`
independently records unconfirmed unified-document compaction. A unified deletion
persists `mission.deleted.documentCleanup: true` and reserves one additional exact
receipt in that mission's deletion capacity. Successful compaction followed by its
verified readback permits `mission.document-cleaned`, bound to the original deletion
identity. Until that receipt is durable, `documentPending: true` retains the exact
retry even when the map is absent and the native pending count is zero. Failed
reads and lost compaction acknowledgements preserve that state; passive reads only
project journal evidence. A confirmed receipt projects false, and journal-only
deletions keep the optional field absent.
Passive list loading preserves an explicit cleanup retry's view lifetime in both
the panel and the overview reader. Its fresh exact receipt read and native revision
guard still decide whether the original deletion can continue.

Deletion conflicts distinguish stale revisions, different requests and pending controls.
The editor and cleanup panel reread the exact original intent after a 409 before
offering another explicit retry. Every retry preflights that identity and retains its
revision and option. A stale live Mission requires cancelling and selecting it again
before deletion; never adopt a newer revision for an existing destructive intent.

**Purging deleted missions** (`missions/journal-purge.ts`). Once every cleanup target of a tombstone and its required document compaction have exact receipts, the journal removes that mission's events through the optional `MissionStorage.remove` (native `storage.remove`); storage without it keeps every entry. Deletion keeps the 20 newest settled deletions (`SETTLED_CLEANUP_HISTORY`: the cleanup history and the editor's lost-acknowledgement check read them) and purges older ones. Native-pending and document-pending deletions precede that settled history and retain their journal ranges and activation-index work hints. When an attempted deletion finds neither its map nor its cleanup, the editor's explicit retry resubmits the original request, revision and option, and the record below answers it; passive refreshes only read. Purging is retention only: capacity is per mission (§Safety limits), so a full mission makes room through its own deletion reserve and other missions never wait on a purge. A deleted mission stays while it references, as coordinator or task actor, a session another unsettled mission could still clean up (a deterministic task root of a non-deleted mission, or a pending tombstone target): that reference is the shared-membership evidence cleanup retains such sessions on. Damaged journals (discarded entries, invalid cleanup, control or notification history) are never purged.

Before the first removal the purge writes a deletion record at `codenomad-missions/v2/deleted/<projectToken>/<missionID>`, beside the scanned journal prefix: it costs no journal capacity, is only point-read (by every storage adapter, with or without removal support; the isolated recurrence-passage adapter, which never purges, has none) and is never removed. It holds the deletion request ID, revision and option plus the settled cleanup summary (240-character objective label, counts, reasons). The record refuses the mission's deterministic recreation (create, prepared hand-offs and inspect-start replays answer `mission-deleted` before any native effect) and answers an exact deletion replay with the original summary; another request ID answers `mission-not-found`, a changed revision or option `request-conflict`. Removal starts with `mission.created`, then tombstones, then intents before receipts. A group without its creation event whose mission has a valid record leaves the observation, so every intermediate state reads without discarded events, reopened cleanup or reservations; late writes to a purged mission are absorbed the same way and removed by the next purge, which also resumes an interrupted one. Without a readable record such a group stays damage evidence. Per-mission reads (`missionEvents()`/`missionView()`) scan only that mission's key range `<prefix>/<missionID>/` (the isolated recurrence-passage adapter accepts its own mission's range besides the whole virtual prefix) with the same parsing, read bound and record handling; their discarded count and damage flags are that range's own, and the snapshot's project values aggregate them plus entries outside every mission range. A paginated observation (`events()`/`snapshot()` or a per-mission read) takes the same `append:<projectToken>` exclusion as appends and purges, so it never assembles pages from both sides of a removal; code already holding it uses the private unlocked observer, and storage adapters never read the journal. Builds without purge support read a journal mid-purge as damaged and never consult deletion records.

An ordinary journal's finish carries the project's finish number (`mission.finished.sequence`, the map's and summary's `finishSequence`). `MissionJournal.appendFinish` draws it from the counter at `codenomad-missions/v2/finishes/<projectToken>`, beside the deletion records and outside every mission range (no journal capacity), under the `append:<projectToken>` exclusion after the capacity check, writing the counter before the event: a refused or failed write leaves at most a gap, an exact replay returns the stored finish with its number, and a damaged counter refuses the finish. The counter is never removed, so a later finish always has a larger number whatever deletions, purges, reloads, new controls and clocks did; the seen-completion watermark relies on that order. Calendar passages use isolated storage (`isolatedMissionPassageJournal`), whose finishes stay unnumbered. Immediate journal-owned Missions use the ordinary project's counter.

**Journal index** (`missions/journal-index.ts`). Each `codenomad.missions` activation (`opencode/missions/desktop-plugin.ts`) owns one never-persisted `MissionJournalIndex`, shared by its ordinary journals (MissionControl through `setupMissionsPlugin`, presence retention) and disposed with it; never make it module-global, since a reloaded revision may reuse the module. `MissionJournal.readHints(read)` builds it on first use with one key-ordered streaming scan (same read bound as `observe()`), then runs `read` synchronously under the append exclusion on hints: `refs(sessionID)` (missions whose events name the session as coordinator, `preparedBy` author, dispatching or native-bound actor; live maps in snapshot order, ties by the first event then binary key order, then the rest in key order), `openIDs()` (per-range `missionWorkRemains`), `aggregate()` (the snapshot's discarded count, damage flags including entries outside every range, and latest live `updatedAt`), `cleanups()` (the snapshot's displayed cleanup history: pending, then the 20 newest settled) and `summaries()` (one panel row per live map, in snapshot order). The callback only extracts values: its type refuses a Promise or thenable result and a thenable is rejected at runtime before the exclusion could adopt it; range reads (`missionView`) happen after `readHints` resolves. Entries keep scalar ordering tokens and bounded labels, never events. Every ordinary journal write attempt (append, record write, purge removal), before it starts and whether it then fails, lands or goes unconfirmed, bumps a per-project write generation shared by all incarnations in the process and marks its mission dirty, so the next read re-reads that range; a range whose deletion record was unreadable stays dirty. A generation the index did not produce itself (another current-build activation, an unindexed journal) or any read failure makes it rebuild. Writers outside that generation stay unseen until the next rebuild: an older build activated in another native Location of the same project (native activation is per Location, its plugin storage per plugin ID, and native KV has no change counter), a failed-reload fallback, another process, bytes written without `MissionJournal`. A full rebuild at least every 60 seconds (`MISSION_INDEX_STALE_AFTER_MS`) heals such misses. The answers are therefore hints: anything that authorizes a write or native effect (cleanup authority and shared-session checks, membership admission or refusal, deletion, purge planning, recreation checks, damage gates before a write) keeps its authoritative full read; only read-mostly paths (the per-turn context hook, panel lists and summaries, outbox enumeration, and presence retention when the hints show open work; an empty answer is confirmed by a full read before presence is released) may use the hints. `MissionControl.hintedMissions` is that read: it takes candidate IDs from the hints, re-reads each range with `missionView`, keeps snapshot order (stable by `updatedAt`, ties in hint order) and stamps the hints' project damage flags on each map as a snapshot does; isolated passage journals use their snapshot instead. Its callers: the context hook (`contextFor`, one membership read per model turn returning the instruction and whether the session coordinates the mission; a conversation no mission names reads no range), `mission.inspect` without `start` (by `missionID` reads exactly that range), `inspect({ list })`, the task observation and decision-candidate reads behind `inspect({ taskKey })`, the notification outbox's enumeration over `openIDs()` (every running mission is open), and the panel's `list` and `mission` reads (§Snapshots, journal locking and map routes). Each notification then re-reads the whole journal before its native admission and before its receipt, and both the native message ID and the receipt ID are deterministic, so a mission the hints miss is only delayed until the rebuild and a stale candidate is skipped once the full read shows it admitted. The context of a mission written by such an unseen writer is withheld until the rebuild; its tools stay offered and every one re-selects authoritatively. `retainMissionWork` retains on `hintsShowWork` (an open mission or project damage) and otherwise decides on the full snapshot. Creation and `inspect({ start })`, declaration, delegation, revision, briefing, report, update, lifecycle, recovery, prepare, task interruption, deletion and cleanup keep their full reads; the change events after lifecycle and deletion carry the revision those operations already read. `journal-read-budget.test.ts` pins both sides over a finished history of 10,000 entries in 200 missions: the hinted paths make no full scan and read at most their own ranges (`GET /missions` through the plugin reads only the open and included ranges and observes only their actors), while membership refusals and damage gates see entries the hints have not. Isolated recurrence-passage storage (`MissionStorage.isolated`) writes its own physical namespace, never counts and has no index (`native-passage-business.test.ts` traps ordinary journal writes from passages).

### Opt-in bounded panel transport

Directory task attention uses `task-marks` with one Mission ID and a 50-row window.
The journal hint index retains only task IDs, keys, states, update versions, actor
IDs and replacement keys for this projection. These windows share the 64-KiB wire
transport and a 256-Ki-unit assembly bound, without native observation or map/body
reads. Marks come in attention order (`missionTaskMarks`): the live tasks in plan
order, then the others from the newest change to the oldest. The visible directory
reads them independently of selection and expansion, and only while they can change
the row: for an active or failed Mission, or one changed after this window's seen
watermark. It reads no window past one ending on a finished task already seen
(`missionTaskMarksCover`), nor past a loaded finished task still unseen; the windows
left unread hold finished tasks alone. Failed windows keep explicit Retry. Keep these facts separate from volatile actor
marks so slicing task metadata cannot repeat native family observations.
Completion acknowledgement uses the exact task version and the existing per-window
seen store. `taskMarksThrough` carries the indexed Mission's `updatedAt` as the
snapshot ceiling for hierarchy-wide acknowledgement, including unloaded windows.
Consumers check every task timestamp against this ceiling and retain it unchanged
through byte slices. Canonical child-session discovery reuses the task-session reader for
unbound live tasks with observed coordinator descendants. Cached assignment candidates
become visible only when their declared task keys arrive; titles and generic
coordinator activity never establish a task link.

An observation refresh arriving during marks or actor IO schedules one scoped
trailing read. Pending continuations count as loading until that refresh settles;
failures preserve the display and wait for explicit Retry. Last-owner release,
connection replacement and generation changes fence queued observation reads.

`MissionControl.panelPage`, the `panelPage` RPC and `POST /api/workspaces/:id/missions/panel-page`
provide the live one-time panel's byte-bounded display transport. The `list`, `mission`
and `tasks` contracts also serve explicit compatibility/reconciliation callers. The
transport covers persisted directory, selected header/field data and live actor
observations (§Paged live activity). Its schema,
types, byte counter and paginator live in `missions/mission-panel-page.ts`.

- Every successful body, including `available`, the envelope, escaped nested text and the
  continuation, fits **65,536 UTF-8 bytes of compact JSON** (`MISSION_PANEL_PAGE_BYTES`).
  Each transfer holds at most 50 pieces. Input bodies fit **16,384 bytes**; the route's
  body limit and the plugin's parsed-selector check enforce that separately. Invalid,
  changed, missing-source, damaged-range and invalid-cursor answers contain only a fixed
  reason. The native output schema uses complete strict success/refusal alternatives:
  literal `available`, required version/project/source/page on success, required reason
  on refusal. `isMissionPanelPageResult` validates that same schema at the HTTP seam,
  rejecting extra properties; the route also checks the byte count, project, source and mission/field identity;
  transport failures use the route's fixed unavailable shape. HTTP headers are outside
  the JSON-body budget.
- Requests name one source: `summaries`, `cleanups`, `mission` with `missionID` and optional
  own root `field`, or `tasks` with `task` (the existing `missionTaskRequestSchema` selector,
  including its mission ID). Directory sources use only `readHints`, preserving its
  60-second foreign-write contract. Warm directory traversal reads zero mission ranges,
  including when every mission is open. A mission or task request reads exactly its named
  range. Each successful range envelope carries its observation's `discardedEvents`,
  `controlUnavailable`, `notificationUnavailable` and `cleanupUnavailable`, independently
  of the field or task selected. These are range-local facts; directory envelopes carry
  the hints' project aggregate separately. An absent map in a damaged observation refuses
  `damaged`; a clean absent observation refuses `mission-not-found`.
  No source uses the snapshot or the legacy list as a fallback; a plugin without
  `panelPage` answers unavailable. Mutation and admission continue through their full reads.
- The directory contains the same summary and displayed-cleanup rows as the index,
  preserving order, actor session IDs, completion sequences and original cleanup retry
  identities. It returns no mission maps. A mission request returns its compact map as
  one row; with `field`, an array's elements are rows and another value is one row.
  This gives direct bounded traversals of `actors`, `reports`, `history`, `control`,
  `actorEvidence` and extension fields. A task request returns the exact existing task
  page as one row, including its own task/attention continuation. Unknown compact-map
  fields, such as document metadata, pending document state and history request IDs,
  retain their exact JSON values.
- A successful envelope gives `source`, `projectID`, mission/field identity and range
  observation `revision` when applicable, then `page: {digest,total,pieces,next?}`. Each
  piece is `{index,offset,characters,text}`: a row's JSON or a slice of it. Join only
  contiguous offsets of the same digest and row, and parse a row only after all its
  characters arrived. A large nested string or actor/receipt list progresses across
  transfers instead of rejecting the source for its size. `next` is the exact
  `{digest,index,offset}` to repeat as `cursor`, with every other selector unchanged.
  A changed collection refuses `changed`; another unchanged field stays traversable
  across unrelated revisions. End-of-page means partial discovery until `next` is absent;
  a partial row supplies no absence, deletion or mutation evidence.

Task reads further in the one-time UI use `panelPage`'s task source through
`lib/mission-task-page-read.ts`: one explicit window or named read, reconstructed
under its first digest, fixed row length and required project/mission/revision/damage
header, and hash-verified before publication. The actual response body is capped at
64 KiB before JSON parsing, selectors at 16 KiB. Each transfer keeps its secondary
slot through stream consumption or cancellation, then releases it before the next
transfer. One 30-second deadline begins at store admission, including the serialized
mission queue and secondary queue, and covers stream reads, hashing, validation and
publication. Error cancellation also shares that lifetime: expiry releases its slot,
observes late cleanup rejection and preserves the original read failure. Consumed bodies
skip cancellation; a reader's pending cancellation is reused rather than requested twice.
Async hashing is raced with abort; synchronous work rechecks the monotonic
deadline before publication. Deadline failure parks a failed read; superseded ownership
returns `skipped`, which the reader shows with Retry rather than absence.
Partial text lives only for that operation. A failure parks the selector beside last-good rows; explicit Retry
starts at the first slice. Changed content has its own refresh/retry message and
zero automatic restarts or legacy task-route fallback. Connection/plugin events,
clear and wanted-owner changes fence in-flight slices and publication. The last owner
releasing a mission aborts its reads and advances its ownership generation; A→B→A
starts a new lifetime. Concurrent owners share the live lifetime. Unowned task reads
are skipped. The central reader registers ownership before its first target read and
keeps read-only refresh demand with the panel unmounted. The task cache keeps per-row
revisions and existing explicit window/attention coverage.

Task window admission (`mission-task-window-budget.ts`, `mission-task-page-schema.ts`)
uses limits on a requested window, independent of mission totals:

| Value | Consumer limit |
| --- | --- |
| Rows | 50 tasks, 200 top-level reports; one nested late report per task |
| Logical JSON text | 8,388,608 UTF-16 code units (16 MiB of UTF-16 input, plus hash brackets) |
| Logical text encoded as UTF-8 | 24 MiB |
| Cumulative response bodies for one window | 64 MiB |
| JSON structure before parsing | 262,144 opening-container/comma/colon tokens outside strings; depth 24 |
| Body descriptors | 64 per owner, names at most 64 units, validated length/digest values |

The 8 Mi-unit text ceiling accommodates current compact row budgets, including 24
240-unit dependencies per task and maximum-width native bindings, current/late reports
and body descriptors. Unknown metadata shares these budgets and stays intact when
accepted. An over-budget window refuses `too-large` before concatenation/hash allocation;
excess known nested shapes refuse `invalid`. The retained last-good display stays mounted.
These consumer limits bound renderer admission; a producer still reconstructs, serializes
and hashes its source for each transfer.

After hash verification, known compact fields and cardinalities, status/report counters,
named selector membership and report/task relationships are checked before adoption.
Explicitly named taskless reports and legitimate empty named answers remain valid.
Attention uses the existing execution-evidence predicate, observed pending notifications
and business states. A same-revision base map additionally identifies excluded pins and
its first omitted keys; another revision can change priority without changing task order.
The consumer validates these observable facts, retaining uncertainty about unseen priority
positions. Strict refusal alternatives preserve `damaged` and `changed` independently.

UTF-16LE SHA-256 uses WebCrypto where available and pinned `@noble/hashes` SHA-256 on
supported insecure HTTP web origins. Both paths validate identical bytes, including lone
surrogates, under the same logical budget and deadline.
The producer/consumer contract tests live in `packages/ui/tests/contracts/`, outside
the browser application's source graph, and run in the Missions UI unit CI step.

Mission-list discovery and cleanup history read explicit `window:{offset,order?}` selections
of at most 50 rows. The envelope echoes `window:{order,offset,end,total}`: `page.digest`
commits the chosen window alone, while `window.order` commits all row values of the
collection and fences subsequent selections. Each sliced logical window is assembled,
hash-verified and schema/identity-checked before adoption. A changed continuation parks
with Retry from offset zero; failed middle windows retain their exact selector and last
display independently of successes elsewhere. Expanded windows are retained with their
own observation revisions; passive refresh reads the first directory windows and wanted
headers, leaving other windows for explicit continuation/retry. Search filters loaded
summaries and says so while discovery remains partial. Summary windows carry `actorCount`
in place of actor-ID fan-out. Only selected and reader-wanted missions load headers/tasks.

`{source:"mission",missionID,header:true}` returns one bounded
`{root,collections,tasks,coordinator?,control?}` row. Root identity/state, body descriptors
and small exact extension values stay inline. Collections carry
`{characters,digest,total,array,order?}`; actors also name their observation order.
The top-level task metadata carries its page, pinned task/report IDs and source version.
The coordinator is one exact copied actor, including its Location, for full-ACK identity.
Wanted headers publish independently of directory reads; an explicit refresh awaits its
owned header reconciliation. Last-owner release fences pending work while retaining a
last-good header for a later selection. Task-source versions suppress unrelated expanded
task rereads.
Header/task revision skew retains the last coherent display and coalesces one header
retry under the original deadline; continued skew waits for fresh native or explicit
demand. Read failures retain their ordinary error and recovery state.
Actors, all compact reports, history and claims use independently selected field
windows. Lifecycle receipt/pending collections use `field:"control"` with
`part:"receipts"|"pending"`; lifecycle identity and counts stay in compact control.
Field lanes retain the root field and part separately; the owning root descriptor
invalidates structured and raw part windows together, and Retry preserves the exact part.
Pending first reads share that invalidation. Publication rechecks the owning descriptor;
successful reads retire only failures unchanged since their admission.
The selected mission reads its unified document projection. `document`, boolean cleanup
`documentPending` and history `requestID` retain their exact shapes; scheduling editors
keep their descriptor-pinned bodies/content reads. Snapshot/admission, internal and
mutation contracts retain full authority.

Any persisted field also accepts `text:true` with a window. Its offset names one
surrogate-safe 32-Ki-unit page of the field's exact JSON; `window.order` hashes the
complete JSON and `page.digest` independently verifies the chosen string row. The UI's
explicit raw-page controls read one page at a time under a 256-Ki-unit assembly budget,
including when a structured scalar/row exceeds its structured assembly budget. Structured
summary/header/field/observation windows use 256 Ki/1 Mi/8 Mi/24 Mi units respectively.
Every logical admission shares task transport deadlines, cancellation and two-slot
accounting, through validation and publication; a missing capability never widens a read.

Windowed cleanup discovery retains every pending intent, including document-only pending
deletions, with the settled-history policy applied separately. Rows use the composite
mission/deletion identity and validate immutable request/revision/options before adoption.
Only a complete same-order traversal retires last-good directory rows. Summary revision
merges are qualified by connection epoch. Native observations carry their own epoch and
observation cycle; failed/older windows retain display while fresh membership and recovery
coverage come only from current windows. Separately observed windows keep whole-mission
idle/absence unknown.

An initial summary request (`initial:true`) point-reads the durable finish counter under
the project's append exclusion before traversing hints, returning `finishHighWater` on
its first transfer. Failed/corrupt counter reads fail closed. The window seeds that
project's persisted completion watermark once, including deleted/purged finishes and
counter gaps. Later pages and refreshes preserve the initial boundary; separately shown
new completions are recorded without advancing over unseen/unloaded ones. Exact cleanup
retry reconciliation retains its single-mission read and immutable request/revision/option.

Project-scoped completion records inherit an existing folder record before durable-counter
seeding. Saved whole-inventory watermarks retain their unseen boundary; bounded legacy
hashed-ID positives persist across reloads and partial discovery, covering colliding IDs
while exact discovered rows also supply sequence positives. Passive first-window validation
retains a failed middle selector;
an obsolete collection order marks that failure changed until an explicit restart succeeds.

Fixed host, plugin and workspace unavailable refusals retain their typed cause through
the bounded owner and its localized unavailable guidance. Missing/failed plugins link
to Settings → OpenCode; a host bridge failure targets Settings → Info's diagnostic
report through the shared `server-diagnostics` row anchor. Last-good display survives;
malformed data, transport failures, changed orders and damaged ranges keep distinct errors.

The inventory consumer (`stores/mission-panel-inventory.ts`) uses the task consumer's
slot-owning response/cancel boundary and UTF-16LE SHA-256. Logical character ceilings are
256 Ki for 50 summaries, 1 Mi for a selected header, 8 Mi for field windows and 24 Mi for
the existing bounded activity/mark contexts and correlated native records. UTF-8 input
is bounded at three times that ceiling and cumulative wire input at eight times it;
the existing JSON structural-token/depth limits also apply. Over-budget values refuse
explicitly and keep last-good display, with exact source fields still addressable.
One 30-second operation deadline covers queueing, cleanup, hash, validation and adoption.
Last-owner release and connection epochs abort/fence trailing work; concurrent owners
retain their mission lifetime. Visible demand observes only the first mark window and
each wanted mission's first actor window. Further windows are explicit, retain their own
provenance and remain partial/unknown as a whole-mission claim. Positive requests survive
partial coverage and open the ordinary interruption dock; separate windows never combine
into atomic absence or recovery authority.
Current scheduled passages reuse this transport under their exact isolated
source identity.
Consumers adopting this transport key pages by workspace,
project and the complete source selector, retain each page's own revision, and keep a
failed middle page's cursor for explicit Retry. An unrelated successful page never
authorizes the failed page's rows. The paginator holds no retained snapshot or polling
job; it serializes and hashes the chosen collection afresh for each transfer. That work
is linear in source size per transfer, making a full traversal approximately quadratic
at a fixed transfer budget, and temporarily holds source rows, serialized strings and
the joined hash input. Summary/cleanup pagination performs this synchronous work inside
`readHints`' project append exclusion; range pagination runs after its range observation
releases that exclusion. Both use the native host's event-loop thread. The transfer-byte
bound and retained-cache policy leave those source CPU, memory and append-lane costs visible.

### Paged live activity

`panelPage` adds two opt-in sources, with the same 16 KiB selector and 64 KiB serialized
response limits, exact pieces and changed-content refusal:

- `{source:"activity", missionID, actorOffset?, actorOrder?, cursor?}` reads one mission
  range and selects at most 160 actor roots from its persisted actor order. Follow
  `context.actorPage.end` as the next `actorOffset` while less than `total`, repeating its
  `order` as `actorOrder`; a changed actor order refuses before native IO.
- `{source:"marks", missionOffset?, missionOrder?, cursor?}` selects up to 16 missions in
  directory order and up to 10 actors each, sharing the same 160-root observation budget.
  Follow `missionPage.end` and repeat `missionPage.order` as `missionOrder`. Warm hints
  require zero mission range reads, whatever the number of open/closed missions.
  The index retains reduced persisted actor facts (`mission-activity-context.ts`):
  session/title/location, report-owed and call-open evidence, and constant-sized family
  task attribution. It retains neither full tasks nor reports nor live native observations.
  Normal dirty-range refresh and the 60-second foreign-write hint contract apply.

The RPC answers `phase:"context"`, with the bounded persisted input as its single JSON
row; the HTTP route reconstructs that input, validates its root/project/window identity
and actor/string bounds, and runs the existing `projectMissionActivity` pipeline after
the journal lock. Assembly pins the first collection digest, row character count and
complete provenance header, including the required range/project damage fields and the
selected mission's revision. Every piece and continuation keeps those identities and
advances within the fixed length; the completed row's `contentDigest("[" + text + "]")`
must match before JSON adoption or native IO. Marks require unique mission IDs.
Invalid context output uses the bounded `plugin-unavailable` response.
HTTP answers `phase:"observed"` with `observedAt`. The selected-source
row is `MissionPanelActivityObservation` (`missions/mission-panel-observation.ts`):
`{context,coverage,requests,activity}`; marks return
`{missionPage,observations:[...]}` as one row. Every successful selected envelope keeps
the range-local discarded count and all three damage flags; marks keep the hints'
project flags, and every context retains its own range flags separately. Damaged no-map
observations retain the `damaged` refusal. Root compact-map extension metadata remains
available unchanged through the persisted mission/field sources.

`context.actorPage` gives offset/end/total and the actor-order digest. Each actor carries
its ID, title, saved Location, report-owed/call-open booleans and unique evidenced task
context when known. `context.control` keeps action, graceful state, original operation
and retry identity, pending/receipt counts, unknown-ACK count and incomplete-descendant
receipt count. Complete actor lists, lifecycle receipts and other persisted arrays
remain byte-paged through the mission field source. Task attribution is shared with
the full-map family projection (`missionFamilyTaskContexts`), including ambiguous calls
and parent conflicts. Business status/revision stay distinct from native execution.
The UI-shared `execution-evidence.ts` stays browser-pure; server producers aggregate
actor evidence through `mission-actor-evidence.ts`.

`activity` retains actor states and family evidence; `coverage` is `observed`, `partial`
or `unknown`, never silently complete for actors outside the window. A native unknown
actor state remains unknown even when family membership was observed. Native actor,
32-descendant family, inbox, Shell and shared 128-ancestry budgets and ownership fences
apply as in the existing projection. An ordinary member's declared/ordinary classification
and task key stay unspecified when a declared actor could be outside this partial window.
Positive native work still supports graceful-Pause/Interrupt-now presentation; an empty
partial window cannot establish that a whole mission is idle or recovery-ready.

`requests` contains real native Form/permission records with their session and observed
actor-root association, plus `state: observed|partial|unknown`. Only roots whose fresh
native project/Location identity passed ownership, and descendants in validated family
evidence, contribute requests. A positive own request survives an unrelated capability
failure. Failed request reads, uncorrelatable global requests, unknown families and actors
outside the window prevent a claim of complete absence. Follow actor windows to reach
off-page requests; complete per-window traversal supplies display evidence, never a
single atomic negative observation over separately read windows. Answering and recovery
continue through their existing native/authoritative admission paths.

No observation snapshot is retained. Each outer continuation reconstructs persisted
context and re-observes native state; `observedAt` is envelope metadata, while the digest
pins the exact data row. Equal-content observations can continue; any changed value
refuses `changed`, discarding the incomplete new row. There is zero automatic restart:
consumers retain last-good display, park the failure and explicitly restart from the
first piece (never loop on the old digest). Connection/deletion/view supersession
refuses `observation-unavailable`. Persisted context assembly is limited to 24 MiB of
JSON text, above the maximal escaped shape of 160 records at the existing journal string
bounds; this bounds intermediate untrusted transfer data, never total actors/missions.
Native request-list APIs return their Location lists whole; native call count is bounded,
and correlated returned records remain fully traversable through the byte transport.

Mark ordering/digest work and dirty-range reduction occupy the existing hints append
lane. New mark-context byte fitting runs after that lane, and all native IO runs outside
it. Source sorting/reconstruction and repeated native list reads still cost work on every
continuation; large/churning request lists can be expensive or repeatedly refuse. UI
adoption must use complete selector/window/generation identities, preserve per-window
provenance and failed-middle-page Retry, and never promote partial evidence to absence.

### Explicit execution controls

One-time product creation, including the coordinator's inspect-start tool, stores
a paused unified Mission document and a prepared map. The form's **Create** button
creates an unprompted coordinator and records its exact native identity; the
explicit first Play admits the original lifecycle message. Creation, Play and Resume
preserve native schedules and experimental settings. A changed connection or
workspace refuses the control before dispatch.
A single Play button starts a prepared mission or resumes a paused one; Pause and
terminal Stop are adjacent. `POST /api/workspaces/:id/missions/:missionID/control`
brokers the typed `lifecycle` RPC (`action: start | pause | stop`, `requestId`,
`expectedRevision`).

The product entry acquires the unified document's conditional storage from the
current native RPC invocation. New document creation checks `documentCapabilities`.
Journal-only missions retain their immediate Play/Pause/Stop, edits, declarations,
continuations and final reports through the existing journal path. Reads and
mutations preserve their stored representation; scheduling requires an explicitly
configured unified document. Each map's optional `document`
projection exposes configuration/time generations, first-Play request and message,
admitted launch count and settings-activation progress. First-Play intent is saved
before lifecycle publication/native admission; incomplete publication keeps the
original request identity reserved. Replay uses that identity, and only the exact
coordinator admission acknowledgement increments the count. The business journal
retains its existing range, revision, result and lifecycle receipt contracts.

Deleting a map with a unified document first persists its stopped desired state
and exact deletion request/revision/options. Pending passages, wake/mapping
reconciliation and unacknowledged configuration effects retain the complete
document. The bounded tombstone registry reserves capacity before journal deletion;
at capacity the stopped map stays visible. After the existing journal/native-session
cleanup succeeds, the document compacts to its original-request tombstone. Lost
publication/compaction acknowledgements retain the exact retry identity. Native
conversations follow the existing opt-in cleanup policy and are kept by default.

`mission.control-requested` records the durable desired state and exact root actors before native side effects; `mission.control-applied` receipts track acknowledgements. The project mutation lock serializes controls with assignments and report admissions. Partial failure returns `503 control-pending`, and the snapshot retains the original request and remaining targets for an explicit retry, including after a UI/plugin restart. Old completed requests cannot replay their side effects over newer states. Stop may supersede an incomplete start/pause; no lifecycle action can restart a stopped/completed/failed mission (a failed one resumes only through coordinator recovery, §Targeted recovery). Receipt capacity is reserved before intent publication. The plugin controls at most eight targets at once (`MISSION_CONTROL_CONCURRENCY` in `missions/lifecycle.ts`), each its own bridge call and family walk, so a mission with many actors is paused, resumed or stopped in waves; a target that fails leaves only itself pending for the explicit retry.

The panel's Pause is graceful (`graceful: true`, Pause only): it records a paused control with no targets and no native side effect, so it settles at once and never needs a retry. Every actor reads the paused context at its next model request (`MissionControl.contextFor`, `missionPausedInstruction`), and the plugin's context hook adds it for native descendants too: finish only the step in progress, start no new work or sub-agents, and end the turn. Ordinary native sub-agents are not actors, so the hook walks their native ancestry (bounded, parent IDs cached) to the nearest actor; for a paused Mission it re-reads that chain and adds the instruction only when every session still links to its parent and shares the actor's admitted project and Location, like the immediate family walk. Paused blocking and report parking below apply from the moment it is recorded. While the activity projection observes a running, queued, background, Form or permission actor of a gracefully paused Mission (a waiting family member outranks running ones in the projection; `missionActivityWorking`), the panel shows "Pausing: the steps in progress are finishing." and **Interrupt now**, which sends an immediate Pause; an immediate Pause is valid from `paused` only after a graceful one, and a graceful Pause only from `running` or `prepared`. Play after a graceful Pause projects `pausedDescendants.graceful`, and the coordinator's resume message says delegated work may have stopped early and should be continued, not restarted.

An immediate Pause calls native `session.interrupt({ resume: false })` for the coordinator and all specialist roots, and first for every active native descendant of each root (see recursive interruption below), preserves task/inbox context, blocks new Mission dispatch/revision/finalization, and parks report notifications. A report arriving while paused is saved without waking the coordinator. Play resumes the coordinator and roots with unfinished admitted work via stable-ID native synthetic admissions, with fresh server-side environment and Git context and unchanged native agent/model selection. Play never creates or dispatches a new task graph.

Stop is irreversible for that mission. It interrupts those roots, cancels this mission's pending native inbox inputs, retains conversations/results, and withdraws unfinished tasks. Native controls always pass through the authenticated desktop bridge, authoritative snapshot, exact ownership/location and worktree/connection fences. Interruption is acknowledged per session; an already running tool process can outlive it.

**Recursive interruption (best effort, honestly reported).** Tasks often delegate recursively with the ordinary background `subagent` tool, so a mission family can hold hundreds of native sessions. For each Pause/Stop root target the backend walks native descendants with `readNativeControlFamily` (up to 4096 sessions, paginated, cycle-safe; inconsistent or foreign children are skipped and make the walk incomplete), then interrupts active ones level by level, deepest first, before the root. Native background subagent jobs deliver their (cancelled) result to the parent inbox asynchronously with `resume`, which would wake an already interrupted parent, and a still-running parent may launch new subagents meanwhile; up to three bounded passes therefore re-read the family and `session.active` and interrupt again, with a final quiet read. The deadline is checked before every session, and in-flight native calls are cancelled at it. Native read or interrupt failures and the deadline make the receipt partial instead of skipping the root interrupt. After the root interrupt the backend re-reads the family once to interrupt sub-agents the root launched before its interrupt landed, settles the root, and re-reads once more to verify. Stop additionally cancels queued user/synthetic inputs in descendants, and on the root cancels this mission's inputs plus native `metadata.source === "subagent"` deliveries, including ones arriving during a short settle loop after the root interrupt, so cancelled-child results do not re-wake a stopped coordinator. Pause cancels nothing: deliveries stay parked behind `resume: false` and are processed when Play resumes the coordinator. The descendant passes run under a 50 s family budget and each post-root read under 10 s, inside an 85 s lifecycle bridge timeout (below the plugin's 95 s).

The `interrupt-observed` receipt carries an optional `descendants` summary: `observed`, `interrupted`, `cancelled`, `unconfirmed`, `complete` and up to 64 interrupted session IDs. `complete` is true only when the family was fully enumerated, the deadline did not expire, no descendant or the root remained active or had a failed cancellation, and the verification read after the root settled observed the whole family quiet. Otherwise the UI shows a compact "Some sub-agents may still be running." status beside the toolbar; it never claims a full stop without that evidence. Receipts without the summary claim nothing. Late deliveries after the settle loop and external wakeups remain possible. Play's coordinator prompt lists only descendants that the latest preceding Pause receipts reported interrupting (projected as the start operation's `pausedDescendants`) and that are still natively interrupted; user interruptions and earlier, already handled Pause cycles are never attributed to that Pause, and a partial receipt adds only a generic hint.

On Play, the coordinator's resume message lists descendant conversations whose native `outcome` is `interrupted` (mapped to task keys when the conversation is a task actor, bounded to 32) and asks it to re-delegate or continue them; assignments are never replayed automatically.

Display activity reads (the panel routes, `MissionActivityCache` in `missions/activity-cache.ts`) keep each actor's bounded family tree between reads, per daemon client: a structural session event (`session.created`, `forked`, `moved`, `deleted`, `updated`, `archived`, `renamed`), any event-stream status change, a kept root that reads differently, or 20 seconds read it again, and nothing is kept while an instance's event stream is down. Actor roots answered 404 are remembered as deleted and shown `missing` without another read. Actor roots, `session.active`, Shells, Forms and permissions are read on every observation; inboxes only for an actor that owes a report or has an open call and that no request, run or background work already describes, since queued input decides no other state. Recovery and recurrence observations take no cache.

Display activity and recovery keep the 32-descendant bounded read. When it fails (an oversized family), a bounded ancestry probe over `session.active` reports the actor `running`/`background`, and targeted recovery answers `recovery-busy` rather than `recovery-unknown`, on positive evidence only. The UI offers coordinator recovery only on observed `idle-without-report`, never on `unknown`. A running mission's coordinator owes its final report: observed idle, with an empty inbox and no saved report's notification still pending, it projects `idle-without-report`.

`mission.revise` is a coordinator-only, append-only plan change with `expectedRevision`, stable `requestID`, and a required reason. It can update objective/notes, add tasks with new keys linked to retired predecessors, retire tasks, and rewrite dependencies in one atomic event. A retired task never counts as completed. Every remaining dependent must explicitly point to a live task or remove that dependency; cycles and edits to already dispatched dependencies are rejected. Existing task contracts and reports are immutable. A late report from retired admitted work remains visible as late history and never changes the task back to completed. Revision never interrupts sessions or reconfigures busy actors.

Mission snapshots expose the latest 50 plan changes (`history`, with `historyTruncated` when older entries are omitted), including human objective/notes edits and coordinator revisions. Each entry has a revision and timestamp; `source` distinguishes `user` from `coordinator`. Human edits carry no actor session or reason; coordinator entries retain their actor and required reason. Entries without `source` are coordinator-originated. Snapshots also expose task lineage (`replacesTaskKey`/`replacedByTaskKey`), late reports, and `outstandingExecution`. A withdrawn task with admitted native work must receive a terminal report before the mission can be finished.

Build the shipped plugin with `npm run build:missions --workspace @neuralnomads/codenomad`, then run `node scripts/test-missions-native.mjs <absolute-isolated-opencode-cli>`: through the real bundled plugin, typed RPC, WorkspaceManager and bridge with a local deterministic provider, it exercises native tool registration/restart plus revision, late-report delivery, lifecycle create/update/delete replay, tombstone projection, settled deletion purge through native `storage.remove` (record-backed replay and recreation refusal), transcript preservation, catalog selection, variant persistence, a busy actor's durable queue, mismatched selection refusal, per-send actor/coordinator environment, presence removal/re-registration and retry idempotence, a mission of 12 actors and 107 tasks (managed roots, revisions, a paged `mission.inspect` within its bound, Pause/Play/Stop receipts for every actor through the typed RPC outputs, the panel read and a cleanup deletion of every managed root), and a final finished-history stage: 100 finished missions whose ranges are then seeded in the isolated KV table past 2,000 project entries, a reload whose new index builds over them, creation, declaration, readout and a deletion whose retention purge clears the oldest settled deletion beside them, the panel's list and single-mission routes over them (finished missions as rows only, an included one as its snapshot map, activity over the listed maps only), then an entry written directly into the isolated runtime's KV table that full reads (snapshot, the declaration's damage gate) see at once while inspect, the context hook and the panel list, reading through the index, do not. Report checks observe the actual provider request containing the report after resuming both an idle and a busy coordinator. It provisions its own home/config/database/provider and must never be pointed at the shared daemon.

The notification recovery regression removes the private bridge before a report, proves the report was durably saved despite admission failure, restores the bridge with and without a plugin restart, and requires a provider turn containing that report without another report call or human prompt. It also checks that an explicit replay after acknowledgement retains a single correlated native message and causes no further wake-up.

## Native execution and new-mission policy

`taskMode: "independent"` requires explicit independent task contracts, including additions
through plan revision, and uses owned root admission, never as a fallback after a
denied native call. Models must be enabled and tool-capable, with exact
provider/model/variant identity; roles, requested defaults, actual Session selection
and recorded invocation profiles are distinct facts.

The depth editor uses the authenticated connected runtime's declared
`experimental.subagent_depth` integer contract. It reads
effective native documents and edits only the selected owned Location's local
JSONC layer. The effective depth follows OpenCode's own read: the whole
`experimental` object of the highest-priority normalized native document that has
one, unmerged, so a project `experimental` block without the depth hides the
global depth (native normalization drops a block holding only unknown keys). Saving
compares the original full file/target expectation and preserves comments, sibling
fields and WSL atomic-write protections. Removing the override restores
inheritance and also removes, in one edit that moves its comments to the property's
place, a project `experimental` object left without properties or holding only a
`media_blob` (which Settings → Images writes there) equal to the one removal exposes.
That value counts only when certain: the runtime contract declares `media_blob`, and
the next native `experimental` object (`opencode/experimental-layers.ts`) belongs to
the Global write target and equals its fresh document, since native entries lag
behind writes and normalize what they load; otherwise the object stays. The snapshot
flags such an object (`emptyExperimental`) so Inherit can repair it.
The depth editor writes only `experimental.subagent_depth`, preserving depth zero
and the block's other options; `opencode/native-experimental-settings.ts` refuses a
block whose Missions settings are malformed or duplicated.
A remaining block
selects the native depth default unless it also holds a depth. Native
settings refuse simultaneous JSON/JSONC files in one layer. The schedule
capability reader independently recognizes the consumed API shapes and reads the
effective Location flag and its block origin through the acquired connection.
The depth snapshot exposes that selected block's document path as `origin`,
including when its missing depth selects the native default. The editor displays
the effective block separately from its project write target.
`node --import tsx scripts/test-subagent-depth-settings-native.mjs <absolute-isolated-opencode-cli>`
(also in the latest-runtime CI job) qualifies this against a private runtime: depth
capability, JSONC save/reset preserving comments and siblings, Global image storage
cleanup, stale-expectation conflicts and foreign-location rejection.

OpenCode's built-in General subagent, which runs native mission tasks unless a
profile selects another agent, ships a rule denying `subagent`; OpenCode then
removes the tool, so General conversations never nest at any depth. The marked rule
below exists only because of that built-in denial: remove it once OpenCode hides the
`subagent` tool at the depth limit and drops the denial
([anomalyco/opencode#60961](https://github.com/anomalyco/opencode/issues/60961)).
A project depth override is the user's consent to subagents nesting up to it: saving
any override, 0 and 1 included, also writes the rule once into the General block
the same project document already uses (`opencode/subagent-nesting.ts`), because
within one document OpenCode lets a native `agents` entry replace the whole
migrated legacy one and a legacy `mode` entry replace `agent`
(`config/normalize.ts`): a new block beside the user's would drop its prompt,
steps and other rules. A native or absent block gets
`{ "action": "subagent", "resource": "*", "effect": "allow" }` last in
`agents.general.permissions`; a legacy `mode.general` or `agent.general` block
gets `"subagent": { "*": "allow" }` last in its `permission` object, under
`task` when an earlier `tools` or `permission` key already holds `subagent`
(OpenCode keeps a repeated key's first position). When neither key is free or
`permission` is a string, only the depth is saved: the snapshot flags it
(`project.nestingSkipped`) and the editor warns with manual-configuration guidance.
Only the winning block counts as having the rule: a save moves CodeNomad's rule out of
a block a newer one supersedes. Existing lines stay unchanged, and a line comment
inside the rule marks it as CodeNomad's and names the outermost container it created. As a project agent rule it takes precedence over
General rules from other documents, whatever they decide, as the editor states. At
1 OpenCode's own depth limit still stops nesting, and 0 keeps OpenCode's meaning:
no subagents. Only Inherit (no project override) removes every marked, unchanged rule
and, while empty, only the containers its marker names as created; an identical rule
without the marker is the user's. The snapshot's `nesting` reports, from
General's resolved rules (`agent.list`), the effect of launching another General
subagent and `hidden` when OpenCode removes the subagent tool (its last `subagent`
rule denies `*`, core `tool.ts`). A visible tool proves no target is allowed, so a
General-only denial is shown as denying General targets, others following their
own rules. Both are evaluated for display only: the last matching rule with OpenCode's wildcard,
case-insensitive on Windows hosts per `getServicePathStyle`. Never write the rule
in the Global document or through top-level `permissions`, which would also
override Explore's built-in rules.
`node --import tsx scripts/test-subagent-nesting-native.mjs <absolute-isolated-opencode-cli>`
(latest-runtime CI job; it reads project configuration, so locally set
`CODENOMAD_NATIVE_FIXTURE_PARENT` outside your home) runs real General subagents
under a deterministic provider: one level with only a Global depth of 3, still one
level at a project depth of 1 whose rule General then has, a General grandchild at a
project depth of 2, no subagent at 0, and the file and denial restored by Inherit;
then a legacy `agent.general` block keeps its prompt, steps and edit/shell denials
with the rule, nests at depth 2 and is restored by Inherit.

Activity and targeted recovery share `missions/native-session-family.ts`: a root's
bounded native descendant inventory (32 maximum) must have consistent parent,
project and exact location identities and no remaining page. An idle root with an
active child is background work, a descendant inbox prevents idle-without-report,
and descendant/global native waits are reflected as waits. Failed or partial
inventory becomes unknown. These projections are read-only.

`mission.inspect({ catalog: true })` reads the caller location's native agent/model catalog. `mission.delegate` accepts an optional `execution` selection, independent of its mission `role`:

```json
{
  "taskKey": "review-spec",
  "title": "Review acceptance criteria",
  "brief": "Compare the diff with the requirements and report evidence.",
  "role": "review-spec",
  "execution": {
    "agent": "reviewer",
    "model": { "providerID": "provider-from-catalog", "id": "model-from-catalog", "variant": "variant-from-catalog" }
  }
}
```

Use actual catalog IDs (agent modes per Native execution and new-mission policy above). Explicit selections are persisted in the task contract and passed to native `session.create`; retries cannot replace them. Omitted fields retain native defaults, so specify both agent and model for a fully pinned assignment. The UI displays these native identifiers beside the role.

An existing actor must already match the requested selection. Missions never uses `switchAgent`/`switchModel` to repurpose a busy actor: those APIs alter all subsequent turns. A queued assignment runs with the actor's model at execution time, so external client changes after admission apply.

Independent roots use only their own native agent/project permissions.

## Distribution and environment

The content-addressed bundle is provisioned into the authenticated daemon's
`config.get` discovery root; backend leases live outside that watched root. Tools,
their context hook and the passage prompt hook register once at plugin load,
independently of presence; the typed
RPC and the ordinary one-time route register through backend presence, for the
steps of a calendar run that need them (§Mission calendar tool), and at activation
when the project's `codenomad-missions/registered-v1/<project>` key exists and a
Mission is running. The key is written with each registration and removed when the
registration ends for lack of work, so only a project whose Missions were registered
when the service stopped reads its journal at activation; prepared and paused Missions
wait for a backend. Without
either route, the context hook removes every `mission_*` tool from the model
request and the executors refuse. `retainMissionWork` preserves
the registration while active/unsettled work, receipts or uncertain storage
remain, including after lease loss. Never install project-local files; the
server typecheck covers the plugin contract. Qualify presence loss with
`MISSIONS_LIFETIME_NATIVE_CLI=<absolute-isolated-opencode-cli> npx tsx --test src/opencode/missions/presence-native.test.ts`
(in `packages/server`): it observes the presence registration through the native
`codenomad.missions` RPC, and the tools through the native tool list and the model
request.

Whenever a CodeNomad backend owns the coordinator, assignment prompts and report synthetics use a narrow authenticated loopback bridge mode. The owning backend reconciles the persisted task/report via `codenomad.missions.snapshot`, validates complete native session ownership and selection, acquires the worktree mutation fence, and applies the current full profile environment before admission. Native environment errors are redacted and fail closed. Environment data never travels through the UI or plugin. Multiple owning backends are rejected rather than choosing a profile arbitrarily.

When no backend runs, or every running backend disowns the coordinator (`browser-claim` answers 404), `sendMissionInput`'s `unowned` effect runs instead and the plugin acts through its own session API: assignment prompts and report synthetics (`ctx.session.prompt`/`synthetic`), the lifecycle start synthetic (`missionActorResumeInput`, acknowledged as `start-admitted`) and managed root creation (`createManagedRoot` answers `undefined`, so `MissionControl` creates the root natively). These sends carry the session's existing environment and permissions, without profile environment, Git or memory context, permission-mode rules or worktree fence. A backend that neither claims nor disowns (timeout, any other status) keeps the send refused. Recovery synthetics, Pause/Stop effects, cleanup, task observation and interruption, preparation and preferences always need the owning backend.

Before either kind of admission, the backend also refreshes its owned `codenomad.git-availability` instruction through `syncSessionGitContext`, removing stale context after recovery. This bounded Git advisory is separate from fail-closed environment synchronization: admission proceeds when it fails, while cancellation and connection retirement block admission.

Agent memory refreshes its owned `codenomad.memory` entry through
`syncSessionMemoryContext` before assignment/report/recovery inputs and lifecycle
resume synthetics. Preparation uses the optional instructions capability, fresh
enablement and the target session's authorized location; unreadable scopes are
omitted independently. Native instruction writes retain the Missions authority
checkpoint, and full admission checks run again afterward. Optional memory errors
attempt named-entry removal and allow admission; cancellation, retired connections
and authority failures block the send. Disabled memory bypasses discovery and
storage; an absent capability keeps memory silently inactive. See
[Agent memory](AGENT_MEMORY.md#session-instruction-synchronization).

The bridge accepts up to 250,000 assembled text characters within its 512 KiB JSON body limit. This accommodates the maximum objective, brief, title and dependencies after XML escaping (up to 5×), including JSON control-character escaping on the wire. HTTP regression coverage exercises maximum accepted contracts for all playbooks.

This transport reuses only the automation bridge discovery; automation keeps its own execution-time session/window fences. Environment and model state are session-scoped: a queued inbox item runs with the session's state at execution time; see [SESSION_ENVIRONMENT.md](SESSION_ENVIRONMENT.md).

## Mission calendar tool

A programmed Mission (the "calendar" of this code) is, to its user, one Mission launched again and again. `codenomad.mission_calendar_run` (`opencode/missions/mission-calendar-tool.ts`, logic in `missions/calendar-run.ts`) lets a native OpenCode Automation launch an ordinary one-time Mission with CodeNomad closed. The Automation's program is the fixed `MISSION_CALENDAR_CODE`, which keeps the run's answer (`outcome` `launched`, `waiting` or `idle`, the current launch's `missionID` and `status`, the `coordinatorSessionID` every launch uses, the `history` of past launches and the count of all `launches`, as JSON text) in the Automation's `state.last` for any client to read, and its `args` are the Mission to create: `objective`, `template`, and optionally `title`, `notes`, `taskMode`, `profiles`, `coordinatorGoal`, a `coordinatorSessionID` every launch reuses and a new coordinator's `permissions`, plus the events to wait for in `when` and, for a calendar made of several Automations, the `calendar` identity they share. The Automation belongs to a carrier conversation whose metadata holds `codenomad.mission-calendar` and whose permissions are `MISSION_CALENDAR_PERMISSIONS`.

- The tool accepts only a message named `msg_<automationID>_<run>` in a carrier conversation; the Automation ID is the calendar's identity and the run number makes a repeated run idempotent (`requestID` `calendar_<automationID>_<run>`).
- `codenomad-missions/calendar-v1/<project>/<calendar>` (the Automation's own ID when it names no calendar) holds, for all the calendar's Automations: its current launch, the coordinator conversation, the dates and outcomes of its last twenty launches and its event checkpoints. While the current launch is `active` (including paused or waiting for its final report), a later run launches nothing and answers `waiting`; a launch whose start did not finish is started by the run that finds it.
- Until its first launch a programmed Mission is an ordinary prepared Mission, created with the programming and named by `prepared` in the `args`: it has its line in the list and can be played by hand. The first launch starts it instead of creating one; if a person started, ended or removed it, it is treated as the previous launch.
- A new launch replaces the previous one once it exists: the new Mission is created prepared in the same coordinator conversation and recorded, the previous one's date and outcome join the history and its Mission is deleted without deleting any conversation (a removal that fails is tried again by the next launch and never holds this one), then the new Mission is started. A launch nothing can create fails its run and leaves the programmed Mission as it was. That conversation is the one the `args` name, else the one the previous launches used, else a new one: the first that can coordinate.
- `when` lists up to eight events (`missionCalendarEventsSchema`: local branch commits, changed files, remote branch commits, repository activity and the GitHub events), read by the source readers of `missions/` with this machine's own Git and forge access. Any one changed since its checkpoint is news; an event's first read only records where it stands. A run without news answers `idle` and asks nothing of Missions. An active Mission leaves the events unread, so their news launches again once it ends.
- A Code Mode program's graph has no Mission storage, so each step goes through this service's own HTTP RPC (`create`, `lifecycle`, `mission`, `delete`), found by the default registration file of this very process, as CodeNomad's Create and Play do.
- Each step that needs Missions keeps them registered while it runs; the Mission it starts then retains the registration. Failures surface as fixed `mission-calendar-*` codes in the Automation's last output. Events that cannot be read are no failure, since OpenCode pauses an Automation after three failed runs: the run answers `unread`, changes nothing, and the next run reads them.

`missionCalendarAutomations` (`missions/calendar-automation.ts`) maps a Mission's launch criteria to those Automations: one per date rule, each with the events after the rules as its condition, or one that asks for events alone every fifteen minutes. The arguments also keep the criteria as entered (`launch`), for the form that edits them. A fallback date after events, an end date or count, followed conversations and the events of other Missions and conversations are named as unsupported. `node --import tsx scripts/inspect-mission-calendar-conversion.mjs [absolute-opencode-db]` applies it, read-only, to the schedules stored in an OpenCode database.

`missionCalendars` (`opencode/mission-calendars.ts`) is the only code that speaks OpenCode's Automation API for calendars. Per Location it owns one carrier conversation, `ses_cn_schedule_calendar_<token>` (the reserved prefix keeps ordinary sends, favourites and permission modes off it), lists the Automations that run the calendar program there grouped by calendar identity (none while the carrier does not exist yet: OpenCode answers `SessionNotFoundError` for it), with what the latest run of any rule did, and saves, pauses, resumes or deletes a calendar. Saving again replaces the rules under the same identity, so the latest Mission and the checkpoints stay, and a paused calendar stays paused. `server/routes/mission-calendars.ts` exposes it under `/api/workspaces/:id/missions/calendars` (`GET`, `PUT /:calendar`, `POST /:calendar/pause|resume`, `DELETE /:calendar`; the caller names the programming, so `PUT` creates it or replaces it and a repeated save is the same one; `paused` creates a new one paused) behind the Mission map admission; a configuration whose criteria no Automation carries answers 422 `calendar-unsupported` with the reason, and one naming a conversation that does not run the coordinator's agent and model (`matchesExecution`) answers 422 `calendar-coordinator-profile`. A programmed Mission is listed as its Mission: every operation first prepares one again for a paused programmed Mission whose Mission is gone, in another conversation when the one it names cannot coordinate (a running one is left to its launch, which may be replacing it). Saving a new programming, or editing one whose Mission was never started, first prepares that Mission through the ordinary creation pipeline (in the same conversation on an edit); an edit after the first launch leaves the Mission of the current launch alone and keeps naming it. Each listed calendar names `missionID`, the Mission that is the programmed one right now, and its `launch` criteria once they parse as a launch policy.

In the panel a programmed Mission is the ordinary row of that Mission. `stores/mission-calendars.ts` reads the directory's calendars beside a list that has Missions, again whenever one of them appears, goes or changes state; `components/mission-programming-model.ts` derives what is shown. The row has the recurring icon, adds the criteria and the next wake to its status and, between launches, is marked waiting for its next wake or paused; the selected detail shows the programming above the tasks (`components/mission-programming.tsx`: criteria, state, next wake or check, launches, past runs). A programmed Mission has one pause (`mission-selected-actions.tsx`): Pause on a launch under way pauses the programming, then the launch, and Play resumes the launch, then the programming; while no launch is under way they pause and resume the programming alone. Stop ends the launch under way; while none is, once confirmed, it deletes the programming and the Mission stays as an ordinary one. When a launch replaces the selected Mission the selection follows it, and deleting the Mission deletes its programming first. UI code imports `missions/launch-policy` as a type only: the module loads Node's crypto.

The creation form (`components/mission-editor.tsx`) saves a Mission whose launch criteria repeat as a programming: one `PUT` under an identity drawn once per form (`calendarID`, kept in its draft), so submitting again after a lost answer saves the same one, created paused when **Start automatically** is off. **Edit** on a programmed Mission reopens that form filled from the calendar (`missionProgrammingDraft`) under its identity. A refused save leaves the form as it was; criteria no Automation carries show `missions.scheduling.error.unsupported`.

Agents reach the same operation (`runMissionCalendarOperation`, `server/routes/mission-calendars.ts`) through `mission.program` (`missions/program-tool.ts`, `server/routes/mission-agent-program.ts`): `list`, `save` under a stable `id`, `pause`, `resume` and `delete` for the programmed Missions of the calling conversation's directory, a refusal being an answer with its code. `mission.prepare` refuses launch criteria that repeat with `use-mission-program`.

The schedule documents stored in a directory are taken over by the calendar operations there, whoever asks (`runMissionCalendarOperation`), until none is left for the service connection. The plugin reads them from its storage without that engine (`legacySchedules`, `missions/legacy-schedules.ts`). Each becomes the programmed Mission of the same identity, saved paused; a named coordinator conversation that no longer exists is dropped, so the first launch opens another, and launch criteria no Automation carries make an ordinary prepared Mission instead. The schedule's own Automations are then deleted and its document replaced by the tombstone the engine writes for a deleted schedule (`retireLegacySchedule`, `legacyTombstone`), so a conversation one of its passages created coordinates ordinary Missions again. The programmed Mission is resumed last when the schedule ran with no failed passage holding it, so the two never launch together. A schedule already programmed is only deleted; one that fails is left as it is for the next operation. Past runs and counts start again.

`node --import tsx scripts/test-mission-calendar-run-e2e.mjs <absolute-isolated-opencode-cli>` (after `npm run build:missions --workspace @neuralnomads/codenomad`) qualifies it on a private runtime with the bundled plugin and no backend: launch and start with the coordinator `/goal` armed, later runs waiting, an independent task whose root is created, prompted and reported, the next launch replacing the first Mission in the same conversation and finishing after an OpenCode restart, a calendar that launches only once a commit lands on a local branch, and a programming whose first launch starts the Mission prepared with it.

## Safety limits

- One native project per mission.
- Coordinator and independent actor admission require exact owned roots; native
  descendant observation/reporting uses its separate ancestry/provenance contract.
  Foreign projects are rejected; a graph edge never grants session authority.
- The qualified native ordinary journal has no fixed entry count, so writes and
  terminal receipts do not compete for reserved capacity. A Stop or managed-session
  cleanup intent holds at most 2,000 distinct targets. A new actor ID is refused
  at 2,000 distinct recorded actors; reusing an existing ID does not add a target.
  An already oversized target set is refused before any terminal side effect; deleting with conversations
  retained requires no managed-session cleanup targets. With the generic
  scanner, a mission's 2,000 stored journal entries
  (`MISSION_MAX_EVENTS`, counted over its key range, unreadable entries, receipts and
  tombstone included) bound it, and the number of missions, and so a project's
  journal, is unbounded. Entries plus pending reserved receipts never exceed that
  count on that scanner. Ordinary writes keep the lifecycle reserve of the actors
  they leave the mission with (`missionLifecycleReserve`: twice one plus the actor
  count, plus one document-cleanup receipt for unified documents; every session an entry admits as original
  or replacement coordinator, dispatching or native-bound
  actor counted), so a write that would admit an actor without room for its reserve
  is refused like any other once the mission is full. A Stop request keeps only the
  deletion's share (`missionTerminalShare`, one plus the actor count, plus that document receipt) and the deletion
  tombstone and already reserved receipts spend the rest. Control targets and cleanup
  targets are actors (a graceful Pause has none; Interrupt now is an ordinary Pause
  write and keeps the reserve), and only the latest control's targets are reserved,
  so after any ordinary write one Stop of every actor and then a
  deletion cleaning every managed root always fit: a full mission can still be stopped,
  deleted and finish its cleanup. A point read of the exact document key reserves that
  additional receipt; an unreadable document key refuses the append. Isolated passage
  journals keep their journal-only reserve. Replaced never-admitted coordinators stay
  in the capacity actor set and remain retained conversations. Preparation checks its
  replacement actor's reserve before native creation and journal publication.
  The receipts of a published Stop or deletion are
  reserved within the mission's count. Per call, a revision adds or retires at most 24
  tasks; each of its dependency updates names a distinct live task (the journal
  refuses a repeated task key), so one revision rewrites at most as many dependency
  lists as the mission has tasks and can repoint every dependent of a retired task.
  Standalone capacity checks (`assertCanAppend`, `append`) read the target mission's
  range and its exact document key. Declaration and briefing count the target's
  entries during the publication snapshot's scan and apply the new event to that
  same observation under the append exclusion. A write's safety decisions still read
  the full journal (§Journal index), so write cost grows
  with the project's history. Every read stops past 2,000 entries in one mission range
  (entries outside every range share one such bound); a full project read
  (`events()`/`snapshot()`, the index build) holds every mission's events, bounded only
  by that per-mission bound times the number of missions. That is the accepted cost of
  an unbounded project. Activity observation covers only the maps a panel list returns
  (open and included missions) and reads at most 160 actors per refresh, running
  missions first, with gracefully paused ones whose steps may still be finishing (the
  panel offers Interrupt now only while it observes them), then the other active ones,
  whatever their actor counts. With more
  actors than that, the refresh first reads the open Forms and permissions of their
  saved Locations and attributes each to the actor it descends from (one bounded,
  shared ancestry walk of 128 session reads), then reads the actors asked for an
  answer, then those with open work (a missing report or an unsettled native call),
  then the rest in mission order; the others read as unknown and the mission's family
  projects as `partial`: the members of the actors read, any failure among them still
  clearing the whole membership. An actor's per-turn context lists at most 32 of its
  open assignments and points to `mission.inspect` for the rest.
- Existing root actors may be reused, but an actor cannot join two active missions.
  Once a mission is stopped or finished another active mission may reuse its
  actor; a Stop target found serving another active mission settles with a known
  `target-reused` receipt and no native interrupt or inbox cancellation, so the
  stopped mission can still be deleted. Pause/Play on a shared actor are refused.
- Dependency tasks are mapped as blocked and are never auto-dispatched.
- Completing a mission green requires every active task to have a completed report and every withdrawn task with admitted work to have a terminal report. The Debugging playbook's completed-role evidence gates apply; retirement cannot satisfy a gate.
- One-time creation refusals that provably happen before the native create is
  attempted carry no-effect codes (`creation-unavailable` 503,
  `creation-worktree-deleting` 409, plus the existing capacity/scope codes and a
  receipt-backed native `request-conflict`): the UI keeps the draft and re-enables
  Create. Every later failure stays an exact `creation-uncertain`/codeless hold.

## Included playbooks

- **Debugging** preserves evidence-first diagnosis, behavioral TDD, independent fresh Standards and Spec reviews, implementer-session resolution, and a fresh read-only green gate. Completed role reports carry validated structured artifacts, while the coordinator chooses each transition. Before declaring any task, the coordinator may finish with the checks in `evidence` and a final `{kind: "no-change"}` when no change is needed or `{kind: "verified-completion"}` when the objective is met without debugging.
- **Wayfinder Map** adapts destination, map, frontier, claims, and fog-of-war planning to visible sessions. It remains planning-first; decision workers, prototype scouts and decision guides return briefs, and the coordinator decides, defers or asks the human (§Human questions and decisions).
- **Product delivery** (`delivery`) adapts the NomadWorks Collective method (`NeuralNomadsAI/NomadWorks`) without requiring that plugin. The coordinator acts as Product Manager: it classifies each request by complexity (tiny, standard, complex) and track (implementation, investigation, spec), has the business analyst and tech lead draft a Spec Change Request for any behavioral change (tiny included), standard or complex implementation and spec work, runs read-only pre-sync readiness reviews before implementation, decomposes complex work into slices with the technical architect, keeps one shared-checkout implementation task at a time, and closes only with QA/tech-lead evidence and resolved documentation impact. The six roles are business analyst, technical architect, tech lead, developer, QA engineer and UI/UX designer. The coordinator treats an objective that already states the behavior change precisely (what changes, for whom, how to verify it) as the approved request, and otherwise asks the human to approve it through the native question tool, batching pending approvals; the human owns commits unless the objective or notes explicitly ask for them. One playbook covers both NomadWorks team presets; the coordinator declares only the roles each complexity needs. Same-scope rework retires the task and adds a replacement (`replacesTaskKey`); continuing a native specialist's context uses a follow-up task whose `reuseFromTaskKey` names that specialist's finished, still-live task.

The scenario label's info action opens the localized `playbooks` help page at the selected playbook's stable anchor (`custom`, `debug`, `wayfinder`, `delivery`, `compare`). The exact instruction export remains `GET /api/missions/playbooks?taskMode=` (`server/routes/mission-playbooks.ts`, wire type `missions/playbook-details.ts`): `missionPlaybookDetails()` returns each `getMissionRecipe(id, taskMode)` plus the complete coordinator and role texts generated from `PLAYBOOK_PLACEHOLDERS`. `mission-playbooks.test.ts` compares these whole texts with actual recipient instructions after substituting that mission's data. Never copy recipe text into UI strings.

## Validation

`node scripts/test-missions-native-trajectory.mjs <absolute-isolated-opencode-cli>` also checks the one-time Wayfinder decision flow: an artifact-free readout and a forged answer refused without journal mutation, a decision worker that returns a brief, the coordinator's own question naming the task's `questionTag`, answered through the authenticated UI route, listed by `inspect({ taskKey })` and settling the task without an artifact, and a coordinator decision recorded as its own. The invocation unit tests cover graph isolation, missing/stale invocations, interruption joining and per-check deadlines.

Each complete one-time human-gate call (acquisition plus its nested SQL/Form/storage reads) shares one 10-second deadline (`NATIVE_HUMAN_ANSWER_TIMEOUT_MS`), combined with invocation cancellation. The check aborts and joins only its own runtimes and clears its timer on settlement; later checks get a fresh budget, excluding intervening session/authority work. The invocation joins all pending checks/reads before graph release. A raw Promise that ignores abort may remain pending, but cannot resume its cancelled Effect into the graph, and later reads through that expired check are refused. A stuck native finalizer or uninterruptible read is joined before its graph is released: never abandon such work with a Promise race, and keep reads interruptible and cleanup finite. Recurring gates use their own runners.

`node scripts/test-missions-native-family-control.mjs <absolute-isolated-opencode-cli>` (latest-runtime CI) qualifies recursive Pause/Play and Stop with real background subagents in a private runtime: a five-session, three-level family interrupted deepest-first with complete receipts, Pause parking results without model turns, Play resuming only the coordinator with interrupted-child context, Stop emptying family inboxes.

`npm run qualify:browser:native-mission-replay --workspace @codenomad/ui`
(`tests/browser/native-mission-integration.qualification.ts`) replays a captured
private native run through the real renderer only: it requires `NATIVE_MISSION_CAPTURE`
as the absolute path of that run's `capture.json`, fails when it is missing,
answers mutations with 405 and writes `browser-report.json` to the absolute
`NATIVE_MISSION_OUTPUT` (default: a temporary folder).

## Agent conventions

- The bounded panel inventory shares its display projection across readers of
  the same occurrence snapshot. A loading-only lane update keeps that projection;
  published rows, failures, and retired ownership invalidate it.

- Model-facing tool schemas use a plain object at the root, with variants inside properties. Keep scope and action validation in the execution codec.

- Missions project tools admit every owned project conversation, including descendants and scheduled passages, and include human-created Missions. Keep coordinator-only topology and authenticated human-answer evidence at their existing domain boundaries.

- Mission reader and conversation gestures advance the tab occurrence generation at admission. Async navigation adopts only while that generation is current. Passage retargeting, inventory cleanup and Mission absence reconciliation apply immediately against their current source and reader; pending gestures retain their authority.

- Restored task selections demand their exact bounded task ID even with the reader closed. Their toolbar stays task-owned and disabled until resolution; a successful absent answer clears that selection. Dependency links update the owning row, task selection and reader together. The open reader follows one-time and calendar-owned selections, with view, connection and exact passage fences around delayed reads. Calendar-owned schedules without a current passage show their saved instructions centrally.
- Duplicate project occurrences can select different Missions/tasks and read different reports while sharing native Mission data and execution. Reader opening, following and closure arbitrate only with that occurrence's file/web view; switching occurrences preserves each target. Restore captures bounded presentation identities through `viewState.missions` and rebinds reader instance references before hydration (see [PROJECTS.md](PROJECTS.md)); body reads retain their existing cache, demand and authority scopes.
- Task completion attention seeds once per observed project from initial server timestamps. Only completed task versions receive individual acknowledgements; memory retains the boundary when layout persistence is unavailable. Command announcements and recovery actions belong to the persistent header outside folded task content. A deletion's consumed automatic submission and error survive panel remounts independently of its original-request retry state.
- Mission sections use `components/mission-disclosure.tsx` and the shared `.disclosure-chevron`. `stores/mission-view-state.ts` takes the occurrence's `instanceId` for selection, reader, expanded rows and disclosures; `tab-view-state.ts` captures them in each restorable tab envelope. The newest disclosure choices share the bounded Mission view value. Native reader `<details>` use `createMissionDisclosure` so their open state and lazy body demand survive remounts for that occurrence. Completion/task acknowledgements retain their project scope within the window; native actions retain their project, connection and passage authority fences. Long mission content uses `components/mission-reader.tsx` above the transcript; its chrome follows `.window-*`. Mission styles live under `styles/panels/mission-*.css`. Template and execution mode are orthogonal; recurring drafts record the chosen template, optional verbatim notes and exact coordinator/playbook-role profiles for future passages, under H9 editing guards. The shared configuration library retains its version-1 name, instructions, notes, playbook, profiles and task-mode storage contract. Daily CREATE and UI share `recurrenceReadBudget` / `recurrenceInputBudget`, with exact native Location room; never raise a ceiling automatically.
- Creation is one compact screen (`components/mission-editor.tsx`, `styles/panels/mission-create.css`): the saved-configuration picker first, then instructions, an editable title prefilled from its first sentence or the loaded configuration name (≤60, `missions/mission-title.ts`), playbook, delegation, profile selectors, Notes and Launch when criteria. Objective and Notes start at one line and grow with `field-sizing: content`. Profile and scheduling rows are directly visible; criteria default to once now and show their or / if / else connectors, with the saved zone shown only when it differs from the system zone. Delegation includes the project's native subagent depth row (`mission-subagent-depth.tsx`, shared with Preferences). Secondary explanations and localized help links use focusable info actions: playbooks at their selected anchor, configuration at `missions#saved-briefs`, task sessions and depth at `missions#profiles`, scheduling at `missions#native-scheduling`.
- The panel's Create button heads the form, which replaces the selection line and the tree with its selected detail; these stay mounted but hidden (`.mission-control[data-creating]` in `mission-control.css`, `MissionPanelHeader` `creating`) so pending controls and retries survive. The form fills the panel below its header as a column whose body is the only scroller, with the footer below that scrollport at the panel bottom: asynchronous content (depth reads, catalogs) never moves Create from under an aimed click, and focus scrolling never hides a field behind the footer. Unconfirmed cleanup banners are ordered above the form, so they shrink the body instead. When the header, banners and footer leave the body less than its minimum, the whole form scrolls in the panel with the footer after it (`mission-panel-scroll.ts`).
- The footer's Save configuration is a bookmark icon (`.window-icon-button`) named by its tooltip; its name field's Save and Cancel take the footer's `button-secondary` template. Every command of the Missions panel and its readers (retry, check, copy, open a reader or conversation, the configuration name field's Save and Cancel) is a bordered `.window-action`; `.window-text-button` stays only on end-of-list "Load more" links (the panel's paging, the task tree's continuation, the schedule list and a task's whole report history). The footer has a single **Create** submit. **Start automatically** sits outside Scheduling, off by default and retained in the form draft. Creation stores a paused Mission; when selected, only its direct positive acknowledgement continues guarded Play under the same captured view and intention. Read-only receipt recovery leaves Play explicit. Validation stays inline beside its field.
- One-time and current scheduled readers show bodies through `useMissionBody`/`useReaderValue` (§Body display). Never feed cached display values into admission, mutations or lost-acknowledgement checks. Answer presence from descriptors (`missionBodyPresent`, `missionReportHas`) and labels from bounded excerpts and `decidedBy`. New bodies belong in `MISSION_BODY_FIELDS`; never add prose to compact rows. Restrict compacting and paging to display projections (`list`, `mission`, `panelPage`, exact current passage pages and their routes); keep authority maps full. Current passage body keys carry the exact source and report readers retain immutable report IDs. Browser fixtures serve actual bounded projections/content from their own full maps and retain every report in the mission's own `reports`, as the reducer does.
- A compact map holds a page of its tasks and their reports (§Task pages). Never derive a whole-mission fact (task counts, open questions, activity, owed work, whether a task or report exists) from its `tasks` or `reports`: use `taskPage`, `actorEvidence`, `actors`, the activity projection and the summary rows. Navigation to a task the map does not hold reads it (`openMissionTask`, `missionStore.loadTasks`) instead of being disabled, and every row the server sends stays within its budget: a new unbounded task, report or change field is a body or a count, never a list in a row. Keep `missionTaskOrder` the only display order, shared by the server's pages and the tree.
- Editor input copies and receipt checks use exact descriptor-pinned content with their original map revision and request identity (§User-journey regression checks). Unified-document projections stay whole in compact maps: `MissionDocumentSummary` carries bounded configuration metadata and input digests; editor text comes from the schedule or content route.
- Journal editor reconciliation reads the original history request and exact text independently of the task window. Task pages preserve document and cleanup metadata; missing rows require the named display read their reader needs. Current scheduled readers acquire their source before bounded task/report windows. The document RPC schema carries the dormant-journal marker and first-Play input digest with the projected summary.
- The open create/edit/delete editor lives in window memory per panel scope (`stores/mission-editor-state.ts`), never in the native view layout. A hidden project keeps it mounted and usable on return; when the panel unmounts (another right-panel tab) an idle editor stashes its draft and reopens with it, while one with a request in flight or held closes and settles through its creation/recurrence hold. Editor activity follows the live view: `lib/mission-view-fence.ts` captures guard one operation from capture to completion, never a component's lifetime.
- The Missions panel header (`components/mission-picker.tsx`, `styles/panels/mission-picker.css`) is two lines with one rule under the header, sticky at the top of the scrolling panel (`.mission-control-header`): a right-aligned toolbar ([+] create, then the panel's preferences gear and refresh), then the selection line. The selected item's icon toolbar mounts there through `MissionActionBar` and `MissionActionSlot`, followed by the always-shown **Filter missions** field; a narrow panel wraps the filter above the toolbar (`flex-wrap: wrap-reverse`). `MissionRows` uses the session list's row classes (`session-list-item`, `session-item-base`, `session-item-expander`, `session-item-select`, `session-item-title--clamp`): chevron, a flag (repeat icon for a schedule) coloured by its mark, then the title (`lib/mission-display.ts`); full state lives in the tooltip and screen-reader text. The filter always keeps the selected row. Selection uses `--list-item-highlight-*`; never use the input-field surface (`--surface-base`) as a panel or popup background.
- Flags and task icons share the session status palette (`mission-picker-model.ts`, `missionMark`/`unifiedScheduleMark`). A requested answer uses permission red; only a question the Mission can open reddens its flag. Observed work uses working yellow; interrupted and paused use warning orange. A Mission or schedule waiting for its scheduled run takes the hourglass in the accent blue. A completed Mission this window has not shown uses idle green (`markMissionsFinishedSeen` in `stores/mission-view-state.ts`), seeded from initial completion observations and marked seen only when shown in a focused window. Its per-project watermark on `finishSequence` retains unseen completions and individual acknowledgements within the layout bound; advancing that bound counts older completions as seen. A prepared Mission uses the palette's `--accent-primary`. Seen completed, failed, blocked and retired tasks stay neutral; active tasks pulse yellow, requested answers are red, unseen finished tasks are green, and tasks not started (assigned, ready, waiting on dependencies) use the accent. Never apply the accent to the chevron or reuse red for anything but a requested answer. Status words and icon shapes keep outcomes accessible independently of colour.
- A programmed Mission's row shows its launch's mark while a launch is under way. Between launches it shows `Hourglass` in opaque `--accent-primary` while its programming waits for the next wake, and `Pause` in warning orange while it is paused (`mission-programming-model.ts`).
- Row actions live in the header's selection line (`components/mission-action-bar.tsx`, `mission-selected-actions.tsx`): Play/Pause (coordinator recovery for an interrupted Mission and resumption of a failed one), Stop, the reader eye, Open conversation, delete and `ActionOverflowMenu`. Every action stays in place, disabled when inapplicable under its owner and H9 guards. Overflow order is request an update, interrupt now, Save configuration and edit; the trigger is disabled when all entries are disabled. Secondary actions such as the configuration name field stay at the top of the selected detail only while present. Command announcements and recovery actions belong to the persistent header; progress and errors join the primary button's tooltip instead of adding a line under the row. Retrying an unconfirmed control from the header ⟳ first reads its exact status, then resends only its still-unconfirmed original request/revision from that explicit click. Stop confirms first. Delete automatically submits once using the shared `missionDeleteSessions` preference frozen into that request; a failed or unconfirmed deletion retains its consumed automatic-submit state, original retry identity, option and error in the editor draft across remounts. Only explicit Retry continues that deletion. Shared contextual-help actions retain the shared help glyph, keyboard access and localized destination; opening help preserves selection, reader and editor state.
- The panel follows the session list. Its single selection is a Mission row or one task of that Mission (`selectedTask` in `stores/mission-view-state.ts`); only the selected row or task is highlighted (`.session-item-active`, `aria-current`), and selecting a row clears the task. Only the chevron (`SessionExpander`) expands or collapses. A Mission with known `MissionSummary.taskCount` zero, or a read map without tasks, uses the session list's spacer; an absent count retains the chevron. A programmed Mission always has its chevron, which selects it: its programming is in its detail before any task. Its context menu Mark as read acknowledges the row's unseen finished tasks and own unseen completion. `MissionRows` renders the selected detail once between its surrounding rows, preserving controls and retries through selection changes. Collapse hides that mounted detail; a selected Mission without tasks keeps its action-only detail visible. Expanded rows persist per occurrence in `expanded`, bounded by `MAX_EXPANDED`; a programmed Mission's chevron selects and expands it, while another unselected Mission's chevron expands its task preview without selecting it. Nothing is selected by default. Opening a conversation preserves the selected Mission/task.
- The detail (`components/mission-tracking.tsx`, `styles/panels/mission-detail.css`) holds secondary actions such as the configuration name field and the task tree; prose belongs in the central reader or info tips. `components/mission-task-tree.tsx` is THE task view: one session-list row per task (`.session-list-item`, `.session-item-base.session-item-nested`, one level deep), a status icon then title. `mission-graph.tsx` draws only declared `blockedBy` dependencies, completed and retired included, from measured status icons; never infer native ancestry. Lanes start under the Mission row's chevron at a fixed step; `--mission-graph-extra` increases row indentation when necessary. Clicking a task selects it; a correlated red request also opens its question. `missionTaskRowState` supplies both task-row state and the Mission chevron's `data-child-activity` priority: input, active, unseen finished task. A finished task stays green until selection, its icon button (`lib/toggle-sweep.ts` supports sweeping), or Mark as read acknowledges it. `stores/mission-task-seen.ts` retains the per-project first-use boundary, per-Mission Mark as read watermark and individually seen task versions.
- The header eye controls central-reader visibility independently of task selection and conversation navigation. Pressing it opens the selected row's overview or selected task's reader; while pressed, selecting another Mission or task follows that target, and releasing it closes the reader. Selecting a task with the eye off leaves the reader closed; Open conversation reaches its exact owned actor. A selected task owns the header toolbar (`components/mission-task-actions.tsx`), even with its reader closed: its primary action recovers its report when eligible, its eye toggles its reader and its conversation action keeps that task's target. The Mission's lifecycle/delete/overflow actions stay in place, disabled, with lifecycle state mounted. An unselected one-time Mission's task preview (`components/mission-task-preview.tsx`) reads its bounded map, pages and native task conversations only while expanded. `useMissionTaskSessionDemand` owns all task-conversation demand (selected tree, previews, open reader); collapse, hiding, owner changes and unmount release it. Remaining owners share a coalesced rerun; no owners fence the in-flight response and drop its queued rerun. Selecting a preview task selects it with its owning Mission.
- The tree follows §Task pages. Graph rows, activity and edges use keyed maps and remeasure rendered status icons when rows arrive, keeping large maps linear (`mission-panel-geometry.test.ts`). Graph styles live in `styles/panels/mission-graph.css`; shared cleanup-receipt row chrome lives in `components/mission-list-item.tsx` and `styles/panels/mission-list-item.css`.
- The overview reader (`components/mission-reader.tsx`) keeps the result/briefing/objective first and folds secondary material at its bottom through `components/mission-overview-details.tsx`: Plan changes, Reports (each opening its exact reader), conversation cleanup history and Technical details (mission/coordinator IDs and requested profiles), plus the pending coordinator-notification note. Task readers also keep identifiers in a collapsed Technical details. Only cleanup that needs an explicit retry stays in the panel. Task readers consolidate bounded brief/report/evidence pages with dependency navigation and existing truthful execution/profile/notification surfaces. Useful recursive delegation guidance propagates through canonical assignment prompts; native runtime permissions and configured depth remain authoritative, never an imposed target or a root-fallback trigger.
- Task readers put results before collapsed brief/technical details. Questions are only open native Forms/permissions: selecting a red Mission row or clicking a red task opens the exact asking conversation and focuses that request in its interruption dock (`onOpenActor`), like a session row; a task opens its question only for a correlated request (an actor's aggregate input activity alone, possibly an uncorrelated global request, only selects it); the panel never lists or answers questions itself; reported obstacles stay in the readers, and retired/replaced attempts never become current blockers. Tree statuses stay truthful: admission is only "Assigned", observed native activity alone is "Active", an observed native Form/permission is "Awaiting your input", unmet dependencies are "Waiting" and a reported blockage is "Blocked". Task navigation uses only exact owned non-coordinator actors, never a generic coordinator fallback or inferred bindings; the Mission's toolbar supplies the single coordinator link, and a selected task's toolbar its exact actor link. Uncertain sends are never replayed automatically.
- Archived and current remote reader numeric drafts use `components/mission-reader-number.tsx` and commit on Enter/blur, not the first digit. Keep existing toolbar DOM mounted during same-source reads; local in-memory reader pagination stays immediate. A programmed Mission's past-run list lives in `styles/panels/mission-detail.css`.
- Coordinators publish project briefings automatically at business milestones (initial plan, each task settlement, waiting on a human, before the final report) with requestID `auto:<revision>` and plain user-facing summaries (`missions/recipes.ts`); briefings come only from these milestones and explicit requests. An explicit update request is `createMissionBriefingRequest` in `components/mission-briefing.tsx` ("Request an update" in the selected toolbar's overflow menu; its pending/uncertain feedback joins the primary button's tooltip, with announcements and recovery actions in the persistent header). Full briefing/final prose and task sources belong in the central `MissionReader`, opened/hidden with the toolbar's eye. The fixed request follows `lib/mission-coordinator-message.ts` through ordinary native admission. Match its exact request ID before acknowledging a received briefing, retain pending/uncertain state by identity, and never replay it automatically. The coordinator-only `missions/briefing.ts` contract records a bounded narrative with assessed revision and exact task sources, separate from observed activity/task settlement/final outcome. Show stale-map/new-result notices and source readers in the reader without inventing semantic updates or human requests. For existing missions without a briefing, expose bounded exact current results/obstacles in the overview reader and use the tree for the remaining plan. Mission rows say "In progress" for an open mission (its lifecycle state); never show declared task counts as progress. Terminal missions omit settled lifecycle actions but retain unresolved control receipts. Project cleanup uses one disclosure for pending and settled receipts.
- Mission display demand follows the actual right-panel visibility and selected tab. Preserve cached snapshots while hidden, cancel queued trailing display reads, and revalidate on activation. A component that shows a one-time Mission's full map registers it with `missionStore.want` and releases it on cleanup; never read `state().missions` for a row, which holds only open and wanted maps. Only native lifecycle events (`session.execution.*`, compaction, inbox, Shell, Form and permission events) invalidate activity; text/tool-progress deltas never do. Activity reads start at least 5 seconds after the previous read settled, journal changes (`rpc.codenomad.missions.changed`) at least `MISSION_URGENT_REFRESH_INTERVAL_MS` (1.5 seconds) after it (`stores/missions.ts`); activation and explicit refreshes read at once. Store publications share every part equal to the previous state (`lib/structural-share.ts`), so keyed lists and memos update only the missions, rows and activity entries that changed. Explicit recovery reuses the selected Mission's primary toolbar action and, while a task's reader is open, that task's report recovery as the toolbar's primary action, both through `createMissionRecoveryAction`; never add a separate administration surface or an automatic mutation retry. A value the panel learns from a read, such as the list's reported project, enters a view-fence identity through `createReportedChanges` (`lib/mission-view-fence.ts`), per instance and Location. A first report that matches the project the instance metadata names, or arrives while none is known, is the view already shown, so an operation captured before the first list read (a creation submitted right after the panel opens) still completes. A first report naming another project, and any later different report, is another view.
- Missions preferences live in the Settings/Preferences window's Missions section (`components/settings/missions-settings-section.tsx`); the Missions panel header gear deep-links there via `openSettings("missions")`. `stores/settings-screen.ts` is the single Settings route for every entry point: local Electron/Tauri windows always reuse/focus the one native Preferences window with the active instance/Location; only browser and remote windows use the embedded screen. A native rejection (e.g. an installed host lacking the section, which needs a native rebuild) shows an error notification and never opens a second, embedded Settings surface. Keep the section allowlist identical across renderer, Electron and Tauri (`native-mission-preferences.test.ts`). Project-scoped parts (catalog, Location depth) use the opener's instance/Location and stay disabled without one. `components/mission-preferences.tsx` writes each choice at once, compare-and-swapped against the value stored at its turn. Edits made during a write stay enabled (disabling a control drops its keyboard focus) and queue behind it, shown immediately, across window/section remounts. Each edit touches one role or the task-session policy of one scope and is refused when that stored value is no longer the one it was made from, so a queued edit never overwrites another window's change to that value or resends a rejected edit of it. (Customizing an inherited role copies the global values shown at edit time.) A rejected or unconfirmed write is never resent: a read-only reload shows the stored values, with Reload offered only when that read fails or the document is unreadable. The fold's Reset (confirmed) clears only the shown scope's agents/models; resetting an unreadable document is a separate confirmed repair. Catalog/depth demand stays fenced by that section's visibility.
- Agent/model choices use one `MissionProfileControls` row per role everywhere (coordinator, then the type's roles, Debugging included). In a mission-type scope, rows show the inherited global values with a muted Global mark; editing a field customizes the role starting from those values, its revert icon inherits again, and an all-native choice remains an explicit override (inherit, native default and a selected profile stay distinct). Creation waits for loaded preferences and shows requested choices in directly visible compact rows. Profiles use compact square native selectors in `components/mission-profile-controls.tsx`; preference/profile/library layout lives in `styles/panels/mission-preferences.css`. Model selects list exactly what the conversation's model selector lists: the shared catalog build and display names (`lib/model-catalog.ts` `buildProviderCatalog`, also behind the composer's providers store) and its hidden-model/favorites-only list (`stores/model-picker.ts` `preferredModelList`), restricted to tool-capable models and grouped by provider; never filter or label models separately. A saved model outside that list stays selected (by name when known, marked Unavailable when the selector's usable catalog lacks it: missing, deprecated or without tool support) so a default never changes silently; stored values remain `providerID`/`id`. Summaries with an `instanceId` and catalog `directory` name models through `knownModelName`, never a catalog read: the newer of the conversation catalog and that Location's latest Missions read in the same native generation (an omitted directory is the workspace root, compared with `normalizeSessionDirectory`); technical details keep exact IDs.
- Saved configurations are bounded version-1 records under existing owned UI preferences (`lib/mission-model-library.ts`), with their stored schema keys retained. Creation shows one configuration select first, loading on selection and prefilling a sensible title from its existing `name` (Remove/Reload in its small `…` overflow), and a footer Save configuration bookmark icon that asks for a name inline (`components/mission-model-library.tsx`, styles in `styles/panels/mission-create.css`); only Preferences keeps the full library manager and invalid-library repair. A selected one-time Mission, including a finished one, offers "Save configuration" in its toolbar's overflow menu (`MissionActionBar` `saveBrief`, opening `MissionBriefSave`'s name field through its `trigger` in the detail's secondary row, after unfolding a folded selection through `MissionRows` `revealDetail`; closing the field by Escape, Cancel or a save returns focus to the menu's trigger): `missionRecordedBrief` copies only its recorded objective, verbatim notes, template, frozen profiles and taskMode (the title prefills the name). Loading copies into ordinary manual creation; delete preserves all executions, and arrays retain config merge-patch replacement semantics. Preserve exact choices in uncertain creation drafts. Defaults never silently reconfigure existing/busy actors.
- Delegation defaults apply per new Mission (`taskMode`, omitted means native); changing defaults or saved configurations preserves existing Missions. `mission-task-mode-controls.tsx` shares its compact native selector between preferences and the editor. Task agents use subagent/all in native mode and primary/all in independent mode; coordinators always use primary/all. Retain the policy with the creation/defaults snapshot and uncertain request identity, and preserve it in explicitly selected saved configurations. Explicit document edits may change task mode before admission or between eligible recurring passages under H9; admitted work keeps its frozen policy. Never change OpenCode configuration through task-mode selection. Ordinary internal helper calls remain governed by native permissions/depth.
- Saving a configuration under an existing name confirms replacement by ID against the library snapshot captured before confirmation. When saving under the name of a configuration loaded into or saved from the current draft, the write stays bound to that entry's ID and baseline record: if that entry changed, was renamed or was deleted since then, saving reports a conflict instead of selecting another entry or overwriting. Confirmed saves record their baseline on the originating draft identity even while the editor is hidden or awaiting remount, without stealing focus or retargeting a replaced draft. With duplicate names, only a configuration loaded into or saved from the current draft may be replaced. Replacement is available at the library limit; a new name adds a separate record when space is available.
- Delegation's native depth editor (`mission-subagent-depth.tsx`) is separately Location/project scoped and affects all OpenCode conversations there, unlike global new-mission defaults. It is one row, a label and a menu, like Task sessions (in the creation form, a row of the Delegation group): Inherit, naming the inherited depth while no project override is set, then 1 to 10 within the capability's maximum (a saved value outside that range stays listed); while an empty project `experimental` block hides the inherited depth, the menu shows OpenCode's default, which Inherit repairs. Everything else lives in the row's single info tip, one part per line, paths isolated left-to-right: the scope; the rule that an override also lets subagents launch their own subagents in the project, taking precedence over General's restrictions from other config files; the effective depth; whether General subagents can nest per the snapshot (no subagent at all when the tool is hidden; no other General subagent when only General is denied, other agents following their permissions) or that OpenCode's depth limit stops nesting below 2, never claiming nesting OpenCode would not allow; the project write target and the effective block's origin. Never add prose under the row: only actionable alerts (the depth-only save warning, read and write errors with the refresh icon) and the unsupported-contract status show there, and the saving and saved states are announced to assistive technology only. Demand only while the Preferences window's Missions section or the creation form shows it, retain unconfirmed choices and exact file expectations by instance/directory, and never invent an unknown effective depth or label zero as disabled. Choosing a value writes it at once without reload/restart. A write acknowledged after the view was left or hidden is accepted and reread on the next activation. Reads and writes lock the menu with `aria-disabled` rather than `disabled`, preserving focus; the latest choice made meanwhile (a native closed select's arrow keys change it step by step) stays shown with the depth it was chosen against (the value being written, during a save) and is written against the next settled read's expectation only when that read shows the same depth, never an intermediate one; another writer's depth, an error or an unconfirmed write drops it. In Preferences the row stays one line at every width. The refresh icon appears only after an error or an unconfirmed write; uncertain writes remain fenced until that explicit refresh and are never replayed automatically.
- The Missions panel is the only scroller (`styles/panels/mission-task-tree.css`) and containing block (`position: relative`) of its absolute descendants (screen-reader labels, the dependency overlay); the creation form's scrolling body is likewise positioned (`styles/panels/mission-create.css`). Never remove either containing block. The sticky header's measured height (`--mission-header-height`) gives content its scroll margin; while creating and below 400px height the header scrolls away. Keep the stable scrollbar gutter and IME composition keys in the filter.
- Task rows use the session list's `virtua/solid` Virtualizer with the panel as their external scroll owner. `mission-virtual-viewport.ts` measures the start margin through preceding layout changes and zoom. Keep the selected/focused task mounted; other offscreen DOM rows are disposable, while their data pages remain in `mission-task-pages.ts`. Graph endpoints use the virtualizer's cached offsets/sizes for offscreen tasks and measured icon edges for the rail axis; unchanged coordinates and existing edge keys preserve rail nodes. Task continuation is automatic near its sentinel, with explicit Retry only after failure. Exclude that moving sentinel from browser scroll anchoring. Never repair task-tree scrolling to an old focused row after an asynchronous page or graph update. Viewport resize repair requires previously visible, connected focus in an active focused document, with CSS visibility, opacity, inert and ARIA-hidden guards; wheel input cancels its pending scroll adjustment. Keyed row moves share `lib/preserve-list-focus.ts` with SessionList and MissionRows: connected controls regain focus with `preventScroll`, respecting later user focus intent and hidden/inert surfaces. Creation alone uses `mission-panel-scroll.ts` to keep a form control clear of its footer. Validate native wheel scrolling, loaded-page reuse, rail identity, RTL/zoom and keyboard focus with the real components.
- Directory continuation (`components/mission-list-paging.tsx`) is one automatic sentinel outside all task trees, shared by mission summaries and native schedules; it has no normal paging button or information icon. Read marks one bounded 16-mission window at a time only far enough to cover the loaded summary rows, under visible-panel demand. Hidden/covered trees stop that demand; a failed window parks until the directory's single Retry invokes its exact recovery. Actor-detail and persisted-field windows retain their separate explicit controls. Directory extension adds rows without dropping its earlier pages or changing the task selection.
- One-time Missions ships through `DesktopPluginLifecycle("missions")` and backend presence, with project-scoped native storage. Every backend that publishes its loopback bridge provisions it, desktop or standalone. Bridge registrations name only `http://127.0.0.1`: the bridge reuses the HTTP listener only when bound to 127.0.0.1/0.0.0.0 (`acceptsIpv4Loopback`), otherwise (HTTP not requested, IPv6/`localhost`/LAN HTTP-only) it gets an unannounced private listener on a random 127.0.0.1 port. All listeners of one backend share a single `WorktreeDeletionFence` (with its mission holds), so a deletion through HTTPS drains bridge admissions. Window/browser automation stays desktop-only; without a desktop host the bridge's `browser-claim` answers only `purpose: "mission"`. The Missions snapshot distinguishes `host-unavailable` (no bridge, answered without reading OpenCode), `plugin-unavailable` (OpenCode has not loaded it) and `plugin-failed`; never tell users to reconnect CodeNomad for a plugin OpenCode must load. Keep roles independent of native execution IDs. Persist explicit agent/model/variant selections and never switch a busy actor for a queued task. Preserve authenticated admission, ownership/connection/worktree fences and per-send profile environment whenever a backend owns the coordinator; pass an `unowned` effect to `sendMissionInput` only for effects the plugin's public session API performs completely. One-time map update/control/delete/recovery routes share `server/routes/mission-map-mutation.ts`: creation's fenced connection and worktree-deletion admission, a fresh workspace/connection/location recheck after all preparation, and the permit held through the single unretried RPC. Validate one-time behavior with the isolated `scripts/test-missions-native.mjs` fixture.
- One-time Missions use the journal `codenomad-missions/v2` with wire/schema version 1 and its one-time receipts. Never read, import, mutate, delete or initialize the `codenomad-missions/authority-*` namespaces, register a managed-owner observer, add `migrateLegacy` or add migration UI (`desktop-plugin.test.ts` traps that namespace access; `managed-owner-plugin.test.ts` keeps the managed-owner observer and authority modules out of the bundle).
- `packages/server/src/host-lifetime/` holds the private-storage, process-identity and profile-scope primitives Missions uses (`storage`, `private-storage-sync`, `windows-storage`, `process-identity`, `protocol`); never add a persistent CodeNomad backend host to it. Never replace a native ownership gate with a no-op or environment flag, steal a live/unknown owner, log secrets, or include the shared OpenCode daemon in backend cleanup.
- One-time lifecycle state and actions live in `createMissionLifecycle` (`components/mission-lifecycle-controls.tsx`), surfaced only as the toolbar's primary action and Stop, with Check status for an unresolved request; a read showing that exact request saved with nothing pending settles it without a resend, while its absence never does; family interruption lives in `missions/native-family-interrupt.ts` and follows Explicit execution controls above (`readNativeControlFamily`, never the 32-session display read; never claim a full stop without a complete `descendants` receipt). Do not turn notification recovery into a control-action runner.
