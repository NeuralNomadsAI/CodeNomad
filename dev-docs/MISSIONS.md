# CodeNomad Missions / Session Mesh

Missions coordinate native OpenCode V2 work through a durable project map,
dependency-aware tasks, human controls and readable results. OpenCode owns execution;
Missions gives the user a coherent way to specify, follow and reuse that work.

The target product contract is the description of
[PR #866](https://github.com/NeuralNomadsAI/CodeNomad/pull/866), including permanent
recurring missions with CodeNomad closed. Implementation status and qualification
are tracked separately in [`MISSIONS_REFACTOR_VALIDATION.md`](MISSIONS_REFACTOR_VALIDATION.md).
Historical experiment documents are dated evidence, not release approval.

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
subagent calls; it does not create another execution queue. Native helpers return
through their actual parent; the coordinator records the declared task's business
readout without requiring duplicate reports from every descendant. Explicit
independent actors retain correlated report notifications and native queue delivery.

Model-facing mutation results stay compact (`missions/tool-result.ts`): the
disposition, current revision, run state, frontier and the affected tasks
(status, generation, dependencies and lineage), never briefs, reports or the
objective. Only `mission.inspect` returns the full map; `mission.inspect({ taskKey })`
rereads one task with its contract and exact current assignment prompt. A native
Wayfinder `decision` declaration also states the human-answer requirement that
`verifyHumanDecision` enforces, so a self-contained analysis goes to `research`.

Coordinator actions that need native reads or effects outside the plugin's
Promise API cross the authenticated desktop bridge (`sendMissionInput`), so they
exist only with backend presence and refuse otherwise. Scheduled passages have no
such route: their coordinators are not offered `mission.interrupt` or
`mission.prepare`, nor told about them.

- `mission.inspect({ taskKey })` adds the task's observed native conversations
  (`server/routes/mission-task-native.ts`): the coordinator's direct children
  whose first user message carries that task's canonical assignment header
  (`missions/task-sessions.ts`, shared with the UI). This is advisory display
  evidence, never settlement.
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

A native Wayfinder decision readout may omit its artifact: the human-answer gate's
`discover` finds fresh children of the expected parent whose `subagent` call
carried the exact assignment prompt, reads their confirmed UI marks and keeps
only answers its own `verify` accepts. A reached bound, a pending mark or a
confirmed answer that fails verification makes the discovery incomplete. Only a
complete discovery with exactly one candidate fills the artifact; anything else
refuses, and `inspect({ taskKey })` lists the candidates as ready artifacts with
their completeness. Nothing is inferred from text, titles or timing.
`mission.briefing` treats requestID `"auto"` as `auto:<revision>` and may omit
`basedOnRevision`: the server then uses the current revision, or refuses a
different summary when the latest automatic briefing is still the last event. One replacement task may merge several retired tasks; it names one
of them in `replacesTaskKey`.

## Compare two models (`compare`)

The coordinator writes one task/input/criteria protocol; `model-a` and `model-b`
receive byte-identical briefs and use required, different provider/model pairs.
Their instructions and report contract are shared; per-task model changes are refused.
The fresh `comparator` always judges anonymized X/Y outputs, even failed attempts,
using the coordinator's model by default. Creation warns if the judge matches A/B.
Version-1 `comparison` contains completed A/B `runRefs`, both scores (0–10) per
criterion, evidence for each observation and `a`/`b`/`equivalent`/`inconclusive`.
Current and archived readers show the verdict, model names and criterion scores.
There are no lessons, approval, publication or separate protocol/run artifacts.
Blinding is an instruction/data-presentation policy, not tool isolation.
N-model comparisons, automatic per-run worktrees and composer launch are deferred.
Native proof: `node scripts/test-missions-native-trajectory.mjs <CLI>`.

## Durability and recovery

### Human instructions and actionable attention

Mission Control separates mission lifecycle (an **open** mission, not a claim of
activity), the dated coordinator project briefing, and observed native activity.
Open native Forms/permissions ("Needs you") are
the only human-response alerts. Returned blocked reports are obstacles to read,
not an assertion that the user must decide something. Retired or replaced blockers
remain readable in the historical results but are not current requests.
Actionable requests precede the task tree. Without a briefing, the
overview reader exposes bounded exact current task achievements/obstacles, not an
invented synthesis; absent evidence is not replaced by old attempts. The side
panel shows the selected mission's action toolbar, "Needs you" and the complete
declared dependency tree, without repeating task prose or a second remaining-work
list. There is no conversation/ancestry view: the toolbar's "Open conversation"
opens the coordinator, and task rows open only their exact owned actor.
Declared task counts are never shown as a product completion percentage. All
declared tasks being complete does not imply that the mission has been finalized.
The single canonical report list (including current, previous and late results),
plan-change history and settled cleanup history fold at the bottom of the overview
reader, not competing top-level tracking surfaces. Only cleanup awaiting an
explicit retry stays in the panel, in one disclosure without a second nested
cleanup section. Pending receipts keep explicit retry and their original mutation
identity. Empty plan history is omitted. Settled terminal lifecycle commands
disappear; unresolved control receipts remain available.

### On-demand project briefing

The 2026-10-06 tracking simplification is source-only, not a new installed build.
(Its guidance forms and shared mission rows were later removed from the panel; the
dated counts below describe that earlier surface.) Qualification includes the real Solid browser fixtures: briefing/control/cleanup/
guidance/shared rows and lifecycle revisions (60 passing across the latest runs), result/task readers and report delivery
(23 passing), plus tracking/briefing/view-fence unit and locale checks (18 passing)
and the UI typecheck. Captures were read at 440/280 px panels and a 390 px viewport,
including a full-width central briefing reader. The fixture's central surface uses
the production relative-positioned transcript host so its absolute reader cannot
cover the neighboring panel. These checks do not qualify model synthesis quality
or mutate a live mission.
An incorrectly placed test-only terminal-settlement update was corrected: ordinary
uncertain Pause retries still require a mounted settled strip; completed Stop retries
require its disappearance while retaining the exact request/revision assertions.
The full lifecycle/shared-row rerun passed 18/18. A fixture-start timeout seen in the
preceding combined run did not recur; no timeout extension or automatic retry was added.

“Request an update” (a text button below the selected mission's toolbar) composes
a fixed application-authored request with the exact mission ID, a unique request ID
and the UI language. The user does not write a prompt. It is the only coordinator
message the panel sends (`lib/mission-coordinator-message.ts`), through ordinary
coordinator prompt admission: fresh owned snapshot, exact project/coordinator, view/connection/lifecycle fences,
targeted hydration and native profile preservation. No session selection, composer
edit, plan mutation, task dispatch/replay, model switch or implicit Play is added.
It does admit a normal native coordinator turn, not a separate read-only LLM;
instructions prohibit new execution, but are not a sandbox removing native tools.

The coordinator publishes a bounded `mission.briefing` (summary and at most three
entries each for achieved/ongoing/obstacles/next, with exact live task-key sources).
This coordinator-only journal event records its assessed revision/time and a
server-assigned publication timestamp. Its exact immutable request replay is
idempotent; conflicting IDs, stale revisions, missing/retired sources, damaged
journals, moved roots and non-running/pending-control missions fail closed. The
event changes no task, result, notification or final outcome and sends nothing.
The reducer independently checks author, lifecycle, source identity and the
assessed journal prefix. Durable-plugin publication keeps the existing authority
grant and signer gates; it does not enable persistent-host rollout.

The latest briefing is plainly attributed to the coordinator, not labeled as an
observed execution fact. The panel shows no briefing text; the selected mission
toolbar's Summary eye opens the overview reader in the central message area, which
carries the complete briefing with its date and stale notice. The highlighted eye
hides it on a second click; clicking a task-tree node toggles that task's reader the
same way. Closing the reader clears the highlights.
Source buttons in the full briefing open the exact task result/brief reader.
New current task results since the assessed snapshot are counted; other map
changes produce a separate stale-map notice, not a fabricated progress delta.
Sources that later retire remain historical reader targets, never fresh proof.
The briefing is retained while stale. Terminal mission summaries take precedence.
Coordinator instructions (2026-10-09) ask for unprompted briefings at business
milestones: after the initial plan, after each task settlement (completed, failed
or blocked), when starting to wait on a human and right before the final report.
These use requestID `auto:<revision>` with the same freshly inspected
`basedOnRevision`; each publication advances the revision, so the existing
idempotency/conflict/stale-revision contract applies unchanged and no server
validation differs. There is still no timer, per-tool briefing or hidden request.
Report and briefing summaries are written for the human (user's language, 3–5
plain sentences, outcome first; IDs, tool/fixture names and commands only in
`evidence`); the final report states delivered/remaining/decision in ≤6 sentences.
Recurring passage coordinators receive the same milestone and summary
instructions through their actor context; the frozen passage start text remains
the verbatim instructions. Schedules have no "Request an update" button.

Request admission is visibly distinct from receiving the matching request-ID
briefing. Pending/uncertain requests survive mission navigation and remount in
window-local memory. A seen exact response remains recognized if a later briefing
replaces it. Snapshots also project `briefingResponses` for the 16 most recent
explicitly requested briefings; unrequested `auto:<revision>` milestones are not
retained there, so any number of them cannot send an answered request back to
waiting. Only 16 newer answered explicit requests can evict an unseen answer.
No mutation replay, automatic retries or background polling is added.
An explicit, confirmed separate request is possible after checking the native
conversation (for an unresponsive coordinator, unsupported tool or lost ACK).
Memory does not survive application restart or coordinate independent windows;
ordinary native conversations retain the actual prompts. This is not proof of
general planning quality, semantic freshness of every source report, or model
consumption. An older plugin cannot publish this event: the fixed prompt forbids a
substitute task and asks it to explain the missing tool in the conversation.

The panel has no direction or question form. To steer a mission or ask the
coordinator something, the user opens the coordinator conversation ("Open
conversation" in the selected mission's toolbar) and writes in the ordinary
composer. That is an ordinary native prompt under native admission,
permissions and the per-send profile environment, not a Mission-specific channel:
it changes no plan or profile by itself, and its admission is not proof of model
consumption. For a recurring schedule, the same action opens the admitted passage's
coordinator.

Task-tree rows and task readers link only to an exact owned non-coordinator task
actor when recorded. Missing bindings produce no generic coordinator substitute. The
selected mission's toolbar keeps the single coordinator action. Native ancestry or text mentioning a
child session never manufactures a task/actor association. Task readers show the
current result/evidence/next steps first; the brief and native technical metadata
are separate collapsed details. A historical late attempt must not replace a
current result or become evidence of current completion.

Reader pages retain exact surrogate-safe source slices. `mission-markdown-pages.ts`
adds bounded display-only continuation fences for standalone fenced code; interrupted
or oversized fence contexts fall back to literal source pages. Copy always uses
the complete original section, not synthesized Markdown. Arbitrary list/table/quote
excerpts are not a promise of full-document Markdown pagination equivalence.

Browser fixtures exercise real Solid components/generated clients against
isolated HTTP responses; they never send a request to a user's live Mission.

### Defaults, reusable briefs and separate executions

The Missions section of the Settings/Preferences window (opened by the Missions
panel header's gear) owns the global requested coordinator/task profiles. The
all-scenarios selection supplies the baseline; scenario-specific choices override it.
The creation form waits for preferences before freezing its initial choices,
shows the requested choices and keeps individual overrides collapsed. Opening a
closed override must not demand an agent/model catalog. Default changes affect
newly prepared missions only: no running actor is silently reconfigured, and a
missing requested profile never authorizes an unrelated replacement. Inherit,
native default and a specific selected profile have distinct meanings. Identical
requested profiles are summarized together, without a catalog read or execution claim.

Reusable user mission models are bounded, versioned brief records in the existing
owned UI preference bucket: name, objective, notes, scenario and optional requested
profiles. They contain no sessions, reports, execution claims or credentials.
Saving/loading/removing is explicit; removing a brief keeps all existing missions
and conversations. Loading copies a brief into the ordinary creation form. Each
creation uses the existing authenticated mission route and explicit Play control,
not an automatic prompt to a reused accumulating conversation. An uncertain create
retains the original submitted payload; mutable defaults or saved models must not
alter a replay. Schema versions here are not a durable history of brief revisions.

There is no scheduler or GitHub-specific trigger in this iteration. A saved PR
review brief can describe repository scope, candidate selection, freshness and
human validation before publication; it does not grant publication authority or
implement deduplication by itself. Date/recurrence/event automation is part of the
new delivery contract, with explicit activation, bounded overlap/missed-run policy,
stable passage identity and publication safeguards. Continuing existing native
background work and starting tomorrow's scheduled passage are separate acceptance
tests; both must work without an open CodeNomad window.

The unactivated core is implemented in `missions/recurrence-{contract,clock,store,runner}.ts`
with native durable JSON, stable passage/message identities, one in-flight passage,
latest missed-run catch-up and exact terminal/rejection receipts. Twenty-two tests
and an independent follow-up cover DST gaps/folds, optional native variants, watch
removal/re-add, damaged storage and lost acknowledgements. It retains 30 reference
receipts and up to 64 remembered conversation cursors, without deleting native
transcripts or silently resetting deduplication. This core is not a scheduler
activation or closed-desktop qualification; owned admission, archive composition,
  a service-owned due Job and packaged host integration still need delivery.

### User-journey regression checks

Run real Solid/HTTP fixtures, never a user's live mission, for these questions:

| Moment | User question | Required evidence |
| --- | --- | --- |
| Before | What will run, and with which requested agents? | Loaded owner preferences, visible requested choices, explicit brief copy and prepared creation |
| During | What has happened, what remains, do I need to answer? | Current recorded results/counts, separately observed native activity, real open Forms/permissions |
| Blocked | Is this my decision, or a work obstacle? | Blockage result is readable without manufacturing a human request or a coordinator task link |
| After | What did I get and can I verify it? | Full bounded result/evidence/next pages, historical late results marked separately, no default raw artifact wall |
| Reuse | Can I launch it again without changing yesterday's run? | Fresh manual mission creation, copied brief/profile payload, removal preserves executions |
| Failure | Will a retry duplicate work or lose my input? | Exact held create/send identity, no uncertain replay, conditional preference writes and stale-view fencing |

`packages/ui/tests/browser/mission-control.test.ts`, `mission-briefing.test.ts`,
`mission-task-reader.test.ts`, the editor/default/model fixtures, the
`src/components/mission-attention.test.ts` open-request projection and the
progress projection unit tests cover these surfaces. Native `test-missions-native.mjs`
provides a separate isolated execution/storage proof. A deterministic provider
proves the native transport and result lifecycle, not real-world PR review quality,
automatic publication policy or unattended scheduling.

`node scripts/test-missions-native-trajectory.mjs <absolute-isolated-cli>` drives
prepared → Play → two independent declarations → native sibling/grandchild work
→ native returns → coordinator readouts → terminal completion. It requires real
simultaneous native activity and separately verifies that successful child returns
do not themselves settle Mission tasks. Its private receipt retains checkpoint
snapshots and provider-turn evidence. An optional third argument supplies only a
read-only bare-dependency resolution root for checkouts with missing test packages;
it never substitutes another checkout's source or connects to its running service.

The baseline native fixture also qualifies explicit independent-root assignments.
Managed-root reuse keeps original creation ownership separate from immutable cleanup
provenance; a later assignment cannot recreate the original root or bypass a lost
creation acknowledgement. Native request-conflict and a desktop HTTP uncertain-create
response are deliberately different boundaries, with exact parked request identities.

Mission preference arrays use field-level compare-and-merge against their raw owned
document. Failed/malformed reads do not authorize writes; explicit repair compares the
actual invalid field. Conditional writes reread disk synchronously and preserve
unrelated fields. This prevents renderer lost updates, but is not a cross-process
filesystem lock against an OS writer between read and atomic replacement.
Intervening UI events make save acknowledgement ordering ambiguous: reconcile through
at most three fresh bounded owner reads, never another write. A successfully accepted
but unreconciled save leaves creation fenced until a reload succeeds: Settings issues
one read-only reload by itself and offers an explicit Reload only if that read fails,
while the creation form and the saved-brief library keep their explicit Reload.
Earlier GETs/ACKs never substitute stale cached defaults as authoritative creation input.

Settings saves each defaults choice at once. Edits made during a write queue behind it,
each applied to the document stored at its turn and compared against it; a role or
task-session edit is refused when that stored value is no longer the one it was made
from, so it never overwrites another window's change to that value or resends a
rejected edit of it. Customizing an inherited role still starts from the global
values shown at edit time.

### Parallel workstreams and context reuse

The coordinator charts every explicitly requested workstream as soon as its work is
clear, including actionable preparation for a blocked deliverable. It launches
independent ready assignments with runtime-supported background/concurrent native
calls before waiting for one result. Missing tooling or consent in one workstream
does not stop unrelated ready work. Real evidence/permission gates, resource limits
and conflicting shared writes remain reasons to serialize; the coordinator must
name that reason rather than manufacture an order.

`blockedBy` is a business prerequisite. `reuseFromTaskKey` is an explicit native
context/actor choice and does not require or create a `blockedBy` edge. A fresh
native child is preferred for independent work; eligible reuse still requires the
exact live native source, unchanged parent, actual source return and fresh idle
observation at admission. It never permits concurrent work on the same actor.
The Debugging playbook's resolver still requires dependency-connected implementer/review evidence,
and its reviewers/validator remain fresh distinct actors. Mixed admission cycles
remain rejected. Neither declaration nor business readiness proves native activity.

This removes an erroneous general policy gate, not native execution gates or a new
automatic scheduler. Prompt guidance cannot guarantee an LLM will always chart the
right workstreams; real native concurrency must be observed separately from tests
of declaration/frontier and structural authority. Existing mission plans are not
rewritten or replayed automatically.

Lifecycle RPC methods declare expected mutation failures as `mission.rejected` with a structured `data.code`. Plugin handlers convert only recognized `MissionControlError` failures via the native invocation's `context.error`; the HTTP routes map those codes to 409 (conflict), 404 (missing), or 403 (ownership). Ordinary exceptions remain opaque plugin failures (503). The isolated native fixture exercises stale update/delete, request-ID conflicts and unknown missions through the real HTTP-to-RPC boundary.

The map is an append-only event journal in native plugin storage. Events have deterministic identities, and native prompt/synthetic admissions use deterministic message IDs. Retrying after a plugin or CodeNomad restart therefore resumes an incomplete dispatch without creating a second task, actor, or inbox item.

Report persistence and coordinator notification are separate steps. A saved `task.reported` without a matching `report.notified` acknowledgement is a pending notification, not proof that the coordinator has resumed. Active plugin instances recover these notifications on activation and retry with bounded backoff through the same authenticated bridge. They reuse the deterministic native message ID, skip acknowledged reports and prepared/paused/terminal/deleted missions or incomplete native control actions, and stop recovery when disposed. This outbox only delivers already-written reports; it never dispatches tasks or chooses a workflow transition. The snapshot exposes `report.notificationStatus` (`pending` or `admitted`), and Mission Control shows pending notification delivery separately from task completion. Admission is not evidence that the model has read the report or followed its recommendations.

Once a report is saved, a failed notification or lost admission acknowledgement does not fail the report call. Failed journal persistence still fails and sends nothing. A report from an actor moved out of its exact admitted location is rejected. Reports arriving after terminal Stop are preserved as late evidence without completing withdrawn tasks, reopening the mission or waking its coordinator.

### Targeted recovery

`POST /api/workspaces/:id/missions/:missionID/recover` brokers only the typed `recover` RPC, with `{ expectedRevision, target: "coordinator" | "report", taskKey? }`. This is an explicit intervention, not assignment replay: one deterministic native synthetic message identity is derived from the existing mission revision and target. Report recovery requires an existing unresolved admitted task; coordinator recovery references the saved map and reports. Paused, prepared, terminal and pending-control missions reject recovery.

The authenticated owning backend checks native activity, inbox, descendant inventory, running Shells, Forms and permissions before preparation and again after applying the fresh full profile environment. Incomplete/failed reads fail closed; unknown Shell ownership and running descendants block the nudge. The bridge exposes only fixed, redacted recovery error codes. The response `admitted: true` acknowledges admission, not model consumption or mission success. These bounded checks do not form an atomic native environment/activity/input transaction and are not a recursive cancellation guarantee.

### Refactor qualification status

The independent-of-desktop target and private proof artifacts are documented in `MISSIONS_CONTINUITY_CONTRACT.md`; the continuity, authority and host spikes are preserved on `preserve/missions-full-20261009`. They are not proof of a shipped persistent authorization backend or secure migration. The current product still follows backend presence; native trust provisioning, known-writer exclusion, service-owned due work, packaged parity and final Gatekeeper acceptance remain open. Electron/Tauri persistent-backend detach/reattach is separate research on the local branch `experiment/host-lifetime-foundation-20261009`. Interrupting a parent alone cannot prevent a native background child's late notification from waking it.

Snapshots are authoritative reconstructions of the journal. RPC events are only invalidations; the UI always reloads a snapshot after reconnect because native event subscriptions are live-only.

Project mutation and journal-append exclusion is shared by all bundle incarnations in the native host. Disposing registrations does not release an in-flight mutation's lock: a content-addressed replacement must wait before reading its CAS revision. `missions-reload.test.ts` loads two independent compiled bundles and races updates across dispose/setup to verify that only one can succeed.

Mission Control manages map metadata through the authenticated CodeNomad routes `POST /api/workspaces/:id/missions`, `PATCH /api/workspaces/:id/missions/:missionID`, and `DELETE /api/workspaces/:id/missions/:missionID`. These broker only the typed `create`, `update`, and `delete` methods of `codenomad.missions`; they do not expose generic RPC. Create uses a stable request ID, may attach an owned root session or create a new root without prompting, and accepts an optional `title` (trimmed, single line, 1–60 characters, `missions/mission-title.ts`). The title is part of the exact creation request and `mission.created` event, is exposed as `MissionMap.title`, and names new coordinators `Mission · <title>` (otherwise a title derived from the objective's first sentence). Historical missions without a title stay untitled; the UI derives a label. Update uses revision compare-and-swap for objective/notes. Delete appends a tombstone: the map disappears from snapshots and membership. By default every conversation is preserved. Late reports for a tombstoned mission cannot recreate its map. Tombstones remain subject to the project journal event limit.

Deletion optionally accepts `deleteManagedSessions: true`. Immutable targets are recorded in the tombstone, and per-session receipts reserve journal capacity before removal. Only deterministically created specialist roots with matching native creation metadata and exact project/location identity qualify. Coordinators, reused sessions, actors referenced by another mission (including finished/deleted maps), and roots with children are retained. Native removal is recursive, so descendants are outside this opt-in. The plugin delegates removal to the authenticated desktop bridge: installed native plugin contexts do not expose `session.list/remove`. The bridge obtains authoritative intent through the narrow read-only `cleanupTarget` RPC, revalidates ownership/connection/worktree fences and calls the native HTTP client. It never modifies OpenCode storage directly. An incomplete cleanup returns `503 cleanup-pending` after the tombstone is committed; replay the exact original request ID, revision and option. The editor retains that request through live snapshot refreshes and locks the option after the first attempt. Cleanup has no background dispatcher.

### Explicit execution controls

The UI creates missions with `prepared: true`. Its one-screen form has a single **Create** button that only creates; the prepared mission is then started by its explicit Play, never automatically by creation. A single Play button starts a prepared mission or resumes a paused one; Pause and terminal Stop are adjacent. Existing/agent-created mission journals remain running unless an explicit control changes them. `POST /api/workspaces/:id/missions/:missionID/control` brokers the typed `lifecycle` RPC (`action: start | pause | stop`, `requestId`, `expectedRevision`).

`mission.control-requested` records the durable desired state and exact root actors before native side effects; `mission.control-applied` receipts track acknowledgements. The project mutation lock serializes controls with assignments and report admissions. Partial failure returns `503 control-pending`, and the snapshot retains the original request and remaining targets for an explicit retry, including after a UI/plugin restart. Old completed requests cannot replay their side effects over newer states. Stop may supersede an incomplete start/pause; no action can restart a stopped/completed/failed mission. Receipt capacity is reserved before intent publication.

Pause immediately calls native `session.interrupt({ resume: false })` for the coordinator and all specialist roots, and first for every active native descendant of each root (see recursive interruption below), preserves task/inbox context, blocks new Mission dispatch/revision/finalization, and parks report notifications. A report arriving while paused is saved without waking the coordinator. Play resumes the coordinator and roots with unfinished admitted work via stable-ID native synthetic admissions, with fresh server-side environment and Git context and unchanged native agent/model selection. It does not automatically create or dispatch a new task graph.

Stop is irreversible for that mission. It interrupts those roots, cancels this mission's pending native inbox inputs, retains conversations/results, and withdraws unfinished tasks. Native controls always pass through the authenticated desktop bridge, authoritative snapshot, exact ownership/location and worktree/connection fences. Interruption acknowledgement is not an exact suspension of a tool process.

**Recursive interruption (best effort, honestly reported).** Tasks often delegate recursively with the ordinary background `subagent` tool, so a mission family can hold hundreds of native sessions. For each Pause/Stop root target the backend walks native descendants with `readNativeControlFamily` (up to 4096 sessions, paginated, cycle-safe; inconsistent or foreign children are skipped and make the walk incomplete), then interrupts active ones level by level, deepest first, before the root. Native background subagent jobs deliver their (cancelled) result to the parent inbox asynchronously with `resume`, which would wake an already interrupted parent, and a still-running parent may launch new subagents meanwhile; up to three bounded passes therefore re-read the family and `session.active` and interrupt again, with a final quiet read. The deadline is checked before every session, and in-flight native calls are cancelled at it. Native read or interrupt failures and the deadline make the receipt partial instead of skipping the root interrupt. After the root interrupt the backend re-reads the family once to interrupt sub-agents the root launched before its interrupt landed, settles the root, and re-reads once more to verify. Stop additionally cancels queued user/synthetic inputs in descendants, and on the root cancels this mission's inputs plus native `metadata.source === "subagent"` deliveries, including ones arriving during a short settle loop after the root interrupt, so cancelled-child results do not re-wake a stopped coordinator. Pause cancels nothing: deliveries stay parked behind `resume: false` and are processed when Play resumes the coordinator. The descendant passes run under a 50 s family budget and each post-root read under 10 s, inside an 85 s lifecycle bridge timeout (below the plugin's 95 s).

The `interrupt-observed` receipt gains an optional `descendants` summary: `observed`, `interrupted`, `cancelled`, `unconfirmed`, `complete` and up to 64 interrupted session IDs. `complete` is true only when the family was fully enumerated, the deadline did not expire, no descendant or the root remained active or had a failed cancellation, and the verification read after the root settled observed the whole family quiet. Otherwise the UI shows a compact "Some sub-agents may still be running." status beside the toolbar; it never claims a full stop without that evidence. Older receipts without the summary claim nothing. Late deliveries after the settle loop and external wakeups remain possible; that is the residual limit, not a guarantee. Play's coordinator prompt lists only descendants that the latest preceding Pause receipts reported interrupting (projected as the start operation's `pausedDescendants`) and that are still natively interrupted; user interruptions and earlier, already handled Pause cycles are never attributed to that Pause, and a partial receipt adds only a generic hint.

On Play, the coordinator's resume message lists descendant conversations whose native `outcome` is `interrupted` (mapped to task keys when the conversation is a task actor, bounded to 32) and asks it to re-delegate or continue them; no workflow engine replays assignments.

Display activity and recovery keep the 32-descendant bounded read. When it fails (an oversized family), a bounded ancestry probe over `session.active` reports the actor `running`/`background`, and targeted recovery answers `recovery-busy` rather than `recovery-unknown`, on positive evidence only. The UI offers coordinator recovery only on observed `idle-without-report`, never on `unknown`.

`mission.revise` is a coordinator-only, append-only plan change with `expectedRevision`, stable `requestID`, and a required reason. It can update objective/notes, add tasks with new keys linked to retired predecessors, retire tasks, and rewrite dependencies in one atomic event. A retired task is not completed evidence. Every remaining dependent must explicitly point to a live task or remove that dependency; cycles and edits to already dispatched dependencies are rejected. Existing task contracts and reports are immutable. A late report from retired admitted work remains visible as late history and never changes the task back to completed. Revision itself does not interrupt sessions or reconfigure busy actors.

Mission snapshots expose the latest 50 plan changes (`history`, with `historyTruncated` when older entries are omitted), including human objective/notes edits and coordinator revisions. Each entry has a revision and timestamp; `source` distinguishes `user` from `coordinator`. Human edits intentionally have no synthetic actor session or reason; coordinator entries retain their actor and required reason. Older history entries without `source` are coordinator-originated. Snapshots also expose task lineage (`replacesTaskKey`/`replacedByTaskKey`), late reports, and `outstandingExecution`. A withdrawn task with admitted native work must receive a terminal report before the mission can be finished; runtime idle is not proof that queued/admitted work stopped. This is bookkeeping, not native cancellation or a guarantee that an external actor has stopped working.

`node scripts/test-missions-native.mjs <absolute-isolated-opencode-cli>` exercises native tool registration/restart plus revision, late-report delivery, lifecycle create/update/delete replay, tombstone projection, and transcript preservation. Report checks observe the actual provider request containing the report after resuming both an idle and a busy coordinator; waiting for native idle alone is not proof of consumption. It provisions its own home/config/database/provider and must never be pointed at the shared daemon.

The notification recovery regression removes the private bridge before a report, proves the report was durably saved despite admission failure, restores the bridge with and without a plugin restart, and requires a provider turn containing that report without another report call or human prompt. It also checks that an explicit replay after acknowledgement retains a single correlated native message and does not cause another wake-up.

## Native execution and new-mission policy

`taskMode` is the new-mission task-session policy: omitted/`native` keeps native
delegation as the default; `independent` requires explicit independent task
contracts, including additions through plan revision. The policy is stored with
creation, native RPC and the journal; uncertain creation retains its original
selection. It does not change old missions or disable ordinary internal helpers.
Explicit independent work still uses owned root admission, not a fallback after a
denied native call. The durable composition's root capability remains its own gate.

Requested coordinator profiles use visible `primary/all` agents. Task profiles use
`subagent/all` in native mode and `primary/all` in independent mode. Models must
be enabled and tool-capable, with exact provider/model/variant identity. Roles,
requested defaults, actual Session selection and historical invocation profiles
are distinct facts.

The depth editor uses the authenticated connected runtime's declared
`experimental.subagent_depth` integer contract, not a version allowlist. It reads
effective native documents and edits only the selected owned Location's local
JSONC layer. Saving compares the original full file/target expectation and
preserves comments, sibling fields and WSL atomic-write protections. Removing the
override restores inheritance. Missing effective/default data remains unknown;
zero is displayed as a number, not guessed to mean disabled. No automatic reload,
restart, permission edit or mutation replay is introduced.
`node --import tsx scripts/test-subagent-depth-settings-native.mjs <absolute-isolated-opencode-cli>`
qualifies this against a private runtime (no project discovery, reload or shared
service): the native depth capability, project JSONC save/reset preserving comments
and sibling fields, stale-expectation conflicts and foreign-location rejection. It
passed on Windows with OpenCode 2.0.26 on 2026-10-11 and runs in the latest-runtime
CI job. It does not qualify depth-0 execution semantics or watcher activation.

Activity and targeted recovery share `missions/native-session-family.ts`: a root's
bounded native descendant inventory (32 maximum) must have consistent parent,
project and exact location identities and no remaining page. An idle root with an
active child is background work, a descendant inbox prevents idle-without-report,
and descendant/global native waits are reflected as waits. Failed or partial
inventory becomes unknown rather than a completion inference. No child session
is created, replayed or recursively stopped by these read-only projections.

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

Use actual catalog IDs. New actors support visible `primary`/`all` agents and enabled tool-capable models. Explicit selections are persisted in the task contract and passed to native `session.create`; retries cannot replace them. Omitted fields retain native defaults, so specify both agent and model for a fully pinned assignment. The UI displays these native identifiers beside the role.

An existing actor must already match the requested selection. Missions never uses `switchAgent`/`switchModel` to repurpose a busy actor: those APIs alter subsequent turns, not a single queued assignment. Native queues do not freeze a per-assignment model; external client changes after admission remain possible.

The historical root-only actor restriction from #673 is no longer the product
architecture. OpenCode owns native child birth and actual ancestry; Missions
records declarations and business readouts separately. Native execution bindings
with stronger signed invocation authority have their own qualified composition;
ordinary native work does not invent such proof. Independent roots use their
native agent/project permissions and do not inherit a coordinator's child rules.

## Mission Centre presentation

The panel header has a compact toolbar (create, the preferences gear opening the
Settings window's Missions section, refresh) above one "current mission" picker:
rows show only a title and a status mark, with full state in the tooltip and
screen-reader text. Nothing is selected by default. A selected mission or schedule
gets a separate detail below the list: its action toolbar (Play/Pause, Stop, the
Summary eye, Open conversation, edit, delete), the "Request an update" text button
for one-time missions, "Needs you" for open native Forms/permissions, then the task
tree. The tree retains completed and retired tasks in stable dependency order; its
measured graph draws only declared `blockedBy` edges, never inferred native
ancestry or paths through unrelated nodes.

The panel is a navigation surface without result prose, conversation lists or
explanatory notes. The Summary eye opens the overview reader above the transcript
and a tree node opens its task reader. Evidence, next steps, artifacts and full
text remain in those readers; the overview folds Plan changes, Reports, cleanup
history and Technical details at its bottom. Task readers retain dependency
navigation, replacement lineage and native execution comparison. Native layout
identities preserve selection and reader gestures across refresh/remount.

## Distribution and environment

Every backend that publishes its loopback bridge provisions the content-addressed
Missions bundle through `DesktopPluginLifecycle`, using the authenticated daemon's
`config.get` discovery root: desktop hosts and the standalone server alike. Bridge
registrations only name `http://127.0.0.1`, so the bridge uses the HTTP listener only
when it is bound to 127.0.0.1 or 0.0.0.0; otherwise (HTTP not requested, or an
HTTP-only listener on IPv6 such as `::1`, `localhost` or a LAN address) it gets a
private, never-announced listener on a random 127.0.0.1 port. All of a backend's
listeners share one `WorktreeDeletionFence` and its creation/recurrence holds, so a
deletion through HTTPS drains admissions made through the bridge. Window and browser
automation remain desktop-only: without a desktop host, `browser-claim` answers only
for `purpose: "mission"`. When the bridge cannot be published (for example its
registry directory is not writable), the Missions snapshot route reports
`host-unavailable` without reading OpenCode; a plugin OpenCode has not loaded is
`plugin-unavailable` and one it failed to load is `plugin-failed`.
Backend leases live outside that watched root. Tools, context hooks and typed
RPC initially register through backend presence. `retainMissionWork` preserves
registered Missions while active/unsettled work, receipts or uncertain storage
remain, including after lease loss. This retains native work, but does not replace
the owning backend's fresh admission checks for subsequent protected sends. No
project-local files are installed; the server typecheck covers the plugin contract.

Assignment prompts and report synthetics use a narrow authenticated loopback bridge mode. The owning backend reconciles the persisted task/report via `codenomad.missions.snapshot`, validates complete native session ownership and selection, acquires the worktree mutation fence, and applies the current full profile environment before admission. Native environment errors are redacted and fail closed. No environment data travels through the UI or plugin. Multiple owning backends are rejected rather than choosing a profile arbitrarily.

Before either kind of admission, the backend also refreshes its owned `codenomad.git-availability` instruction through `syncSessionGitContext`, removing stale context after recovery. This bounded Git advisory remains separate from fail-closed environment synchronization; its failure does not block admission, but cancellation and connection retirement still do.

The bridge accepts up to 250,000 assembled text characters within its 512 KiB JSON body limit. This accommodates the maximum objective, brief, title and dependencies after XML escaping (up to 5×), including JSON control-character escaping on the wire. HTTP regression coverage exercises maximum accepted contracts for all playbooks.

This transport reuses the automation bridge discovery, not browser automation or its visible-window operations. Automation still has its independent execution-time session/window fences. Environment and model state are session-scoped, not atomic per-inbox-item snapshots; see [SESSION_ENVIRONMENT.md](SESSION_ENVIRONMENT.md).

## Safety limits

- One native project per mission.
- Coordinator and independent actor admission require exact owned roots; native
  descendant observation/reporting uses its separate ancestry/provenance contract.
  Foreign projects are rejected; a graph edge never grants session authority.
- At most 8 actors, 96 tasks, 20 live maps, and 2,000 stored journal entries per
  project under the current bounded model. Tombstones retain evidence and consume
  journal storage, not live-map capacity. Recurring passage retention needs its
  own bounded history strategy rather than exhausting this one-shot task budget.
- Existing root actors may be reused, but an actor cannot join two active missions.
  Once a mission is stopped or finished another active mission may reuse its
  actor; a Stop target found serving another active mission settles with a known
  `target-reused` receipt and no native interrupt or inbox cancellation, so the
  stopped mission can still be deleted. Pause/Play on a shared actor are refused.
- Dependency tasks are mapped as blocked and are never auto-dispatched.
- Completing a mission green requires every active task to have a completed report and every withdrawn task with admitted work to have a terminal report. The Debugging playbook's completed-role evidence gates still apply; retirement cannot satisfy a gate.
- One-time creation refusals that provably happen before the native create is
  attempted carry no-effect codes (`creation-unavailable` 503,
  `creation-worktree-deleting` 409, plus the existing capacity/scope codes and a
  receipt-backed native `mission-limit`): the UI keeps the draft and re-enables
  Create. Every later failure stays an exact `creation-uncertain`/codeless hold.
  Recurring creation uses the same classification (`creation-unavailable`,
  `creation-worktree-deleting`, the hold codes, `recurrence-capacity`, 400 and
  codeless 401/403/404 are definitive; codeless 409/5xx and `creation-uncertain`
  stay held), keyed on a flag set immediately before the paused-schedule RPC.
  Known limit: that UI hold lives in window memory only and there is no exact
  creation-status endpoint, so an uncertain create keeps Create blocked for that
  project scope until the window reloads (the backend permit and deletion block
  remain until native settlement). Reloading does not prove the original create
  failed; check the mission list before creating again.

## Included playbooks

- **Debugging** preserves evidence-first diagnosis, behavioral TDD, independent fresh Standards and Spec reviews, implementer-session resolution, and a fresh read-only green gate. Completed role reports carry validated structured artifacts, while the coordinator still chooses each transition; no fixed state machine was ported.
- **Wayfinder Map** adapts destination, map, frontier, claims, and fog-of-war planning to visible sessions. It remains planning-first and uses native Forms for human decisions.
- **Product delivery** (`delivery`) adapts the NomadWorks Collective method (`NeuralNomadsAI/NomadWorks` main `55eec7e`, v0.1.1) without requiring that plugin. The coordinator acts as Product Manager: it classifies each request by complexity (tiny, standard, complex) and track (implementation, investigation, spec), has the business analyst and tech lead draft a Spec Change Request for any behavioral change (tiny included), standard or complex implementation and spec work, runs read-only pre-sync readiness reviews before implementation, decomposes complex work into slices with the technical architect, keeps one shared-checkout implementation task at a time, and closes only with QA/tech-lead evidence and resolved documentation impact. The six roles are business analyst, technical architect, tech lead, developer, QA engineer and UI/UX designer. Request approval is coordinator guidance through a native Form, not a server-enforced gate, and the Missions safety boundary replaces NomadWorks' agent commit authority: the human owns commits. One playbook covers both NomadWorks team presets; the coordinator declares only the roles each complexity needs. Same-scope rework retires the task and adds a replacement (`replacesTaskKey`) rather than reopening it as NomadWorks does; continuing a native specialist's context uses a follow-up task whose `reuseFromTaskKey` names that specialist's finished, still-live task. As with any new template, an older build rejects existing `delivery` missions or schedules after a downgrade.

## Validation

`node scripts/test-missions-native-trajectory.mjs <absolute-isolated-opencode-cli>` also checks one-time Wayfinder refusal without journal mutation, then artifact-free completion from a native child question answered through the authenticated UI route (not a live desktop gesture). The invocation unit tests cover graph isolation, missing/stale invocations, interruption joining and per-check deadlines.

Each complete one-time human-gate call (acquisition plus its nested SQL/Form/storage reads) shares one 10-second deadline, matching `missions/native-human-evidence.ts`, combined with invocation cancellation. The check aborts and joins only its own runtimes and clears its timer on settlement; later checks get a fresh budget, excluding intervening session/authority work. The invocation still joins all pending checks/reads before graph release. A raw Promise that ignores abort may remain pending, but cannot resume its cancelled Effect into the graph, and later reads through that expired check are refused. This is not a hard deadline for arbitrary noninterruptible native code: a stuck native finalizer or uninterruptible read still has to be joined before releasing its graph. Abandoning such work with a Promise race would be unsafe; the runtime contract must retain interruptible reads and finite cleanup. Recurring gates retain their existing runners.

`node scripts/test-missions-native-family-control.mjs <absolute-isolated-opencode-cli>` qualifies recursive Pause/Play and Stop with real ordinary background subagents, using a private home/config/database and deterministic provider. Five concurrently active sessions form a family three levels deep. On OpenCode 2.0.26, two independent runs passed all five gates: four descendants interrupted deepest-first with complete receipts; Pause parked cancellation results without new model turns; explicit Play resumed the coordinator and supplied interrupted-child context; Stop emptied the family inboxes without a new model turn during the bounded observation window. The latest-runtime CI job runs this fixture after building the plugin. This is not 4096-session stress qualification or proof that a failed native interrupt succeeds: incomplete receipts retain separate unit coverage. Play resumes the coordinator only; descendant results remain parked until it explicitly continues their work.

Build the shipped plugin with `npm run build:missions --workspace @neuralnomads/codenomad`, then run `node scripts/test-missions-native.mjs <absolute-opencode-executable>`. The fixture uses isolated configuration/storage, the real bundled plugin, typed RPC, WorkspaceManager and bridge, plus a local deterministic provider. It verifies catalog selection, variant persistence, a busy actor's durable queue, mismatched selection refusal, per-send actor/coordinator environment, presence removal/re-registration, and retry idempotence. No shared service or user provider is used. The fixture passed on Windows with CLI/client/plugin 2.0.11 on 2026-09-20.

Historical runtime spikes and experiments are preserved on the local branch
`preserve/missions-full-20261009`; they are not part of this product tree.

The project-briefing follow-up was checked on Windows on 2026-10-05 against an
isolated 2.0.22 runtime and the rebuilt shipped plugin (16 native gates), including
the real typed snapshot decoder retaining the briefing, exact request replay,
foreign/stale refusal, and unchanged tasks/results/provider-turn count. Native
parallel/recursive trajectory qualification retained all eight gates. Receipts:
`<TEMP>/opencode/missions-native-mXJfp9/receipt.json` and
`<TEMP>/opencode/missions-native-trajectory-GKkfuR/receipt.json`.

Server/Mission regressions passed 800 tests, with one pre-existing opt-in native
test skipped; UI models/locales/view fences passed 69 tests under browser
conditions. The general Mission/drawer browser suite passed 230 tests; subsequent
targeted guidance/control/briefing checks passed 35, then the final seven briefing
checks covered superseded exact responses and terminal-summary precedence. UI,
server and Electron typechecks passed. French captures of the real components
were inspected at 440/280 px panel widths and a 390 px viewport, both with and
without a briefing (`mission-briefing-fr-*.png` in the approved temporary folder).

These deterministic readouts validate representation and admission semantics,
not the quality of a real coordinator's synthesis. No live mobile mission was
mutated and no new desktop version was installed by this follow-up validation.

## Agent conventions

These rules moved here from `AGENTS.md`, which indexes this document; they bind every change in this area.

- Mission sections use `components/mission-disclosure.tsx` and the shared `.disclosure-chevron`. Keep disclosure/selection/reader identities in the native per-window layout via `stores/mission-view-state.ts`, independent of refreshed snapshot object identity. Long mission content uses `components/mission-reader.tsx` above the transcript; its chrome follows `.window-*`. Mission styles remain under `styles/panels/mission-*.css`. Recurring setup/list geometry lives in `styles/panels/mission-recurrence.css`. Template and execution mode remain orthogonal; recurring drafts freeze the chosen template, optional verbatim notes and exact coordinator/playbook-role profiles. Recurring uses the existing brief-only library, never storing clock/watch/grant/invocation state in a brief. CREATE and UI share `recurrenceReadBudget` / `recurrenceInputBudget`, with exact native Location room and no automatic ceiling increase. Native CREATE stores paused metadata only, never Play or a timer. Creation is one screen (`components/mission-editor.tsx`, `styles/panels/mission-create.css`): the shared objective/instructions draft, an editable title prefilled from its first sentence (≤60, `missions/mission-title.ts`), Once / Every day at [time] with the resolved zone, and everything else under one collapsed Options disclosure (catalog-backed profile selectors stay lazily nested), except Compare's required Model A/B selectors in the main form. The panel's Create button heads the form. The footer has a single **Create** submit: creation never starts anything (no Create-and-start button or auto-start option); one-time Missions and schedules start only through their separate explicit Play. Validation stays inline beside its field.
- The Missions panel header (`components/mission-picker.tsx`, `styles/panels/mission-picker.css`) has a compact right-aligned toolbar ([+] create, then the panel's preferences gear and refresh) above one "current mission" line modelled on the provider account control: chevron, then the selected-title field (title + small square status mark). Edit and delete are not on the picker line; they belong to the selected detail's toolbar (below). The chevron toggles a persistent inline list, saved per project as `listExpanded` in `stores/mission-view-state.ts`; the field opens the same list as a transient ARIA combobox/listbox popup (arrows/Home/End/Enter, Escape, outside click, selection close it). Rows (one-time and recurring) show only the title (`lib/mission-display.ts`) and a status mark; full state lives in the tooltip and screen-reader text. Lists scroll natively within a bounded height; the title filter appears only while the rendered list measurably overflows, or still holds text. The chevron mirrors a collapsed session parent's activity among the OTHER entries (`mission-picker-model.ts`): waiting → permission colour, failed → error colour, running → working colour with pulse, with counts in its label. Row actions live only at the top of the selected detail (`components/mission-action-bar.tsx`, `mission-selected-actions.tsx`): ▶/⏸ (▶ also runs coordinator recovery when a running Mission's coordinator is idle-without-report/unknown), Stop… (schedules add Run now), then the Summary eye, Open conversation, edit and delete — always visible, disabled when not applicable (edit only for an active one-time Mission; schedules have no edit/delete) and no `…` menu; Request an update is a compact left-aligned `.window-text-button` below the toolbar (above the task separator, `--space-sm` rhythm), relabelled and disabled while pending/uncertain, hidden when unavailable (a schedule keeps one only for secondary controls such as Run now). Retrying an unconfirmed control belongs to the header ⟳: it reads status first, then resends only a still-unconfirmed exact request (original requestID/expectedRevision) from that explicit click. Stop and Delete confirm first. Selection uses the shared `--list-item-highlight-*` tokens; never use the input-field surface (`--surface-base`) as a panel or popup background. Nothing is selected by default, and only the picker changes the persisted per-project selection: opening a Mission's conversation never reselects it.
- Nothing renders below the list until a Mission or schedule is selected. The selection's detail is then a separate `section.mission-detail` after the whole list (`components/mission-tracking.tsx`, `styles/panels/mission-detail.css`), never inside its row: the action toolbar, whose "Summary" eye (`MissionActionBar`'s `.mission-overview-toggle` `icon-toggle`) toggles the central overview reader, then "Needs you" (`components/mission-attention.tsx`: one compact line per open native Form/permission with an Answer button; who asks stays in the tooltip and accessible description), then the task tree. `components/mission-task-tree.tsx` is THE task view: `mission-graph.tsx` draws declared dependencies (including completed/retired work) beside one row per task, each edge leaving and entering the measured status icons (done, active, awaiting input, assigned/ready, waiting, blocked, failed, retired); the status word lives only in the tooltip and screen-reader text, with no per-row eye. Clicking a node toggles its exact task reader. The panel has no checklist, Work list, More disclosure, result/summary prose, coordinator field, briefing section or explanatory notes: text belongs in the central reader. Graph styles live in `styles/panels/mission-graph.css`; the remaining shared list chrome (`components/mission-list-item.tsx`, `styles/panels/mission-list-item.css`) serves cleanup receipts.
- The overview reader (`components/mission-reader.tsx`) keeps the result/briefing/objective first and folds secondary material at its bottom through `components/mission-overview-details.tsx`: Plan changes, Reports (each opening its exact reader), conversation cleanup history and Technical details (mission/coordinator/schedule/passage IDs and requested profiles), plus the pending coordinator-notification note. Task and schedule readers also keep identifiers in a collapsed Technical details. Only cleanup that needs an explicit retry stays in the panel. Task readers consolidate bounded brief/report/evidence pages with dependency navigation and existing truthful execution/profile/notification surfaces. Useful recursive delegation guidance propagates through canonical assignment prompts; native runtime permissions and configured depth remain authoritative, never an imposed target or a root-fallback trigger.
- A selected schedule uses the same detail (`styles/panels/mission-schedule.css`): the same action toolbar, whose Summary eye opens the admitted passage's overview, else the schedule reader; one interrupted/uncertain sentence pointing at the toolbar's primary Resume/Check action and any last scheduled-check failure; the current passage's Needs you/tree when a passage is admitted; then a compact list of past runs (date · outcome), each toggling its exact run reader centrally. Running schedule rows show their next run, not their state. Schedule times always use the schedule zone (`components/mission-schedule-text.ts`), labelled only when it differs from the viewer's zone. The central schedule reader (`components/mission-recurrence-reader.tsx`) follows the same plain grammar: rule, the selected run's result (or one plain failure sentence with Retry), every run, and identifiers only in a collapsed Technical details.
- Mount `createMissionRecoveryAction` once per Mission row and include its action (on ▶) and feedback in the shared row rather than mounting a second recovery controller.
- Task readers put results before collapsed brief/technical details. "Needs you" contains only open native Forms/permissions and routes "Answer" to the exact actor conversation and interruption dock; reported obstacles are not automatic human-decision alerts, and retired/replaced attempts never become current blockers. Tree statuses stay truthful: admission is only "Assigned", observed native activity alone is "Active", an observed native Form/permission is "Awaiting your input", unmet dependencies are "Waiting" and a reported blockage is "Blocked". Task navigation uses only exact owned non-coordinator actors, never a generic coordinator fallback or inferred bindings; the row's Open conversation supplies the single coordinator link. Admission is not consumption; uncertain sends are never replayed automatically.
- One-shot Missions and exact admitted recurring passages share `components/mission-tracking.tsx`. `recurrenceCurrent` derives the owned isolated journal; `recurrencePassageRead` reads archived bounded prose while CREATE retains its separate `recurrenceRead({ id })` schedule lookup. Reader targets preserve exact instance/project/schedule/passage and semantic section identity, never arbitrary session selectors or transcript substitutes. Calendar CAS emits `rpc.codenomad.missions.scheduleChanged` only after commit through the fresh native graph's Bus; a lost invalidation never replays a mutation.
- `stores/mission-recurrence.ts` owns shared visible list/current/reader demand, connection fencing and coalesced trailing reads without polling. Recurring create/Play/Pause/Stop/Resume/Run now use only the authenticated UI/backend route, existing HMAC bridge and plugin RPC, never model tools. Controls use requestID idempotency and expectedRevision CAS; lost replies are resolved by read-only status, never automatically resent. Snapshots expose title/clock/nextDueAt, state including Interrupted and its reason, pending starting/running/settling/uncertain, latest result, bounded history, revision and available actions; no epochs, grants, receipts or effect budgets. Preserve unknown holds across remounts. See `dev-docs/MISSIONS_RECURRING_SIMPLE.md`.
- Archived and current remote reader numeric drafts use `components/mission-reader-number.tsx` and commit on Enter/blur, not the first digit. Keep existing toolbar DOM mounted during same-source reads; local in-memory reader pagination stays immediate. A selected schedule's past-run list lives in `styles/panels/mission-detail.css`.
- Coordinators publish project briefings automatically at business milestones (initial plan, each task settlement, waiting on a human, before the final report) with requestID `auto:<revision>` and plain user-facing summaries (`missions/recipes.ts`); there is still no timer or per-tool briefing. An explicit update request is `createMissionBriefingRequest` in `components/mission-briefing.tsx` (the "Request an update" text button below the selected toolbar; its pending/uncertain feedback shows under it). The panel shows no briefing text: full briefing/final prose and task sources belong in the central `MissionReader`, opened/hidden with the detail toolbar's Summary eye. The fixed request follows `lib/mission-coordinator-message.ts`; it is ordinary native admission, not a new read-only execution sandbox. Match its exact request ID before acknowledging a received briefing, retain pending/uncertain state by identity, and never replay it automatically. The coordinator-only `missions/briefing.ts` contract records a bounded narrative with assessed revision and exact task sources, separate from observed activity/task settlement/final outcome. Show stale-map/new-result notices and source readers in the reader without inventing semantic updates or human requests. For existing missions without a briefing, expose bounded exact current results/obstacles in the overview reader and use the tree for the remaining plan. Mission rows say "In progress" for an open mission (its lifecycle state, never a claim of observed activity); declared task counts are not shown as progress. Terminal missions omit settled lifecycle actions but retain unresolved control receipts. Project cleanup uses one disclosure for pending and historical receipts, never an outer history wrapping another cleanup disclosure.
- Mission display demand follows the actual right-panel visibility and selected tab, not component mounting. Preserve cached snapshots while hidden, cancel queued trailing display reads, and revalidate on activation. Native lifecycle events (`session.execution.*`, compaction, inbox, Shell, Form and permission events) are activity invalidations; text/tool-progress deltas are not. Explicit recovery reuses the selected Mission's ▶ and the tree's task recovery actions through `createMissionRecoveryAction`, without a separate administration surface or automatic mutation retry.
- Missions preferences live in the Settings/Preferences window's Missions section (`components/settings/missions-settings-section.tsx`); the Missions panel header gear deep-links there via `openSettings("missions")`, with no inline panel disclosure. `stores/settings-screen.ts` is the single Settings route for every entry point: local Electron/Tauri windows always reuse/focus the one native Preferences window with the active instance/Location; only browser and remote windows use the embedded screen. A native rejection (e.g. an older installed host lacking a section, which needs a native rebuild) shows an error notification and never opens a second, embedded Settings surface. Keep the section allowlist identical across renderer, Electron and Tauri (`native-mission-preferences.test.ts`). Project-scoped parts (catalog, Location depth) use the opener's instance/Location and stay disabled without one. `components/mission-preferences.tsx` has no Save/Reload step: each choice is written at once, compare-and-swapped against the value stored at its turn. Edits made during a write stay enabled (disabling a control drops its keyboard focus) and queue behind it, shown immediately, across window/section remounts. Each edit touches one role or the task-session policy of one scope and is refused when that stored value is no longer the one it was made from, so a queued edit never overwrites another window's change to that value or resends a rejected edit of it. (Customizing an inherited role still copies the global values shown at edit time.) A rejected or unconfirmed write is never resent: a read-only reload shows the stored values, with Reload offered only when that read fails or the document is unreadable. The fold's Reset (confirmed) clears only the shown scope's agents/models; resetting an unreadable document is a separate confirmed repair. Catalog/depth demand stays fenced by that section's visibility. Agent/model choices use one `MissionProfileControls` row per role everywhere (coordinator, then the type's roles; no sub-fold, second selector level or Debugging special case). In a mission-type scope, rows show the inherited global values with a muted Global mark; editing a field customizes the role starting from those values, its revert icon inherits again, and an all-native choice remains an explicit override (inherit, native default and a selected profile stay distinct). Creation waits for loaded preferences, shows requested choices and keeps overrides collapsed. Profiles use compact square native selectors in `components/mission-profile-controls.tsx`; preference/profile/library layout lives in `styles/panels/mission-preferences.css`, not wide settings cards. Saved briefs are bounded versioned brief-only records under existing owned UI preferences (`lib/mission-model-library.ts`). Creation shows one "Start from a brief" select at the top of Options that loads on selection (Remove/Reload in its small `…` overflow) and a footer "Save as brief" text button that asks for a name inline (`components/mission-model-library.tsx`, styles in `styles/panels/mission-create.css`); only Preferences keeps the full library manager and invalid-library repair. A selected one-time Mission, including a finished one, offers the same "Save as brief" text action beside its update request (`MissionActionBar` secondary row): `missionRecordedBrief` copies only its recorded objective, verbatim notes, template, frozen profiles and taskMode (the title only prefills the name; briefs have no title field), never IDs, plan, results or lifecycle state. Recurring schedules have no save-as-brief action. Loading copies into ordinary manual creation and is never a launch, delete preserves all executions, and arrays retain config merge-patch replacement semantics. Preserve exact choices in uncertain creation drafts; presets are not historical invocation identity. Defaults never silently reconfigure existing/busy actors. No scheduler or publication authority is implied by saving a brief.
- Delegation is a per-new-mission task-session policy (`taskMode`, omitted means native), not a global subagent prohibition or depth setting. `mission-task-mode-controls.tsx` shares its compact native selector between preferences and creation. Task agents use subagent/all in native mode and primary/all in independent mode; coordinators always use primary/all. Freeze the policy with the creation/defaults snapshot and uncertain request identity, preserve it in explicitly selected saved briefs, and never change existing Missions or OpenCode configuration. Ordinary internal helper calls remain governed by native permissions/depth.
- Delegation's native depth editor (`mission-subagent-depth.tsx`) is separately Location/project scoped and affects all OpenCode conversations there, unlike global new-mission defaults. Demand only while the Preferences window's Missions section is visible, retain dirty drafts and exact file expectations by instance/directory, and never invent an unknown effective depth or label zero as disabled. Enter or leaving the field writes a changed valid value (Inherit writes at once; pressing it keeps focus in the field so the typed value is not saved first; Escape discards an unsaved value) without reload/restart; invalid values are flagged, never written. A write acknowledged after the view was left or hidden is accepted and reread on the next activation, not shown as unconfirmed. Reads and writes make the field read-only rather than disabled, preserving focus. The refresh icon appears only after an error or an unconfirmed write; uncertain writes remain fenced until that explicit refresh, with no automatic replay.
- Missions task scrolling uses `components/mission-task-scroll.ts` with `styles/panels/mission-task-tree.css`: the task flow fills the remaining panel height and owns scrolling when the header and task minimum fit; on shorter layouts the whole panel is the sole task-content scroller so controls remain reachable. Size/child-list observations select the policy without polling or oscillation. The picker retains its independently bounded list. Graph endpoints measure the status-icon edges in SVG coordinates, including RTL and zoom. Keep IME composition keys in the picker search, and preserve Space activation without a duplicate keyup click. Validate with `tests/browser/mission-panel-geometry.test.ts`.
- One-time Missions ships through `DesktopPluginLifecycle("missions")` and backend presence, with project-scoped native storage. Every backend that publishes its loopback bridge provisions it, desktop or standalone. Bridge registrations name only `http://127.0.0.1`: the bridge reuses the HTTP listener only when bound to 127.0.0.1/0.0.0.0 (`acceptsIpv4Loopback`), otherwise (HTTP not requested, IPv6/`localhost`/LAN HTTP-only) it gets an unannounced private listener on a random 127.0.0.1 port. All listeners of one backend share a single `WorktreeDeletionFence` (with its mission holds). Window/browser automation stays desktop-only; without a desktop host the bridge's `browser-claim` answers only `purpose: "mission"`. The Missions snapshot distinguishes `host-unavailable` (no bridge), `plugin-unavailable` (OpenCode has not loaded it) and `plugin-failed`; never tell users to reconnect CodeNomad for a plugin OpenCode must load. Recurring `mission_*` tools register independently of backend presence and route by native session to the passage's isolated journal, otherwise the one-time journal. Keep roles independent of native execution IDs. Persist explicit agent/model/variant selections and never switch a busy actor for a queued task. Preserve authenticated admission, ownership/connection/worktree fences and per-send profile environment. One-time map update/control/delete/recovery routes share `server/routes/mission-map-mutation.ts`: creation's fenced connection and worktree-deletion admission, a fresh workspace/connection/location recheck after all preparation, and the permit held through the single unretried RPC. Native permissions govern ordinary tools, including read/shell; recurring passages require no whitelist or per-tool receipts. See `dev-docs/MISSIONS.md` and `dev-docs/MISSIONS_RECURRING_SIMPLE.md`; validate one-time behavior with the isolated `scripts/test-missions-native.mjs` fixture.
- The durable refactor deliberately drops old Mission compatibility: retain the one-time journal `codenomad-missions/v2`, wire/schema version 1 and existing one-time receipts; the historical `codenomad-missions/authority-v2` signed recurring layer is superseded by the simple plugin-kv schedule contract. Do not read, import, mutate or delete old namespaces, restore `migrateLegacy`, or add migration UI; the shipped plugin setup never initializes `authority-v2` and ships no managed-owner observer (`desktop-plugin.test.ts` traps old-namespace access; the bundle test forbids its literal). Recurring create stores paused metadata; Play requires a separate explicit user action, never an automatic send after creation, and needs no signed authorization. Namespace isolation is not native writer quiescence or session/family ownership. Desktop rollout remains subject to current journey validation in `dev-docs/MISSIONS_REFACTOR_VALIDATION.md`, not superseded recurring authority gates.
- Coordinator tool results stay compact (`missions/tool-result.ts`); only `mission.inspect` returns the full map. Actions needing native reads or effects beyond the plugin's Promise API (`inspect({ taskKey })` native conversations, `mission.interrupt`, `mission.prepare`) cross the authenticated bridge with fixed bridge error codes (`missions/recovery-error.ts`) and refuse without backend presence. `mission.interrupt` stops only a retired native task's own conversations (exact canonical assignment header, `missions/task-sessions.ts`) through the family-interrupt path, with lifecycle Stop's post-interrupt rechecks, under the deletion fence; it refuses while an open task continues, nests under or runs in that conversation. Scheduled passages are not offered these tools. `mission.prepare` reuses the editor's creation pipeline and never Play; the trusted `preparedBy` grants that coordinator read-only visibility, never control.
- A durable mission report and its coordinator notification are distinct. Recover only unacknowledged report notifications through the existing bridge with stable native message IDs and lifecycle fencing; never turn notification recovery into task dispatch or a workflow engine. An admission acknowledgement is not proof of model consumption or mission completion.
- Explicit targeted Mission recovery uses `missions/recovery-input.ts` and `missions/native-recovery-observation.ts`: reconcile saved actor locations, all bounded descendant inboxes and activity, applicable global Forms/permissions and uncorrelated running Shells; recheck identities after asynchronous preparation. Unknown observations fail closed. Recovery never replays an assignment, changes the plan or claims model consumption from admission.
- `packages/server/src/host-lifetime/` keeps only the private-storage, process-identity and profile-scope primitives that the shipped Missions code uses (`storage`, `private-storage-sync`, `windows-storage`, `process-identity`, `protocol`). The persistent-backend foundation (manager/backend entries, native runtime/Missions channel, `packages/native-host-lifetime`, the durable host and its fixtures) is separate, non-activated work kept on the local branch `experiment/host-lifetime-foundation-20261009`; it is not Missions native-plugin acceptance and must not be reintroduced through this product tree. Never replace a native ownership gate with a no-op or environment flag, steal a live/unknown owner, log secrets, or include the shared OpenCode daemon in backend cleanup.
- Optional mission specialist cleanup records immutable tombstone targets and per-session receipts. Use the authenticated bridge and authoritative `cleanupTarget` RPC before native HTTP deletion; plugin contexts do not expose native session removal. Preserve coordinators, reused/shared/moved sessions and roots with descendants. Partial cleanup retries retain the original request identity and never become a background dispatcher.
- One-time Mission Play starts/resumes through durable explicit lifecycle intent; Pause interrupts the whole native mission family and parks Mission notifications/dispatch, while Stop is terminal. Each root target first walks its native descendants (`readNativeControlFamily`, ≤4096, paginated, cycle-safe, never the 32-session display read) and interrupts active ones deepest first through the same `session.interrupt({ resume: false })`, with bounded re-interrupt passes because native subagent results resume their parent; Stop also cancels queued descendant inputs and the root's mission and native `source: "subagent"` deliveries so a stopped coordinator is not re-woken (`missions/native-family-interrupt.ts`). Receipts carry a bounded `descendants` summary; budget exhaustion or anything still active is `complete: false` and surfaces as "some sub-agents may still be running" — never claim a full stop without that evidence. Play tells the coordinator which descendant conversations were interrupted; it re-delegates, there is no workflow engine. One-time native acknowledgements retain per-target receipts and explicit retries, with the same authenticated bridge, environment and ownership fences; these receipts are not required for recurring passages. Recurring Pause/Stop cancel the schedule Job and do not prove native passage sessions stopped. Coordinator recovery is offered only on observed `idle-without-report`, never on `unknown`; an oversized family with an active descendant projects as background/recovery-busy. Do not turn notification recovery into a control-action runner. One-time lifecycle state and actions live in `createMissionLifecycle` (`components/mission-lifecycle-controls.tsx`), surfaced only as the toolbar's primary action and Stop; an unresolved request offers Check status, and the header ⟳ resends it with the same request identity after its read-only refresh, never a fresh action.
