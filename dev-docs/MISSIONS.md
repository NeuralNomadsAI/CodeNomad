# CodeNomad Missions / Session Mesh

Missions coordinate native OpenCode V2 work through a durable project map,
dependency-aware tasks, human controls and readable results. OpenCode owns execution;
Missions gives the user a coherent way to specify, follow and reuse that work.

Native integration boundaries, private Core service shapes and per-invocation
lifetime requirements: [Missions native contracts](MISSIONS_NATIVE_CONTRACTS.md).

Recurring passages run in the OpenCode service with CodeNomad closed; never run them
through a persistent CodeNomad backend. Native qualification: §Validation and
`MISSIONS_RECURRING_QUALIFICATION.md`.

Unified native schedule controls and passage admission are described in
[Recurring Missions](MISSIONS_RECURRING.md#unified-native-schedules). Their technical
schedule RPC and business bridge stay registered independently of desktop presence.
The calendar owner shares project document exclusion with admission and controls;
the execution journal retains its task, report and lifecycle contracts.

## Ownership

| Concern | Owner |
| --- | --- |
| Root sessions, prompts, durable inbox, execution, Forms, permissions | OpenCode V2 |
| Mission map and role context | Bundled `codenomad.missions` plugin; project-scoped native storage |
| Workspace/location authorization and browser access | CodeNomad |
| Checkout isolation and Git policy | Existing CodeNomad worktree/Git modules |
| Developer feedback | Separate `codenomad.automation` plugin and its visible-session fence |

The plugin exposes `mission.inspect`, `mission.delegate`, `mission.revise`,
`mission.report`, `mission.briefing`, `mission.interrupt` and `mission.prepare`.
The coordinator is the topology writer.
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
registration, 32 MiB counting each body as UTF-16 code units (the digest's encoding):
the current-passage reader's bound for one display read's journal in this process; the
largest accepted receipt shape (200 conversations of 64 descendants, 240-character IDs)
counts about 6 MB with plain IDs, so several of those, or dozens of ordinary ones, stay
held. Beyond it the least recently held or read receipts go first, with their slots; a
receipt larger than the whole budget (possible when its IDs need heavy JSON escaping)
is never held, so its marker is refused from the first read, and disposal or a reload releases
them all. Receipts outlive their mission's deletion, which runs in the separately
registered RPC plugin: a deleted mission's coordinator may still read its own receipt
until the budget, a replacement or a reload removes it. A read the plugin no
longer holds is refused, never answered by replaying or re-observing the interruption.
Only `mission.inspect` returns the full map. Every `mission.inspect` result,
as the tool serializes it (two-space indented JSON, page metadata and markers
included), stays within 100,000 characters (`missions/inspect-view.ts`), and nothing
it leaves out is lost: a value a result cannot hold is replaced by
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
owned-root checks alone (`MissionControl.ownedRoot`, no mission or journal read), so an
owned root without a mission pages a large catalog too, and a failing mission journal
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
`mission.inspect({ list: true })` pages its missions the same way (`listOffset`,
`listPage.nextListOffset`). `mission.inspect({ taskKey })`
rereads one task with its contract, exact current assignment prompt and every report
of that task, each once, its largest values replaced the same way. A native
Wayfinder `decision` declaration also states how the coordinator settles it
(`WAYFINDER_DECISION_REQUIREMENT`), the rule `settleDecision` enforces (§Human
questions and decisions).

Coordinator actions that need native reads or effects outside the plugin's
Promise API cross the authenticated desktop bridge (`sendMissionInput`, fixed error
codes in `missions/recovery-error.ts`), so they work only with backend presence and
refuse otherwise. Only one-time coordinators are offered and told about
`mission.interrupt` and `mission.prepare`.

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
- `mission.prepare` creates a paused one-time hand-off through the same
  `prepareMissionCreation` pipeline, holds and fences as the editor, at the
  coordinator's Location. It never starts. The trusted `preparedBy`
  (`{ missionId, coordinatorSessionId }`) gives that coordinator read-only
  visibility (`inspect({ missionID })`, `inspect({ list: true })`), never control.
  The requestID is scoped to the coordinator and mission. A retry first reads the
  journal's creation event and returns the saved mission (or a conflict) without
  another backend call; a held uncertain attempt is reported uncertain, never as
  nothing created.

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
using the coordinator's model by default. Creation warns if the judge matches A/B.
Version-1 `comparison` contains completed A/B `runRefs`, both scores (0–10) per
criterion, evidence for each observation and `a`/`b`/`equivalent`/`inconclusive`.
Current and archived readers show the verdict, model names and criterion scores.
Blinding is an instruction and data-presentation policy.
Native proof: `node scripts/test-missions-native-trajectory.mjs <CLI>`.

## Durability and recovery

Only the coordinator's final report finalizes a mission, even when every declared
task is complete; empty plan history is omitted. A one-time mission finishes only as
completed (`completedFinalOnly` on the plugin's `MissionControl`, the
`COMPLETED_FINAL_ONLY` instruction), and only the human stops a mission: when
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

### Defaults, reusable briefs and separate executions

A missing requested profile never authorizes an unrelated replacement; identical
requested profiles are summarized together without a catalog read. A saved brief
(version 1) holds only its name, objective, notes, template, optional requested
profiles and optional taskMode.

### User-journey regression checks

`components/mission-scheduling.tsx` supplies controlled, initially folded scheduling
fields. Its owner supplies the draft, a frozen prospective Play instant, native
project source choices, capability state and the document's structural lock reason.
Every draft change emits either a valid `MissionLaunchPolicy` or `undefined`;
missing source coverage retains the draft and invalidates its policy. Calendar
previews share `missions/mission-calendar-preview.ts` with native calendar planning.
For persisted Every phases and live next-wake display, read the native schedule rows.
The owning editor retains revision/request fencing and performs authenticated writes.

`mission-editor.tsx` shares its preparation form between Create and Edit. Calendar-owned
documents open through `MissionEditorAction.scheduleID`, read their exact configuration
and retain the loaded document revision in `MissionEditorDraft`. Title, instructions,
notes, playbook, requested agent/model/variant profiles, task mode, followed inputs and
scheduling use the same controls. Structural/template guards and their explanations
come from the document; incomplete native observation also fences editing. The
execution-journal format exposes objective/notes edits. A unified immediate preparation
also edits title, playbook, requested profiles and task mode before its first admission.
Before first Play, that journal-bound preparation also converts between immediate,
delayed, recurring and conditional policies under its original preparation intent.
Its immutable creation binding stays attached; calendar ownership makes the empty
journal dormant and hides its panel row. Returning to immediate restores that row.
Calendar deletion retires the exact dormant journal revision before document compaction.
Returning to immediate keeps followed conversations. First Play freezes their bounded
stable prefix with the shared native source reader and launch envelope; unavailable,
moved, excluded or over-capacity sources block with an explanation. The original
first-Play intent retains this text across acknowledgement loss and exact retries.
Stored execution roots outside the editor's single directory-only scope stay read-only.
Create stores a paused immediate Mission or a paused calendar-owned document.

H9 editing uses the document projection and the mutator's fresh guards:

| Document state | Editable configuration |
| --- | --- |
| Before first launch, with complete observation and no unresolved intent | Title, objective, notes, profiles, task mode, sources, timing and limits; template while no task has ever been created. |
| Between recurring passages, paused or running, with no pending passage/wake/control | Future-passage configuration under the same structural guard. An armed calendar reconciles its replacement before admission; a paused document stays paused. |
| Admitted passage, or an already launched one-time preparation | Objective and notes through the recorded text-edit contract; admitted inputs, profiles, task briefs and identities stay frozen. |
| Uncertain admission/control, incomplete integrity evidence, or terminal document | Read-only until its owning reconciliation/recovery permits editing. |

The template lock survives completed and retired tasks. Structural edits preserve
history, source checkpoints, launched count and first-Play origin. Configuration
and temporal generations advance independently; unchanged timing/end groups retain
their phase and absolute end. Editor reopen restores the loaded draft; conflict
reload and original-receipt reconciliation keep their contracts below.

Editor drafts retain decoded stored-policy metadata, frozen preview time and the loaded
baseline through panel remounts. Saved delays retain their absolute one-shot instant;
Every previews use the current native next slot's phase, with first-Play end bounds
and consumed launch quota retained. A paused or unknown interval phase stays explicitly
unavailable. An explicit conflict reload adopts the current configuration and keeps one
comparison containing only the preceding user fields. Refreshing observation at the same revision
preserves those editable fields.

`stores/mission-schedule-editor-holds.ts` retains serialized create/configure/journal-edit
intent and its exact draft before dispatch. Transport loss and incomplete replies keep
that identity across mountings. Explicit receipt refresh performs reads only; a matching
complete original receipt releases the hold. A journal edit's retained history entry
includes its `requestID`, revision and accepted text; unified text also requires a matching
document read. Missing/evicted evidence keeps the hold. Never resend a held edit or
creation automatically, and never use a negative read as permission for another identity.
Journal editor reloads and retained edit receipts resolve objective/notes through
content reads pinned to the display map's body descriptors. Plan-change reads name
the original revision and compare its accepted text; unified receipt confirmation
also compares the document with those exact journal bodies. Missing or changed
content retains the hold. Calendar-owned editor prefill uses the schedule read.
Editor reads and the body display cache share only the pure wire-slice validator
(`lib/mission-content-slice.ts`); editor receipt checks fetch their own exact,
descriptor-pinned content independently of the display cache.
For a journal-bound preparation, an exact positive partial receipt exposes **Try again**.
That explicit action rereads the original receipt and resumes only its retained
configure request, payload and revision. Remounts retain uncertainty and require
another positive read before offering that retry.

Source choices use explicit project pages on demand. Schedule documents page by eight;
conversation choices use native session pages, and local branch choices use the owned
directory's bounded local ref listing (`GET /api/workspaces/:id/git-branches`, at most
200 refs under `refs/heads/`, including branches without a worktree). The read uses
the Git worker, a ten-second/output bound and physical ownership/deletion fences;
over-bound inventories expose source unavailability. Never fetch for source choices.
Choosing a source or typing another field preserves the loaded page.
Further pages require an explicit action.

`stores/mission-schedules.ts` owns the visible panel's bounded document pages, with
one read lane and coalesced trailing refreshes through the shared event scheduler.
Explicit Load more adds one page; refresh revalidates the loaded page frontier.
The selected object also receives a point read. Project, directory, client and
native generation fence publication; hidden views retain their display and read
again on activation. The picker merges calendar-owned documents by Mission ID,
with journal-owned immediate Missions and daily entries keeping their owning controls.
Selection retains the unified Mission ID across immediate/calendar conversions observed
from another window. A positive document read selects its owning representation;
the selected unified object retains point-read demand beyond the loaded document page.

`components/mission-schedule-list.tsx` shows saved frequency/source, desired and
observed calendar states, native next wake/check, slot end, tracked source checks,
global launched quota, successes and retained history. Civil times use the saved
zone. Each history entry opens its retained native coordinator; the selected pending
passage exposes its conversation. The overview toggle reveals saved instructions.

`components/mission-schedule-controls.ts` retains every dispatched control or
settings-activation request across panel remounts in per-window memory, bounded to
128 unresolved objects. Exact positive receipts release a hold; pending deletion
retains a visible row even after its inventory entry disappears. Refresh saved
request performs reads only. An explicit Check may follow a positively read partial
control; both request identities remain retained until their exact receipts settle.
Never resend from reconnect, remount, display refresh or an unavailable/negative read.
Revision preflight refuses a stale click before dispatch. Controls retain the
last capability display during same-owner revalidation, so a passive
refresh preserves an in-flight pointer click; control dispatch rereads capability.
`MissionActionBar` retains its primary glyph for an unchanged action key, preserving
the native pointer target while a fresh action object updates its other fields.
Play and Resume use informed native activation. Run now requires an enabled
effective native setting, with an explicit disabled explanation and a fresh
capability check before reservation. Its click preserves settings activation.
First native activation
asks for confirmation with the exact configuration paths; an uncertain activation
keeps Play unsent, and receipt reconciliation leaves the next Play explicit.

`mission-scheduling-decode.ts` reconstructs the controlled draft from a validated
stored policy. Exact cron equivalence selects daily/weekday/monthly controls;
other single expressions stay advanced. Each unchanged timing, condition and end
group retains its original representation, so editing a quota or source preserves
the native temporal generation. Multi-zone/richer multi calendars and precision
beyond the controls stay in an explicit retained-policy view, with a deliberate
full-policy replacement action. A branch bound to another directory keeps its
identity visible and blocks submission. Validation errors open the disclosure.

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
while the creation form and the saved-brief library keep their explicit Reload.
Earlier GETs/ACKs never substitute stale cached defaults as authoritative creation input.

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

Report persistence and coordinator notification are separate steps. A saved `task.reported` without a matching `report.notified` acknowledgement is a pending notification. Active plugin instances recover these notifications on activation and retry with bounded backoff through the same authenticated bridge. They reuse the deterministic native message ID, skip acknowledged reports and prepared/paused/terminal/deleted missions or incomplete native control actions, and stop recovery when disposed. This outbox only delivers already-written reports; it never dispatches tasks or chooses a workflow transition. The snapshot exposes `report.notificationStatus` (`pending` or `admitted`), and Mission Control shows pending notification delivery separately from task completion.

Once a report is saved, the report call succeeds even when its notification fails or the admission acknowledgement is lost. Failed journal persistence fails the call and sends nothing. A report from an actor moved out of its exact admitted location is rejected. Reports arriving after terminal Stop are preserved as late evidence without completing withdrawn tasks, reopening the mission or waking its coordinator.

### Targeted recovery

`POST /api/workspaces/:id/missions/:missionID/recover` brokers only the typed `recover` RPC (`missions/recovery-input.ts`, `missions/native-recovery-observation.ts`), with `{ expectedRevision, target: "coordinator" | "report", taskKey? }`. This explicit intervention derives one deterministic native synthetic message identity from the existing mission revision and target; it never replays an assignment. Report recovery requires an existing unresolved admitted task; coordinator recovery references the saved map and reports. Paused, prepared, terminal and pending-control missions reject recovery, except that coordinator recovery resumes a failed mission: under the mutation lock it first appends `mission.reopened` at the exact revision the user saw, `already-member` when one of its sessions has since joined another active mission, as at creation (the reducer resumes only a failure, drops its summary and lets a later Stop end the mission), then nudges the coordinator at the new revision. A later finish uses a revision-bound event identity.

The authenticated owning backend reconciles saved actor locations and checks native activity, bounded descendant inboxes and inventory, uncorrelated running Shells and applicable (including global) Forms and permissions before preparation and again after applying the fresh full profile environment. Recovery never changes the plan. Incomplete/failed reads fail closed; unknown Shell ownership and running descendants block the nudge. The bridge exposes only fixed, redacted recovery error codes. The response `admitted: true` acknowledges admission only. These bounded checks are separate reads, so native state can change between them, and recovery cancels nothing.

### Snapshots, journal locking and map routes

Snapshots are authoritative reconstructions of the journal. RPC events are only invalidations; the UI always reloads its list after reconnect because native event subscriptions are live-only.

**Panel reads** (`missions/mission-summary.ts`, `MissionControl.list`/`mission`, `server/routes/missions.ts`). The panel never loads every full map. The read-mostly `list({ include?, summariesVersion? })` RPC takes the open missions (`openIDs()`) plus at most four `include` IDs, re-reads each range with `missionView`, and returns their compact maps (§Compact maps) stamped with the project damage flags, one `MissionSummary` row per live map in snapshot order (id, title, objective label of 502 code points with whitespace runs collapsed and a newline kept, enough for the row title, status, runState, coordinator and actor session IDs, updatedAt, a finished map's `finishSequence`, revision; rows of re-read ranges come from their fresh maps, and an included map the hints missed gets its row), the hints' cleanup history and discarded count, and `summariesVersion`, a content hash of the rows; `summaries` is omitted when the caller sent that version. The `mission({ missionID })` RPC returns one range's compact map (absent when it holds no live map), that range's own cleanups and the project flags. Both are hints-based reads (§Journal index): rows and cleanup history can miss a foreign write until the rebuild, while included and open maps are read from storage on every call; neither authorizes anything, and every write keeps its authoritative read in the plugin. `GET /api/workspaces/:id/missions?include=<id,…>&summaries=<version>` brokers `list` and projects activity over the returned maps only; `GET /api/workspaces/:id/missions/:missionID` brokers `mission` for display reconciliation (the editor's lost-acknowledgement checks, cleanup retries). `GET /api/workspaces/:id/missions/:missionID/admission` answers the same shape from the full `snapshot` RPC, its map full: the admission read of an application-authored native prompt (the coordinator message), which hints must never authorize. The list and single routes compact the maps they return too (`compactMissionReads`, `compactMissionMap`), since a reload can briefly pair this backend with an older plugin that returns full maps, with or without descriptors (§Compact maps); the admission route never does. A plugin build without `list` (`rpc.method_not_found`) answers `plugin-unavailable`: its only other read, the snapshot, carries every full map, which the panel never loads. A plugin without `mission` answers the single read from its snapshot, that one map compacted; any other RPC failure stays a failure. Bridge routes (assignment, report, lifecycle, prepare, root creation, task conversations) keep the full `snapshot`: they authorize native effects. The UI store (`stores/mission-store.ts`) keeps compact maps (`missions`) and rows (`summaries`; derived from the maps of a list without summaries, which carries every map). Consumers register the maps they need with `want(instanceId, owner, missionID)`: the selected Mission (MissionControl) and the central reader. Includes and the held version are sent only once the backend has answered with a `summariesVersion`, so the first read after a load sends none; a wanted row still without its map, or a newly wanted one, schedules one coalesced follow-up read. `want` and the reads it starts run untracked, and components register through a memo of the target ID only, so store publications never re-run a registration; a mission already asked for by the read in flight starts nothing, and a failed read stays parked until new demand, an invalidation or an explicit refresh. Publication keeps the generation fence and trailing coalescing: when the wanted set changed while a read ran, the maps (and their activity) of rows wanted now that the read neither asked for nor returned stay from the last good display, and one follow-up reads the current includes unless a deactivation (`setDemand(false)`) happened while the read ran, in which case activation reads them; a reader's want needs no panel demand; an omitted list repeats the version this read sent, else the read fails and keeps the last good display. Picker rows, marks, completion seeding, empty states and the reader's absence check use the rows; the selected detail, Needs you, the task tree and the readers use the compact maps, and a selected row waits for its map with a loading line, which a parked failed read replaces with the stale banner and the refresh button. A closed row's permission mark counts open native requests of its declared actors; observed-family members count only for open and wanted missions.

**Body reads** (`missions/mission-content.ts`, `MissionControl.content`). The read-mostly `content({ missionID, kind, field, taskKey | reportId | change, digest?, offset })` RPC returns one mission body for display in slices, from one `missionView` read of that mission's range alone (never the index or another range). Its selector names a value in the live map: a map field (`kind: "mission"`), a task's own field or its `reports` (`task`, `taskKey`), any report by ID, current, earlier or late, never the task's current one in its place (`report`, `reportId`), or a plan change's field by revision (`change`), among every change the same observation's events record (`missionPlanChanges`, the reducer's own changes, of which the map's `history` keeps the last 50), never the nearest or a newer one. The answer carries the map's `revision` and a slice: the string itself or the value's JSON (`json`), `characters`, `digest` (the inspect digest: SHA-256 of the UTF-16 code units) and `next`, the following slice's offset; each answer, as two-space JSON, stays within the inspect bound of 100,000 characters (`sliceEnd`). A first read starts at offset 0 without a digest; every later slice repeats it and is refused (`content-changed`) once the value reads differently, while revisions that leave the value alone keep its slices valid. `mission-not-found` and `content-not-found` answer the rest; a later slice without its digest or a selector naming another kind's identity is invalid input. `GET /api/workspaces/:id/missions/:missionID/content?kind&field&taskKey|reportId|change&digest&offset` brokers it with the list's ownership, plugin and project checks; a plugin without the method answers `plugin-unavailable`, never another read in its place. It is a display read: never a write's or admission's authority. Its wire types live in `missions/mission-content-wire.ts`, which the UI imports.

**Body display** (UI `stores/mission-content-store.ts`, `stores/mission-content.ts`, `lib/mission-body-pages.ts`, `components/mission-reader-body.tsx`, `components/mission-report-prose.tsx`). One-time Mission readers show their bodies through the content route, never the map's copy: the overview (summary, objective, notes, briefing, recorded results and obstacles), task readers (brief, independent explanation, current, earlier and late reports, the coordinator's readout, artifacts), report readers, plan changes (reason, objective and notes pairs, and the tasks they added, retired and rewired), the Compare and decision readouts, the edit form's objective and notes, and Save as brief's recorded objective and notes. Admitted passages keep their own map and archived pages. The display cache keys each body by workspace, project, mission and selector, and every continuation by the digest of the first slice it extends; another instance connection, folder or native generation starts a new entry. Bodies a reader shows are read slice by slice only as far as the shown page needs (`missionBodyNeed`: through the page end and the rest of its final line, which `missionMarkdownPage` reads, so a page from a prefix is exactly the whole text's page) or whole for Copy; lists, artifacts, briefings and plan-change pairs are read whole, which their 20,000-character bounds keep within a few slices; a plan change's task lists and a task's every report (the task reader's Show all) are read whole too, in as many slices as they take. A task's current result is read as that task's own `report` and a late return from its `lateReports`, the copies `missionReports` prefers to the mission's history copy; other reports read by ID. Readers of one body share one read at a time; demand during a read is served when it settles, and nothing polls. Each reader passes its map's descriptor of the body (§Compact maps) with the revision it is expected at (`missionBodySource`): the map's, or for a body of a row or report read further, the revision of the page that answered it when later (`missionBodyRevision`), so an answer older than that page never stands for its descriptor; the map's own fields keep the map's revision. The newest map wins. A task's history that an older plugin's compact row describes by no descriptor carries a mark instead (`missionHistoryMark`: the row's report count and newest report): the content store reads a body held, or supersedes a read sent, under another mark (`version`), never inferring a digest from excerpts. A shown body is read again only when that descriptor names another digest, so unrelated revisions (task declarations, other bodies' edits) read no unchanged body; a map naming no descriptor of the body expects nothing. Sections, disclosures and lists answer presence from descriptors (`lib/mission-bodies.ts` `missionBodyPresent`, `missionReportHas`: a text with characters, a list with items, which is more than its two JSON brackets, any other value; a report's from the mission's own `reports`, which hold its rows' reports and those a read further named, §Task pages) and take labels from the compact map's excerpts and `decidedBy`; a briefing's summary shows (reading) until the briefing is read whole, its other sections then when they have items. A passage's full map answers presence, labels and values from itself (`missionOwnBody`). A first answer older than the map that names its body is read again, within the restart bound. `plugin.updated`, a reconnect and a new event stream mark every shown body of the instance (or all) stale and advance its invalidation epoch: an answer to a read sent before that neither settles nor parks the body, and one fresh read follows it. During a refresh the last good body stays shown until the newer value covers what the reader shows; a `content-changed` refusal drops the partial newer value and reads it again from offset 0 (at most four restarts before the read fails), so a shown body is always one digest's own prefix. A failure keeps the last good body and parks until new demand, an invalidation or Retry; readers show the failure and Retry beside that body's page, and a read after a failure shows the body it reads for, never the failure. Copy retries a failed read it needs, and a read failing meanwhile ends that Copy with its failure, so another Copy can start. A released, switched or replaced reader's late answer never publishes, and its read is aborted. Bodies no reader shows stay for an immediate redisplay within 4 MiB (UTF-16) and 128 bodies, least recently used first out; a stopped workspace clears its bodies. Closed disclosures (task brief, technical details, a history entry's details) read nothing. Reads share the secondary background budget. Intents that copy recorded inputs read them for one snapshot (`components/mission-target-bodies.ts`): a body counts only when its digest is that snapshot's descriptor, whatever the cache retained, and an absent field (one the snapshot names no descriptor of, never read) is a member of the snapshot. The edit form opens read-only on the map it was opened from, its CAS revision: once objective and notes both match, it prefills them; a field read at or after that revision with another digest changed since, so the form says so and offers Reopen, which reads the list and opens the edit again on the newest map, never prefilling from the changed field or advancing the CAS. An editor unmounted meanwhile reopens as opened; typed drafts are kept as before. Save as brief takes the map shown when its name field opens: unrelated revisions never starve it, and a changed input starts it again from the newest map (refreshing the list once when the shown map has not caught up), at most three times; then, or when a refresh brings no newer map, it shows the change with Retry, which starts again from the current map. Admission, mutation, the editor's lost-acknowledgement checks, Stop, Delete and recovery keep their authoritative map and single-mission reads; the lost-acknowledgement checks and cleanup retries read only the single read's revision and cleanups. A plugin without content reads answers `plugin-unavailable`, a failure like any other: readers show it with Retry beside the last good body, parked until Retry, new demand or an invalidation (the reload's `plugin.updated`); the compact map holds no value to show instead.

**Compact maps** (`missions/mission-compact-map.ts`; panel types and excerpts in `missions/mission-panel-map.ts`; descriptors in `missions/mission-body-descriptors.ts`, wire types in `missions/mission-content-wire.ts`). The list and mission reads (`MissionControl.list`/`mission`) return compact maps: `compactMissionMap` copies each map the read returns, drops each body field (`MISSION_BODY_FIELDS`) and puts its descriptor in the owner's `bodies`: on the map (`objective`, `notes`, `summary`, `briefing`), each task (`brief`, `executionMode`, `report`, `lateReports`), each of the mission's own `reports` (`summary`, `next`, `evidence`, `artifact`) and each plan change in `history` (`reason`, `objective`, `notes` and the task lists `addedTaskKeys`, `retiredTasks`, `dependencyUpdates`). A descriptor is `{ characters, digest }` of the text a content read of that field slices (`contentText`: the string itself or the value's JSON; `contentDigest`), present only for fields the owner has; `missionBodyDescriptor(map, selector)` finds a selector's. In place of the bodies a compact map keeps what the panel shows without reading them: `excerpt`, the objective's row label (`missionObjectiveLabel`, 502 code points); the briefing's identity (`id`, `requestID`, `basedOnRevision`, `basedOnUpdatedAt`, `createdAt`); report rows, in a task's `report` and `lateReports` and in the mission's `reports`, without their prose but with `excerpt` (`missionExcerpt` of the summary: one line of at most 240 code points, a cut ending in "…") and `decidedBy` (`missionDecisionMaker`, read from the artifact); an independent mode's `kind` and `reason` with an `excerpt` of its explanation; plan changes with an `excerpt` of their reason. Every other field, unknown ones included, is copied as it is, except what §Task pages bounds: the tasks and reports a map holds, a row's late reports and invocation observations, and the map's `frontier` and `claims`, which the panel never reads. A map without descriptors (an older plugin's) is described first, an older plugin's compact map without `taskPage` is paged, and a paged compact map is returned as it is. The `list` and `mission` RPC outputs use a compact schema derived from the full map's (`rpc.ts`), which refuses body fields, as the full schema refuses descriptors. Snapshot, admission, mutation, `mission.inspect` and current-passage maps, and every map `MissionControl` reads internally, keep every body (`mission-compact-map.test.ts` fails when one loses a body); descriptors are not model-facing. Each body is serialized and hashed once per read; budgets are in §Task pages.

**Task pages** (`missions/mission-compact-map.ts`, `missions/mission-task-order.ts`, `MissionControl.tasks`; constants and types in `missions/mission-panel-map.ts`). A compact map holds a page of its tasks, whatever the plan's size. Its `tasks` are its window, the first `MISSION_TASK_PAGE` (50) of the display order, and up to `MISSION_TASK_PINS` (20) pinned rows of what the panel must show of any task, in this priority: the tasks needing action (with a pending notification, blockages and failures newest first, then reports to recover: `missingReport`), the 8 newest reports' tasks and the briefing's source tasks, all in display order. The display order (`missionTaskOrder`, the tree's `orderMissionTasks`) takes rounds of the tasks whose dependencies among the map's tasks are taken, each round in map order, then the tasks a cycle holds back in map order; it is linear in tasks and dependencies. Each row adds `order` (its position in the whole order), `dependents` (tasks depending on it in the whole map), `reportCount` (its reports in the map) and, beside its own descriptors, `bodies.reports`: the descriptor of its whole history, the content field `reports` exactly as `missionContentValue` answers it (computed from reports without descriptors, and only from a map holding them whole), so a reader of that history reads it again once a report arrives; it keeps its newest late report (`MISSION_LATE_REPORT_ROWS`, beside `lateReportCount`) and its invocation without `observations`, both of which the content route reads whole (`lateReports`, `nativeExecution`). The map's `reports` are its rows' own, at most `MISSION_TASK_REPORT_ROWS` (3) a row (the current one, then the newest pending notifications, the newest late one and the newest), plus the 8 newest whose task the map does not have (`MISSION_PINNED_REPORTS`); a task's every report is its content field `reports`. `taskPage` describes the page: `order` (the digest of the order's keys), the window `[offset, end)`, `total`, `counts` by status, the map's report count `reports`, `pinsOmitted` and `attention` (`MissionTaskAttention`): the whole map's tasks needing action counted by kind (`notifications`, `blocked`, `failed`, `recovery`; a task can be of several), how many of them the map holds neither in its window nor among its pins (`omitted`), `sequence` (the digest of their keys in pin priority, which changes whenever that list does, even in the same display order) and, in a map, the keys of the first 50 of those. `actorEvidence` names the actors whose report or native call the map's tasks (all of them) say is owed; the activity projection reads it instead of the tasks a page holds. The read-mostly `tasks({ missionID, order?, offset? | attention? | keys?, ids?, reportIds? })` RPC (`missionTaskRequestSchema`: one of a window, an attention window or names, at most 50 names in all, so a named read answers every task it names) answers from one `missionView` read of that range: the window of 50 at `offset`, the window of 50 of the omitted tasks needing action at `attention` (in pin priority, its `taskPage.attention` naming that window's `offset` and `end`), or the named tasks, each in display order, as rows with their reports and the named reports, with `taskPage` and the map's `revision`; it refuses `order-changed` once `order` no longer names the display order (a plan change) and answers `mission-not-found`. Following each page's `end` from offset 0 to `total` reaches every task once, in display order. `GET /api/workspaces/:id/missions/:missionID/tasks?order&offset&attention&keys&ids&reports` (comma lists) brokers it with the list's ownership, plugin and project checks; a plugin without `tasks` (`rpc.method_not_found`) is answered from its single-mission read, paged by the route (`missionTaskPage`). It is a display read: never a write's or admission's authority.

**Budget per response** (UTF-8 bytes of the JSON; `mission-task-pages.test.ts` builds rows of maximal width and checks every bound): a task row stays within 32 KiB (scalars, a 240-character title and role, its execution profile, at most 24 dependency keys of 64, native identifiers of 240, descriptors and its report rows), a report row within 8 KiB (identity, native call, an excerpt of 241 code points, descriptors), a plan change within 4 KiB (descriptors and a reason excerpt). A page holds at most 50 rows, their 150 report rows and 50 named ones: 50 × (32 KiB + 4 × 8 KiB) = 3,200 KiB. A map holds at most 70 rows with their 210 report rows, 8 taskless reports, 50 plan changes and a header within 40 KiB: 70 × (32 KiB + 3 × 8 KiB) + 8 × 8 KiB + 50 × 4 KiB + 40 KiB = 4,224 KiB, besides its actor-scale lists. A mission of 2,400 tasks with 20,000-character briefs and a plan change rewiring 1,224 tasks takes 49.4 MB as a full map, 54 KB listed and pages of at most 43 KB; a row of 1,997 observations or of 100 late reports of 20,000 characters stays under 5 KB. The read bounds no actor-scale list: a list response carries the compact map of every open mission and of up to four included ones, one row per live mission and up to 2,000 cleanups, and `actors`, `control` receipts, `actorEvidence`, the activity projection's actors and observed families and the rows' `actorSessionIds` grow with a mission's actors.

**Reading further** (UI `stores/mission-task-pages.ts`, `stores/mission-store.ts` `loadTasks`, `components/mission-task-tree.tsx`, `components/mission-graph.tsx`, `components/mission-task-open.ts`). The store keeps, per instance and listed paged map, the list read's own map (its base) and a page cache: the display order, rows and reports by ID each with the revision of the page that answered it, every read made (window and attention offsets, keys, IDs, report IDs) with the revision of its last answer, the reads parked by a failure, the failed reads no read has answered since, and the attention windows answered for the newest attention sequence (`taskAttention[missionId]`: windows answered under another sequence cover nothing of this one, whatever the order). A page vouches only for what it answered, and a row or report it answered carries its revision to the bodies it describes (`missionBodyRevision`, §Body display). `missionStore.loadTasks(instanceId, missionId, request)` reads one page in the order the shown map names and resolves to how it ended (`read`, `failed`, `reordered`, `skipped`); a mission's reads run in turn, an identical read still waiting is that read and a running one is followed by one more, each read is recorded before it is sent, reads share the secondary background budget, and `clear` fences reads in flight. An answer in the shown order merges into the base (`mergeTaskPages`: rows in display order; a row or report the base holds stays unless a page answered it at a later revision, one it does not hold shows as last read); a refusal or an answer in another order reads the list again. Each list publication takes its maps as bases, shows them with the cached rows of the same order, drops the bases and caches of maps it no longer lists and reads again each read last answered before the map's revision, except one parked by a failure at that revision or later; another order drops the rows and reads every recorded read from scratch. `taskReads[missionId]` says whether a read runs (`loading`) and holds the oldest failed read (`failure`, with its request) until a read answers every name or window of it; other reads succeeding keep it. The rows shown stay and the tree offers Try again. The tree's header counts every task (`taskPage.total`); its rows follow the display order with a gap row (`li.mission-tree-gap[data-start][data-end]`: "N tasks not shown" and Show more, which reads the window at the gap's start) for each run of tasks the map does not hold, and a row's title and assistive text name its dependencies and dependents not shown. Above the rows, and distinct from any gap, a notice (`p.mission-tree-attention`) says how many tasks needing action the map omits and are not shown yet ("N more tasks need attention": those of its omitted keys not loaded, then those of each attention window after them that no read answered for the map's sequence), with the whole map's counts by kind; its Show them reads the unloaded keys by name, then the first window not answered, until none is left. The graph draws every edge between shown rows, measured again whenever rows arrive, and a dashed stub (`path.mission-graph-omitted[data-omitted]`) rising from a row whose dependencies are not shown and falling from one whose dependents are not. Readers stay truthful for tasks not loaded: a dependency, replacement, predecessor or briefing source link reads its task by key and opens it if the reader has not moved meanwhile (`openMissionTask`); a reader target the map does not hold (a restored or linked task or report) is read by ID, once per display order, showing Loading meanwhile, the reader's failure line with Try again (which repeats that read) when it failed, and "no longer available" only once a read answered without it; a task reader counts its dependents and earlier results not shown, whose Show all reads the task's `reports` whole and stays open across refreshes of the same task, reading the history again when its descriptor changes; the overview's Reports counts the reports in tasks not shown. Needs you comes from the map's actors and the observed family, never from its task rows.

Project mutation and journal-append exclusion is shared by all bundle incarnations in the native host. An in-flight mutation keeps its lock across registration disposal: a content-addressed replacement waits before reading its CAS revision. `missions-reload.test.ts` loads two independent compiled bundles and races updates across dispose/setup to verify that only one can succeed.

Mission Control manages map metadata through the authenticated CodeNomad routes `POST /api/workspaces/:id/missions`, `PATCH /api/workspaces/:id/missions/:missionID`, and `DELETE /api/workspaces/:id/missions/:missionID`. These broker only the typed `create`, `update`, and `delete` methods of `codenomad.missions`. Create uses a stable request ID, may attach an owned root session or create a new root without prompting, and accepts an optional `title` (trimmed, single line, 1–60 characters, `missions/mission-title.ts`). The title is part of the exact creation request and `mission.created` event, is exposed as `MissionMap.title`, and names new coordinators `Mission · <title>` (otherwise a title derived from the objective's first sentence). Missions without a stored title stay untitled; the UI derives a label. Roots that Missions creates (new coordinators, recurring passage coordinators and independent task roots) take OpenCode's descending session identifier (`missions/session-identity.ts`): `ses_`, 12 lowercase hex encoding the real creation time, then 14 hex derived from the mission or task identity. OpenCode Zen's free models refuse a session whose identifier lacks a recent OpenCode creation time, and native children send their root's ID as session affinity, so one foreign-format root blocks its whole mission family on free models. Ownership checks (managed-root creation and cleanup, recurring passages, creation readback) match the derived suffix and also accept the `ses_` + 26-hex derivation held by existing journals. Reading time-prefixed roots requires a build that knows this format: an older build rejects a recurrence document whose passage holds one (the project's recurrence list then becomes unavailable on that build) and leaves such independent task roots out of managed cleanup and managed-root retries. Keep a compatible build available for rollback recovery and never rewrite stored session IDs. Update uses revision compare-and-swap for objective/notes. Delete appends a tombstone: the map disappears from snapshots and membership. By default every conversation is preserved. Late reports for a tombstoned mission cannot recreate its map. Settled tombstones are purged (below).

Deletion optionally accepts `deleteManagedSessions: true`. Immutable targets are recorded in the tombstone, and per-session receipts reserve journal capacity before removal. Only deterministically created specialist roots with matching native creation metadata and exact project/location identity qualify. Coordinators, reused sessions, actors referenced by another mission (including finished/deleted maps), and roots with children are retained. Native removal is recursive, so descendants are outside this opt-in. The plugin delegates removal to the authenticated desktop bridge, because native plugin contexts lack `session.list/remove`. The bridge obtains authoritative intent through the narrow read-only `cleanupTarget` RPC, revalidates ownership/connection/worktree fences and calls the native HTTP client. It never modifies OpenCode storage directly. An incomplete cleanup returns `503 cleanup-pending` after the tombstone is committed; replay the exact original request ID, revision and option. The editor retains that request through live snapshot refreshes and locks the option after the first attempt. Only an explicit retry resumes cleanup.

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

**Purging deleted missions** (`missions/journal-purge.ts`). Once every cleanup target of a tombstone and its required document compaction have exact receipts, the journal removes that mission's events through the optional `MissionStorage.remove` (native `storage.remove`); storage without it keeps every entry. Deletion keeps the 20 newest settled deletions (`SETTLED_CLEANUP_HISTORY`: the cleanup history and the editor's lost-acknowledgement check read them) and purges older ones. Native-pending and document-pending deletions precede that settled history and retain their journal ranges and activation-index work hints. When an attempted deletion finds neither its map nor its cleanup, the editor's explicit retry resubmits the original request, revision and option, and the record below answers it; passive refreshes only read. Purging is retention only: capacity is per mission (§Safety limits), so a full mission makes room through its own deletion reserve and other missions never wait on a purge. A deleted mission stays while it references, as coordinator or task actor, a session another unsettled mission could still clean up (a deterministic task root of a non-deleted mission, or a pending tombstone target): that reference is the shared-membership evidence cleanup retains such sessions on. Damaged journals (discarded entries, invalid cleanup, control or notification history) are never purged.

Before the first removal the purge writes a deletion record at `codenomad-missions/v2/deleted/<projectToken>/<missionID>`, beside the scanned journal prefix: it costs no journal capacity, is only point-read (by every storage adapter, with or without removal support; the isolated recurrence-passage adapter, which never purges, has none) and is never removed. It holds the deletion request ID, revision and option plus the settled cleanup summary (240-character objective label, counts, reasons). The record refuses the mission's deterministic recreation (create, prepared hand-offs and inspect-start replays answer `mission-deleted` before any native effect) and answers an exact deletion replay with the original summary; another request ID answers `mission-not-found`, a changed revision or option `request-conflict`. Removal starts with `mission.created`, then tombstones, then intents before receipts. A group without its creation event whose mission has a valid record leaves the observation, so every intermediate state reads without discarded events, reopened cleanup or reservations; late writes to a purged mission are absorbed the same way and removed by the next purge, which also resumes an interrupted one. Without a readable record such a group stays damage evidence. Per-mission reads (`missionEvents()`/`missionView()`) scan only that mission's key range `<prefix>/<missionID>/` (the isolated recurrence-passage adapter accepts its own mission's range besides the whole virtual prefix) with the same parsing, read bound and record handling; their discarded count and damage flags are that range's own, and the snapshot's project values aggregate them plus entries outside every mission range. A paginated observation (`events()`/`snapshot()` or a per-mission read) takes the same `append:<projectToken>` exclusion as appends and purges, so it never assembles pages from both sides of a removal; code already holding it uses the private unlocked observer, and storage adapters never read the journal. Builds without purge support read a journal mid-purge as damaged and never consult deletion records.

An ordinary journal's finish carries the project's finish number (`mission.finished.sequence`, the map's and summary's `finishSequence`). `MissionJournal.appendFinish` draws it from the counter at `codenomad-missions/v2/finishes/<projectToken>`, beside the deletion records and outside every mission range (no journal capacity), under the `append:<projectToken>` exclusion after the capacity check, writing the counter before the event: a refused or failed write leaves at most a gap, an exact replay returns the stored finish with its number, and a damaged counter refuses the finish. The counter is never removed, so a later finish always has a larger number whatever deletions, purges, reloads, new controls and clocks did; the seen-completion watermark relies on that order. Daily and unified calendar passages use isolated storage (`isolatedMissionPassageJournal`), whose finishes stay unnumbered. Immediate journal-owned Missions use the ordinary project's counter.

**Journal index** (`missions/journal-index.ts`). Each `codenomad.missions` activation (`opencode/missions/desktop-plugin.ts`) owns one never-persisted `MissionJournalIndex`, shared by its ordinary journals (MissionControl through `setupMissionsPlugin`, presence retention) and disposed with it; never make it module-global, since a reloaded revision may reuse the module. `MissionJournal.readHints(read)` builds it on first use with one key-ordered streaming scan (same read bound as `observe()`), then runs `read` synchronously under the append exclusion on hints: `refs(sessionID)` (missions whose events name the session as coordinator, `preparedBy` author, dispatching or native-bound actor; live maps in snapshot order, ties by the first event then binary key order, then the rest in key order), `openIDs()` (per-range `missionWorkRemains`), `aggregate()` (the snapshot's discarded count, damage flags including entries outside every range, and latest live `updatedAt`), `cleanups()` (the snapshot's displayed cleanup history: pending, then the 20 newest settled) and `summaries()` (one panel row per live map, in snapshot order). The callback only extracts values: its type refuses a Promise or thenable result and a thenable is rejected at runtime before the exclusion could adopt it; range reads (`missionView`) happen after `readHints` resolves. Entries keep scalar ordering tokens and bounded labels, never events. Every ordinary journal write attempt (append, record write, purge removal), before it starts and whether it then fails, lands or goes unconfirmed, bumps a per-project write generation shared by all incarnations in the process and marks its mission dirty, so the next read re-reads that range; a range whose deletion record was unreadable stays dirty. A generation the index did not produce itself (another current-build activation, an unindexed journal) or any read failure makes it rebuild. Writers outside that generation stay unseen until the next rebuild: an older build activated in another native Location of the same project (native activation is per Location, its plugin storage per plugin ID, and native KV has no change counter), a failed-reload fallback, another process, bytes written without `MissionJournal`. A full rebuild at least every 60 seconds (`MISSION_INDEX_STALE_AFTER_MS`) heals such misses. The answers are therefore hints: anything that authorizes a write or native effect (cleanup authority and shared-session checks, membership admission or refusal, deletion, purge planning, recreation checks, damage gates before a write) keeps its authoritative full read; only read-mostly paths (the per-turn context hook, panel lists and summaries, outbox enumeration, and presence retention when the hints show open work; an empty answer is confirmed by a full read before presence is released) may use the hints. `MissionControl.hintedMissions` is that read: it takes candidate IDs from the hints, re-reads each range with `missionView`, keeps snapshot order (stable by `updatedAt`, ties in hint order) and stamps the hints' project damage flags on each map as a snapshot does; isolated passage journals use their snapshot instead. Its callers: the context hook (`contextFor`, one membership read per model turn returning the instruction and whether the session coordinates the mission; a conversation no mission names reads no range), `mission.inspect` without `start` (by `missionID` reads exactly that range), `inspect({ list })`, the task observation and decision-candidate reads behind `inspect({ taskKey })`, the notification outbox's enumeration over `openIDs()` (every running mission is open), and the panel's `list` and `mission` reads (§Snapshots, journal locking and map routes). Each notification then re-reads the whole journal before its native admission and before its receipt, and both the native message ID and the receipt ID are deterministic, so a mission the hints miss is only delayed until the rebuild and a stale candidate is skipped once the full read shows it admitted. The context of a mission written by such an unseen writer is withheld until the rebuild; its tools stay offered and every one re-selects authoritatively. `retainMissionWork` retains on `hintsShowWork` (an open mission or project damage) and otherwise decides on the full snapshot. Creation and `inspect({ start })`, declaration, delegation, revision, briefing, report, update, lifecycle, recovery, prepare, task interruption, deletion and cleanup keep their full reads; the change events after lifecycle and deletion carry the revision those operations already read. `journal-read-budget.test.ts` pins both sides over a finished history of 10,000 entries in 200 missions: the hinted paths make no full scan and read at most their own ranges (`GET /missions` through the plugin reads only the open and included ranges and observes only their actors), while membership refusals and damage gates see entries the hints have not. Isolated recurrence-passage storage (`MissionStorage.isolated`) writes its own physical namespace, never counts and has no index (`native-passage-business.test.ts` traps ordinary journal writes from passages).

### Opt-in bounded panel transport

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

Picker discovery and cleanup history read explicit `window:{offset,order?}` selections
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
task rereads. Actors, all compact reports, history and claims use independently selected
field windows. Lifecycle receipt/pending collections use `field:"control"` with
`part:"receipts"|"pending"`; lifecycle identity and counts stay in compact control.
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
The recurrence-passage reader keeps its own transport.
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
explicit first Play admits the original lifecycle message. Creation preserves native
schedules, experimental settings and service supervision. Immediate Play preserves
native schedules and experimental settings, and enables an unset shared service
supervision preference; an explicit OFF remains OFF. Settings → OpenCode exposes this
preference and its observed protection state ([Settings](SETTINGS.md)).
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
The shared two-key editor
(`opencode/native-experimental-settings.ts`) materializes inherited
`schedules:true` when setting a depth would hide that activation, preserves an
explicit local false and depth zero, and copies only these two known keys.
A remaining schedules
block selects the native depth default unless it also holds a depth. Native
settings refuse simultaneous JSON/JSONC files in one layer. The schedule
capability reader independently recognizes the consumed API shapes and reads the
effective Location flag and its block origin through the acquired connection.
The depth snapshot exposes that selected block's document path as `origin`,
including when its missing depth selects the native default. The editor displays
the effective block separately from its project write target; Scheduling displays
the acquired capability read's effective block too.
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
independently of presence ([MISSIONS_RECURRING.md](MISSIONS_RECURRING.md)); the typed
RPC and the ordinary one-time route register through backend presence. Without
either route, the context hook removes every `mission_*` tool from the model
request and the executors refuse. `retainMissionWork` preserves
the presence registration while active/unsettled work, receipts or uncertain storage
remain, including after lease loss; subsequent protected sends still pass the
owning backend's fresh admission checks. Never install project-local files; the
server typecheck covers the plugin contract. Qualify presence loss with
`MISSIONS_LIFETIME_NATIVE_CLI=<absolute-isolated-opencode-cli> npx tsx --test src/opencode/missions/presence-native.test.ts`
(in `packages/server`): it observes the presence registration through the native
`codenomad.missions` RPC, and the tools through the native tool list and the model
request.

Assignment prompts and report synthetics use a narrow authenticated loopback bridge mode. The owning backend reconciles the persisted task/report via `codenomad.missions.snapshot`, validates complete native session ownership and selection, acquires the worktree mutation fence, and applies the current full profile environment before admission. Native environment errors are redacted and fail closed. Environment data never travels through the UI or plugin. Multiple owning backends are rejected rather than choosing a profile arbitrarily.

Before either kind of admission, the backend also refreshes its owned `codenomad.git-availability` instruction through `syncSessionGitContext`, removing stale context after recovery. This bounded Git advisory is separate from fail-closed environment synchronization: admission proceeds when it fails, while cancellation and connection retirement block admission.

The bridge accepts up to 250,000 assembled text characters within its 512 KiB JSON body limit. This accommodates the maximum objective, brief, title and dependencies after XML escaping (up to 5×), including JSON control-character escaping on the wire. HTTP regression coverage exercises maximum accepted contracts for all playbooks.

This transport reuses only the automation bridge discovery; automation keeps its own execution-time session/window fences. Environment and model state are session-scoped: a queued inbox item runs with the session's state at execution time; see [SESSION_ENVIRONMENT.md](SESSION_ENVIRONMENT.md).

## Safety limits

- One native project per mission.
- Coordinator and independent actor admission require exact owned roots; native
  descendant observation/reporting uses its separate ancestry/provenance contract.
  Foreign projects are rejected; a graph edge never grants session authority.
- A mission has no count limit on actors or tasks: its 2,000 stored journal entries
  (`MISSION_MAX_EVENTS`, counted over its key range, unreadable entries, receipts and
  tombstone included) bound it, and the number of missions, and so a project's
  journal, is unbounded. Entries plus pending reserved receipts never exceed that
  count, on every storage. Ordinary writes keep the lifecycle reserve of the actors
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
  Capacity checks (`assertCanAppend`, `append`) read the target mission's range and its exact document key. A write's
  safety decisions still read the full journal (§Journal index), so write cost grows
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
  Recurring creation uses the same classification (`creation-unavailable`,
  `creation-worktree-deleting`, the hold codes, `recurrence-capacity`, 400 and
  codeless 401/403/404 are definitive; codeless 409/5xx and `creation-uncertain`
  stay held), keyed on a flag set immediately before the paused-schedule RPC.
  Known limit: that UI hold lives in window memory only and an uncertain create
  cannot be looked up by request, so it keeps Create blocked for that project scope
  until the window reloads (the backend permit and deletion block remain until
  native settlement). After a reload, check the mission list before creating again.

## Included playbooks

- **Debugging** preserves evidence-first diagnosis, behavioral TDD, independent fresh Standards and Spec reviews, implementer-session resolution, and a fresh read-only green gate. Completed role reports carry validated structured artifacts, while the coordinator chooses each transition.
- **Wayfinder Map** adapts destination, map, frontier, claims, and fog-of-war planning to visible sessions. It remains planning-first; decision workers, prototype scouts and decision guides return briefs, and the coordinator decides, defers or asks the human (§Human questions and decisions).
- **Product delivery** (`delivery`) adapts the NomadWorks Collective method (`NeuralNomadsAI/NomadWorks`) without requiring that plugin. The coordinator acts as Product Manager: it classifies each request by complexity (tiny, standard, complex) and track (implementation, investigation, spec), has the business analyst and tech lead draft a Spec Change Request for any behavioral change (tiny included), standard or complex implementation and spec work, runs read-only pre-sync readiness reviews before implementation, decomposes complex work into slices with the technical architect, keeps one shared-checkout implementation task at a time, and closes only with QA/tech-lead evidence and resolved documentation impact. The six roles are business analyst, technical architect, tech lead, developer, QA engineer and UI/UX designer. The coordinator treats an objective that already states the behavior change precisely (what changes, for whom, how to verify it) as the approved request, and otherwise asks the human to approve it through the native question tool, batching pending approvals; the human owns commits unless the objective or notes explicitly ask for them. One playbook covers both NomadWorks team presets; the coordinator declares only the roles each complexity needs. Same-scope rework retires the task and adds a replacement (`replacesTaskKey`); continuing a native specialist's context uses a follow-up task whose `reuseFromTaskKey` names that specialist's finished, still-live task.

Playbook details: the creation form's **See details** (under the Playbook description) opens the selected playbook in the central `MissionReader` as target `{ kind: "playbook", missionId: <playbook id>, taskMode }`, which needs no Mission or conversation (the instance shell shows it like a schedule reader) and is rendered by `components/mission-playbook-reader.tsx`. It reads `GET /api/missions/playbooks?taskMode=` (`server/routes/mission-playbooks.ts`, wire type `missions/playbook-details.ts`), which returns `missionPlaybookDetails()` from `missions/recipes.ts`: each recipe as `getMissionRecipe(id, taskMode)` returns it, plus the complete texts `buildActorContext` and `buildAssignmentPrompt` produce from `PLAYBOOK_PLACEHOLDERS` mission data (the one-time and daily coordinator context, each role's assignment and, with independent sessions, the specialist context). `mission-playbooks.test.ts` compares, as whole texts, what is actually sent (`nativeAssignment`, `assignmentInput`, `MissionControl.contextFor` for coordinators and a dispatched independent task) with the export after substituting only that mission's data, so any instruction added to or missing from a recipient's text fails it. While the creation editor has a request in flight, **See details** is disabled: on narrow layouts revealing the reader closes the panel, ending the view the request completes in; reader navigation never advances the panel's operation intent. Never copy recipe text into UI strings; the localized explanation of every playbook is the `playbooks` help page.

## Validation

`node scripts/test-missions-native-trajectory.mjs <absolute-isolated-opencode-cli>` also checks the one-time Wayfinder decision flow: an artifact-free readout and a forged answer refused without journal mutation, a decision worker that returns a brief, the coordinator's own question naming the task's `questionTag`, answered through the authenticated UI route, listed by `inspect({ taskKey })` and settling the task without an artifact, and a coordinator decision recorded as its own. The invocation unit tests cover graph isolation, missing/stale invocations, interruption joining and per-check deadlines.

Each complete one-time human-gate call (acquisition plus its nested SQL/Form/storage reads) shares one 10-second deadline, matching `missions/native-human-evidence.ts`, combined with invocation cancellation. The check aborts and joins only its own runtimes and clears its timer on settlement; later checks get a fresh budget, excluding intervening session/authority work. The invocation joins all pending checks/reads before graph release. A raw Promise that ignores abort may remain pending, but cannot resume its cancelled Effect into the graph, and later reads through that expired check are refused. A stuck native finalizer or uninterruptible read is joined before its graph is released: never abandon such work with a Promise race, and keep reads interruptible and cleanup finite. Recurring gates use their own runners.

`node scripts/test-missions-native-family-control.mjs <absolute-isolated-opencode-cli>` (latest-runtime CI) qualifies recursive Pause/Play and Stop with real background subagents in a private runtime: a five-session, three-level family interrupted deepest-first with complete receipts, Pause parking results without model turns, Play resuming only the coordinator with interrupted-child context, Stop emptying family inboxes.

`npm run qualify:browser:native-mission-replay --workspace @codenomad/ui`
(`tests/browser/native-mission-integration.qualification.ts`) replays a captured
private native run through the real renderer only: it requires `NATIVE_MISSION_CAPTURE`
as the absolute path of that run's `capture.json`, fails when it is missing,
answers mutations with 405 and writes `browser-report.json` to the absolute
`NATIVE_MISSION_OUTPUT` (default: a temporary folder).

## Agent conventions

- Mission sections use `components/mission-disclosure.tsx` and the shared `.disclosure-chevron`. Keep disclosure/selection/reader identities in the native per-window layout via `stores/mission-view-state.ts`, independent of refreshed snapshot object identity; the window keeps every toggled section and a mission persists the newest toggles one layout value holds. Long mission content uses `components/mission-reader.tsx` above the transcript; its chrome follows `.window-*`. Mission styles live under `styles/panels/mission-*.css`. Recurring setup/list geometry lives in `styles/panels/mission-recurrence.css`. Template and execution mode are orthogonal; recurring drafts record the chosen template, optional verbatim notes and exact coordinator/playbook-role profiles for future passages, under H9 editing guards. Recurring uses the same brief-only library, never storing clock, watch or invocation state in a brief. Daily CREATE and UI share `recurrenceReadBudget` / `recurrenceInputBudget`, with exact native Location room; never raise a ceiling automatically. Creation is one screen (`components/mission-editor.tsx`, `styles/panels/mission-create.css`): the shared objective/instructions draft, an editable title prefilled from its first sentence (≤60, `missions/mission-title.ts`), a folded Scheduling section defaulting to immediate/without a condition and exposing frequency, source condition, end limits, saved zone and preview, and everything else under one collapsed Options disclosure (catalog-backed profile selectors stay lazily nested), except Compare's required Model A/B selectors in the main form. The panel's Create button heads the form, which replaces the current-mission line, the list and the selected detail; these stay mounted but hidden (`.mission-control[data-creating]` in `mission-control.css`, `MissionPicker` `creating`) so pending controls and retries survive. Options include the project's native nesting depth (`mission-subagent-depth.tsx`, shared with Preferences). The Playbook select's `aria-describedby` names the selected playbook's one-sentence description (`missions.control.template.<id>.description`), shown directly under it. The form fills the panel below its header as a column whose body is the only scroller, with the footer below that scrollport at the panel bottom: asynchronous content (depth reads, catalogs) never moves Create from under an aimed click, and focus scrolling never hides a field behind the footer. Banners the panel still shows while creating (stale map, unconfirmed cleanup) are ordered above the form, so they shrink the body instead. When the header, banners and footer leave the body less than its minimum, the whole form scrolls in the panel with the footer after it (`mission-panel-scroll.ts`). The footer's Save as brief takes the footer's `button-secondary` template; elsewhere it is a `.window-text-button`. The footer has a single **Create** submit: creation stores a paused Mission; one-time Missions and schedules start only through their separate explicit Play. Validation stays inline beside its field.
- One-time Mission readers show bodies only through `useMissionBody`/`useReaderValue` (§Body display); never render a body from the map in a reader, and never feed a reader's cached display value into admission, a mutation or a lost-acknowledgement check. The panel's maps are compact (`MissionPanelMap`, §Compact maps): answer a body's presence from its descriptor (`missionBodyPresent`, `missionReportHas`), take labels from excerpts (`missionDisplayTitle`'s `excerpt`, `missionReportExcerpt`, `missionChangeExcerpt`, `missionModeExcerpt`, `decidedBy`), and read a passage's own values only through `missionOwnBody` or a full map (`isFullMissionMap`). Never add prose or other unbounded values to compact rows: a new body field goes in `MISSION_BODY_FIELDS`, and a label the panel needs becomes a bounded excerpt computed in `compactMissionMap`. Never compact a map anywhere but the list and mission reads (the plugin's `MissionControl.list`/`mission` and their routes) and page tasks anywhere but `tasks` and its route. Browser fixtures list compact maps (`panelMissions` in `tests/browser/mission-content-fixture.ts`) and serve the content and task routes from their own full maps (`missionContentFixture`, `routeMissionContent`, `missionTaskFixture`, `routeMissionTasks`, or `listedMissions` for the full maps `panelMissions` compacted last); a fixture map keeps every report in the mission's own `reports`, as the reducer does.
- A compact map holds a page of its tasks and their reports (§Task pages). Never derive a whole-mission fact (task counts, Needs you, activity, owed work, whether a task or report exists) from its `tasks` or `reports`: use `taskPage`, `actorEvidence`, `actors`, the activity projection and the summary rows. Navigation to a task the map does not hold reads it (`openMissionTask`, `missionStore.loadTasks`) instead of being disabled, and every row the server sends stays within its budget: a new unbounded task, report or change field is a body or a count, never a list in a row. Keep `missionTaskOrder` the only display order, shared by the server's pages and the tree.
- Editor input copies and receipt checks use exact descriptor-pinned content with their original map revision and request identity (§User-journey regression checks). Unified-document projections stay whole in compact maps: `MissionDocumentSummary` carries bounded configuration metadata and input digests; editor text comes from the schedule or content route.
- Journal editor reconciliation reads the original history request and exact text independently of the task window. Task pages preserve the loaded map's document and cleanup metadata; missing task rows require only the named display read their reader needs. Admitted current-passage maps carry their complete task and report lists through the recurring reader. The document RPC schema carries the dormant-journal marker and first-Play input digest with the projected summary.
- The open create/edit/delete editor lives in window memory per panel scope (`stores/mission-editor-state.ts`), never in the native view layout. A hidden project keeps it mounted and usable on return; when the panel unmounts (another right-panel tab) an idle editor stashes its draft and reopens with it, while one with a request in flight or held closes and settles through its creation/recurrence hold. Editor activity follows the live view: `lib/mission-view-fence.ts` captures guard one operation from capture to completion, never a component's lifetime.
- The Missions panel header (`components/mission-picker.tsx`, `styles/panels/mission-picker.css`) has a compact right-aligned toolbar ([+] create, then the panel's preferences gear and refresh) above one "current mission" line modelled on the provider account control: chevron, then the selected-title field (title + small square status mark). Edit and delete live in the selected detail's toolbar (below). The chevron toggles a persistent inline list, saved per project as `listExpanded` in `stores/mission-view-state.ts`; the field opens the same list as a transient ARIA combobox/listbox popup (arrows/Home/End/Enter, Escape, outside click, selection close it). Rows (one-time and recurring) show only the title (`lib/mission-display.ts`) and a status mark; full state lives in the tooltip and screen-reader text. Lists scroll natively within a bounded height; the title filter appears only while the rendered list measurably overflows, or still holds text. Marks, task icons and the chevron share the session status palette (`mission-picker-model.ts` `missionMark`/`scheduleMark`), and colour shows only what needs attention now: a requested answer → permission red (the requests listed under Needs you: declared actors and observed family; a schedule row without its passage read counts its live passage's conversation and loaded subsessions); observed work → working yellow with pulse; interrupted (a running mission whose coordinator is idle without its report while nothing else runs, a failed mission not stopped since, an interrupted schedule, or a running one whose latest run failed) and paused → warning orange, each with an action to continue; a completed mission this window has not shown → idle green (`markMissionsFinishedSeen` in `stores/mission-view-state.ts`: its own layout key and signal, so recording never wakes project-view readers; seeded with the missions already completed on the first read, marked when the selected completion is visible in a focused window; one layout value per project holds a watermark on the maps' `finishSequence`, below the oldest unseen completion, plus the seen completions finished after it, so any number of completions fits; when that list outgrows the value the watermark rises over the oldest unseen completions, which then count as seen, a shown completion never reads as unseen again and a new finish, numbered after every earlier one, starts unseen); a prepared mission, ready to start like a composed prompt → `--accent-primary` blue; anything else neutral. Outcomes are status text and icon shapes, never colour: done, failed, blocked, waiting and retired tasks stay neutral, active tasks pulse yellow and tasks awaiting an answer are red. Never reuse red for anything but a requested answer. Collapsed only, like a session parent, the chevron takes the most urgent attention among the OTHER entries (answer, working, unseen completion), with counts in its label; like interrupted child sessions, interrupted, paused and prepared entries colour only their own rows. Row actions live only at the top of the selected detail (`components/mission-action-bar.tsx`, `mission-selected-actions.tsx`): ▶/⏸ (becomes coordinator recovery only for an interrupted mission and, to resume it, a failed one), Stop… (schedules add Run now), then the Summary eye, Open conversation, edit and delete — always visible, disabled when not applicable under the object's owning control path and H9 editing guards, never folded into a `…` overflow menu; Request an update is a compact left-aligned `.window-text-button` below the toolbar (above the task separator, `--space-sm` rhythm), relabelled and disabled while pending/uncertain, hidden when unavailable (a schedule keeps one only for secondary controls such as Run now). Retrying an unconfirmed control belongs to the header ⟳: it reads status first, then resends only a still-unconfirmed exact request (original requestID/expectedRevision) from that explicit click. Stop and Delete confirm first. Selection uses the shared `--list-item-highlight-*` tokens; never use the input-field surface (`--surface-base`) as a panel or popup background. Nothing is selected by default, and only the picker changes the persisted per-project selection: opening a Mission's conversation never reselects it.
- Nothing renders below the list until a Mission or schedule is selected. The selection's detail is then a separate `section.mission-detail` after the whole list (`components/mission-tracking.tsx`, `styles/panels/mission-detail.css`), never inside its row: the action toolbar, whose "Summary" eye (`MissionActionBar`'s `.mission-overview-toggle` `icon-toggle`) toggles the central overview reader, then "Needs you" (`components/mission-attention.tsx`: one compact line per open native Form/permission with an Answer button; who asks stays in the tooltip and accessible description), then the task tree. `components/mission-task-tree.tsx` is THE task view: `mission-graph.tsx` draws only declared `blockedBy` dependencies (including completed/retired work, never inferred native ancestry) beside one row per task, each edge leaving and entering the measured status icons (done, active, awaiting input, assigned/ready, waiting, blocked, failed, retired); the status word lives only in the tooltip and screen-reader text. Clicking a node toggles its exact task reader; never add a per-row eye. The tree renders every task its map holds (a page of a large plan, with gaps, the attention notice and reads further: §Task pages), and the graph measures every row it renders, again whenever rows arrive; rows read their task and activity, and edges their endpoints, through keyed maps, so hundreds of tasks stay linear (`mission-panel-geometry.test.ts` reads a 500-task map further to every row and its 450 rails). All prose (results, summaries, briefings, explanations) belongs in the central reader. Graph styles live in `styles/panels/mission-graph.css`; the remaining shared list chrome (`components/mission-list-item.tsx`, `styles/panels/mission-list-item.css`) serves cleanup receipts.
- The overview reader (`components/mission-reader.tsx`) keeps the result/briefing/objective first and folds secondary material at its bottom through `components/mission-overview-details.tsx`: Plan changes, Reports (each opening its exact reader), conversation cleanup history and Technical details (mission/coordinator/schedule/passage IDs and requested profiles), plus the pending coordinator-notification note. Task and schedule readers also keep identifiers in a collapsed Technical details. Only cleanup that needs an explicit retry stays in the panel. Task readers consolidate bounded brief/report/evidence pages with dependency navigation and existing truthful execution/profile/notification surfaces. Useful recursive delegation guidance propagates through canonical assignment prompts; native runtime permissions and configured depth remain authoritative, never an imposed target or a root-fallback trigger.
- A selected daily document uses the same detail (`styles/panels/mission-schedule.css`): the same action toolbar, whose Summary eye opens the admitted passage's overview, else the daily schedule reader; one interrupted/uncertain sentence pointing at the toolbar's primary Resume/Check action and any last daily-check failure; the current passage's Needs you/tree when a passage is admitted; then a compact list of past runs (date · outcome), each toggling its exact run reader centrally. Running daily rows show their next run. Daily times use the schedule zone (`components/mission-schedule-text.ts`), labelled only when it differs from the viewer's zone. The central daily reader (`components/mission-recurrence-reader.tsx`) follows the same plain grammar: rule, the selected run's result (or one plain failure sentence with Retry), every run, and identifiers only in a collapsed Technical details. Unified native schedules use `mission-schedule-list.tsx` and its controls: saved policy, desired/observed states, next wake/check, source-check and launch/success counts, retained history and conversation links. Its Technical details disclose principal/reconciliation carriers, calendars and pending cleanup from the same document read (§User-journey regression checks).
- Task readers put results before collapsed brief/technical details. "Needs you" contains only open native Forms/permissions and routes "Answer" to the exact actor conversation and interruption dock; reported obstacles stay in the readers, and retired/replaced attempts never become current blockers. Tree statuses stay truthful: admission is only "Assigned", observed native activity alone is "Active", an observed native Form/permission is "Awaiting your input", unmet dependencies are "Waiting" and a reported blockage is "Blocked". Task navigation uses only exact owned non-coordinator actors, never a generic coordinator fallback or inferred bindings; the row's Open conversation supplies the single coordinator link. Uncertain sends are never replayed automatically.
- One-shot Missions and exact admitted daily passages share `components/mission-tracking.tsx`. The daily `recurrenceCurrent` derives the owned isolated journal; `recurrencePassageRead` reads archived bounded prose while CREATE retains its separate `recurrenceRead({ id })` lookup. Reader targets preserve exact instance/project/schedule/passage and semantic section identity, never arbitrary session selectors or transcript substitutes. Calendar CAS emits `rpc.codenomad.missions.scheduleChanged` only after commit through the fresh native graph's Bus; a wake warning that appears, changes or clears emits the same invalidation at the current revision, best-effort, without a calendar write. A lost invalidation never replays a mutation.
- `stores/mission-recurrence.ts` owns daily-document visible list/current/reader demand, connection fencing and coalesced trailing reads without polling, and preserves unknown holds across remounts. `stores/mission-schedules.ts` owns unified native document pages and selected reads. Their separate control and snapshot contracts are in `MISSIONS_RECURRING.md`.
- Archived and current remote reader numeric drafts use `components/mission-reader-number.tsx` and commit on Enter/blur, not the first digit. Keep existing toolbar DOM mounted during same-source reads; local in-memory reader pagination stays immediate. A selected schedule's past-run list lives in `styles/panels/mission-detail.css`.
- Coordinators publish project briefings automatically at business milestones (initial plan, each task settlement, waiting on a human, before the final report) with requestID `auto:<revision>` and plain user-facing summaries (`missions/recipes.ts`); briefings come only from these milestones and explicit requests. An explicit update request is `createMissionBriefingRequest` in `components/mission-briefing.tsx` (the "Request an update" text button below the selected toolbar; its pending/uncertain feedback shows under it). Full briefing/final prose and task sources belong in the central `MissionReader`, opened/hidden with the detail toolbar's Summary eye. The fixed request follows `lib/mission-coordinator-message.ts` through ordinary native admission. Match its exact request ID before acknowledging a received briefing, retain pending/uncertain state by identity, and never replay it automatically. The coordinator-only `missions/briefing.ts` contract records a bounded narrative with assessed revision and exact task sources, separate from observed activity/task settlement/final outcome. Show stale-map/new-result notices and source readers in the reader without inventing semantic updates or human requests. For existing missions without a briefing, expose bounded exact current results/obstacles in the overview reader and use the tree for the remaining plan. Mission rows say "In progress" for an open mission (its lifecycle state); never show declared task counts as progress. Terminal missions omit settled lifecycle actions but retain unresolved control receipts. Project cleanup uses one disclosure for pending and settled receipts.
- Mission display demand follows the actual right-panel visibility and selected tab. Preserve cached snapshots while hidden, cancel queued trailing display reads, and revalidate on activation. A component that shows a one-time Mission's full map registers it with `missionStore.want` and releases it on cleanup; never read `state().missions` for a row, which holds only open and wanted maps. Only native lifecycle events (`session.execution.*`, compaction, inbox, Shell, Form and permission events) invalidate activity; text/tool-progress deltas never do. Explicit recovery reuses the selected Mission's ▶ and the tree's task recovery actions through `createMissionRecoveryAction`, mounted once per Mission row; never add a separate administration surface or an automatic mutation retry. A value the panel learns from a read, such as the list's reported project, enters a view-fence identity through `createReportedChanges` (`lib/mission-view-fence.ts`), per instance and Location. A first report that matches the project the instance metadata names, or arrives while none is known, is the view already shown, so an operation captured before the first list read (a creation submitted right after the panel opens) still completes. A first report naming another project, and any later different report, is another view.
- Missions preferences live in the Settings/Preferences window's Missions section (`components/settings/missions-settings-section.tsx`); the Missions panel header gear deep-links there via `openSettings("missions")`. `stores/settings-screen.ts` is the single Settings route for every entry point: local Electron/Tauri windows always reuse/focus the one native Preferences window with the active instance/Location; only browser and remote windows use the embedded screen. A native rejection (e.g. an installed host lacking the section, which needs a native rebuild) shows an error notification and never opens a second, embedded Settings surface. Keep the section allowlist identical across renderer, Electron and Tauri (`native-mission-preferences.test.ts`). Project-scoped parts (catalog, Location depth) use the opener's instance/Location and stay disabled without one. `components/mission-preferences.tsx` writes each choice at once, compare-and-swapped against the value stored at its turn. Edits made during a write stay enabled (disabling a control drops its keyboard focus) and queue behind it, shown immediately, across window/section remounts. Each edit touches one role or the task-session policy of one scope and is refused when that stored value is no longer the one it was made from, so a queued edit never overwrites another window's change to that value or resends a rejected edit of it. (Customizing an inherited role copies the global values shown at edit time.) A rejected or unconfirmed write is never resent: a read-only reload shows the stored values, with Reload offered only when that read fails or the document is unreadable. The fold's Reset (confirmed) clears only the shown scope's agents/models; resetting an unreadable document is a separate confirmed repair. Catalog/depth demand stays fenced by that section's visibility. Agent/model choices use one `MissionProfileControls` row per role everywhere (coordinator, then the type's roles, Debugging included). In a mission-type scope, rows show the inherited global values with a muted Global mark; editing a field customizes the role starting from those values, its revert icon inherits again, and an all-native choice remains an explicit override (inherit, native default and a selected profile stay distinct). Creation waits for loaded preferences, shows requested choices and keeps overrides collapsed. Profiles use compact square native selectors in `components/mission-profile-controls.tsx`; preference/profile/library layout lives in `styles/panels/mission-preferences.css`. Model selects list exactly what the conversation's model selector lists: the shared catalog build and display names (`lib/model-catalog.ts` `buildProviderCatalog`, also behind the composer's providers store) and its hidden-model/favorites-only list (`stores/model-picker.ts` `preferredModelList`), restricted to tool-capable models and grouped by provider; never filter or label models separately. A saved model outside that list stays selected (by name when known, marked Unavailable when the selector's usable catalog lacks it: missing, deprecated or without tool support) so a default never changes silently; stored values remain `providerID`/`id`. Summaries with an `instanceId` and catalog `directory` name models through `knownModelName`, never a catalog read: the newer of the conversation catalog and that Location's latest Missions read in the same native generation (an omitted directory is the workspace root, compared with `normalizeSessionDirectory`); technical details keep exact IDs. Saved briefs are bounded versioned brief-only records under existing owned UI preferences (`lib/mission-model-library.ts`). Creation shows one "Start from a brief" select at the top of Options that loads on selection (Remove/Reload in its small `…` overflow) and a footer "Save as brief" text button that asks for a name inline (`components/mission-model-library.tsx`, styles in `styles/panels/mission-create.css`); only Preferences keeps the full library manager and invalid-library repair. A selected one-time Mission, including a finished one, offers the same "Save as brief" text action beside its update request (`MissionActionBar` secondary row): `missionRecordedBrief` copies only its recorded objective, verbatim notes, template, frozen profiles and taskMode (the title only prefills the name). Loading copies into ordinary manual creation and is never a launch, delete preserves all executions, and arrays retain config merge-patch replacement semantics. Preserve exact choices in uncertain creation drafts. Defaults never silently reconfigure existing/busy actors.
- Delegation defaults apply per new Mission (`taskMode`, omitted means native); changing defaults or saved briefs preserves existing Missions. `mission-task-mode-controls.tsx` shares its compact native selector between preferences and the editor. Task agents use subagent/all in native mode and primary/all in independent mode; coordinators always use primary/all. Retain the policy with the creation/defaults snapshot and uncertain request identity, and preserve it in explicitly selected saved briefs. Explicit document edits may change task mode before admission or between eligible recurring passages under H9; admitted work keeps its frozen policy. Never change OpenCode configuration through task-mode selection. Ordinary internal helper calls remain governed by native permissions/depth.
- Delegation's native depth editor (`mission-subagent-depth.tsx`) is separately Location/project scoped and affects all OpenCode conversations there, unlike global new-mission defaults. Under the field it states that an override also lets subagents launch their own subagents in the project, taking precedence over General's restrictions from other config files; beside the effective depth it states whether General subagents can nest per the snapshot (no subagent at all when the tool is hidden; no other General subagent when only General is denied, other agents following their permissions) or that OpenCode's depth limit stops nesting below 2, never claiming nesting OpenCode would not allow, and it warns when an override saved only the depth. Demand only while the Preferences window's Missions section or the creation form's open Options show it, retain dirty drafts and exact file expectations by instance/directory, and never invent an unknown effective depth or label zero as disabled. Enter or leaving the field writes a changed valid value (Inherit writes at once; pressing it keeps focus in the field so the typed value is not saved first; Escape discards an unsaved value) without reload/restart; invalid values are flagged, never written. A write acknowledged after the view was left or hidden is accepted and reread on the next activation. Reads and writes make the field read-only rather than disabled, preserving focus; the saving status shows only while a write or a discard confirmation is in progress. The refresh icon appears only after an error or an unconfirmed write; uncertain writes remain fenced until that explicit refresh and are never replayed automatically.
- Missions task scrolling uses `components/mission-panel-scroll.ts` (shared with the creation form's body) with `styles/panels/mission-task-tree.css`: the task flow fills the remaining panel height and owns scrolling when the header and task minimum fit; on shorter layouts the whole panel is the sole task-content scroller so controls remain reachable. Size/child-list observations select the policy without polling or oscillation. The picker retains its independently bounded list. Graph endpoints measure the status-icon edges in SVG coordinates, including RTL and zoom. Keep IME composition keys in the picker search, and preserve Space activation without a duplicate keyup click. Validate with `tests/browser/mission-panel-geometry.test.ts`.
- One-time Missions ships through `DesktopPluginLifecycle("missions")` and backend presence, with project-scoped native storage. Every backend that publishes its loopback bridge provisions it, desktop or standalone. Bridge registrations name only `http://127.0.0.1`: the bridge reuses the HTTP listener only when bound to 127.0.0.1/0.0.0.0 (`acceptsIpv4Loopback`), otherwise (HTTP not requested, IPv6/`localhost`/LAN HTTP-only) it gets an unannounced private listener on a random 127.0.0.1 port. All listeners of one backend share a single `WorktreeDeletionFence` (with its mission holds), so a deletion through HTTPS drains bridge admissions. Window/browser automation stays desktop-only; without a desktop host the bridge's `browser-claim` answers only `purpose: "mission"`. The Missions snapshot distinguishes `host-unavailable` (no bridge, answered without reading OpenCode), `plugin-unavailable` (OpenCode has not loaded it) and `plugin-failed`; never tell users to reconnect CodeNomad for a plugin OpenCode must load. Keep roles independent of native execution IDs. Persist explicit agent/model/variant selections and never switch a busy actor for a queued task. Preserve authenticated admission, ownership/connection/worktree fences and per-send profile environment. One-time map update/control/delete/recovery routes share `server/routes/mission-map-mutation.ts`: creation's fenced connection and worktree-deletion admission, a fresh workspace/connection/location recheck after all preparation, and the permit held through the single unretried RPC. Validate one-time behavior with the isolated `scripts/test-missions-native.mjs` fixture.
- One-time Missions use the journal `codenomad-missions/v2` with wire/schema version 1 and its one-time receipts. Never read, import, mutate, delete or initialize the `codenomad-missions/authority-*` namespaces, register a managed-owner observer, add `migrateLegacy` or add migration UI (`desktop-plugin.test.ts` traps that namespace access; `managed-owner-plugin.test.ts` keeps the managed-owner observer and authority modules out of the bundle). Rollout requires the daily acceptance journeys in `MISSIONS_RECURRING.md` (`MISSIONS_RECURRING_QUALIFICATION.md`), the unified native protocols in `MISSIONS_NATIVE_SCHEDULE_TRANSPORT.md`, service supervision qualification in `OPENCODE_RUNTIME_SETUP.md` and §User-journey regression checks above.
- `packages/server/src/host-lifetime/` holds the private-storage, process-identity and profile-scope primitives Missions uses (`storage`, `private-storage-sync`, `windows-storage`, `process-identity`, `protocol`) and service-wide OS supervision, its private manifest, foreground guards and owned runtimes (`service-supervision-*`, `OPENCODE_RUNTIME_SETUP.md`); never add a persistent CodeNomad backend host to it. Never replace a native ownership gate with a no-op or environment flag, steal a live/unknown owner, log secrets, or include the shared OpenCode daemon in backend cleanup.
- One-time lifecycle state and actions live in `createMissionLifecycle` (`components/mission-lifecycle-controls.tsx`), surfaced only as the toolbar's primary action and Stop, with Check status for an unresolved request; family interruption lives in `missions/native-family-interrupt.ts` and follows Explicit execution controls above (`readNativeControlFamily`, never the 32-session display read; never claim a full stop without a complete `descendants` receipt). Do not turn notification recovery into a control-action runner.
