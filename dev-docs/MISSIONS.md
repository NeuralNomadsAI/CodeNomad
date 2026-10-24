# CodeNomad Missions / Session Mesh

Missions coordinate native OpenCode V2 work through a durable project map,
dependency-aware tasks, human controls and readable results. OpenCode owns execution;
Missions gives the user a coherent way to specify, follow and reuse that work.

Recurring passages run in the OpenCode service with CodeNomad closed; never run them
through a persistent CodeNomad backend. Native qualification: §Validation and
`MISSIONS_RECURRING_QUALIFICATION.md`.

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
objective. Only `mission.inspect` returns the full map; `mission.inspect({ taskKey })`
rereads one task with its contract and exact current assignment prompt. A native
Wayfinder `decision` declaration also states the human-answer requirement that
`verifyHumanDecision` enforces, so a self-contained analysis goes to `research`.

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

A native Wayfinder decision readout may omit its artifact: the human-answer gate's
`discover` finds fresh children of the expected parent whose `subagent` call
carried the exact assignment prompt, reads their confirmed UI marks and keeps
only answers its own `verify` accepts. A reached bound, a pending mark or a
confirmed answer that fails verification makes the discovery incomplete. Only a
complete discovery with exactly one candidate fills the artifact; anything else
refuses, and `inspect({ taskKey })` lists the candidates as ready artifacts with
their completeness. Never infer candidates from text, titles or timing.
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
Blinding is an instruction and data-presentation policy.
Native proof: `node scripts/test-missions-native-trajectory.mjs <CLI>`.

## Durability and recovery

Only the coordinator's final report finalizes a mission, even when every declared
task is complete; empty plan history is omitted.

### On-demand project briefing

“Request an update” sends the panel's only coordinator message
(`lib/mission-coordinator-message.ts`): a fixed application-authored request with the
exact mission ID, a unique request ID and the UI language, through ordinary coordinator
prompt admission (fresh owned snapshot, exact project/coordinator, view/connection/lifecycle
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

`POST /api/workspaces/:id/missions/:missionID/recover` brokers only the typed `recover` RPC (`missions/recovery-input.ts`, `missions/native-recovery-observation.ts`), with `{ expectedRevision, target: "coordinator" | "report", taskKey? }`. This explicit intervention derives one deterministic native synthetic message identity from the existing mission revision and target; it never replays an assignment. Report recovery requires an existing unresolved admitted task; coordinator recovery references the saved map and reports. Paused, prepared, terminal and pending-control missions reject recovery.

The authenticated owning backend reconciles saved actor locations and checks native activity, bounded descendant inboxes and inventory, uncorrelated running Shells and applicable (including global) Forms and permissions before preparation and again after applying the fresh full profile environment. Recovery never changes the plan. Incomplete/failed reads fail closed; unknown Shell ownership and running descendants block the nudge. The bridge exposes only fixed, redacted recovery error codes. The response `admitted: true` acknowledges admission only. These bounded checks are separate reads, so native state can change between them, and recovery cancels nothing.

### Snapshots, journal locking and map routes

Snapshots are authoritative reconstructions of the journal. RPC events are only invalidations; the UI always reloads a snapshot after reconnect because native event subscriptions are live-only.

Project mutation and journal-append exclusion is shared by all bundle incarnations in the native host. An in-flight mutation keeps its lock across registration disposal: a content-addressed replacement waits before reading its CAS revision. `missions-reload.test.ts` loads two independent compiled bundles and races updates across dispose/setup to verify that only one can succeed.

Mission Control manages map metadata through the authenticated CodeNomad routes `POST /api/workspaces/:id/missions`, `PATCH /api/workspaces/:id/missions/:missionID`, and `DELETE /api/workspaces/:id/missions/:missionID`. These broker only the typed `create`, `update`, and `delete` methods of `codenomad.missions`. Create uses a stable request ID, may attach an owned root session or create a new root without prompting, and accepts an optional `title` (trimmed, single line, 1–60 characters, `missions/mission-title.ts`). The title is part of the exact creation request and `mission.created` event, is exposed as `MissionMap.title`, and names new coordinators `Mission · <title>` (otherwise a title derived from the objective's first sentence). Missions without a stored title stay untitled; the UI derives a label. Update uses revision compare-and-swap for objective/notes. Delete appends a tombstone: the map disappears from snapshots and membership. By default every conversation is preserved. Late reports for a tombstoned mission cannot recreate its map. Tombstones remain subject to the project journal event limit.

Deletion optionally accepts `deleteManagedSessions: true`. Immutable targets are recorded in the tombstone, and per-session receipts reserve journal capacity before removal. Only deterministically created specialist roots with matching native creation metadata and exact project/location identity qualify. Coordinators, reused sessions, actors referenced by another mission (including finished/deleted maps), and roots with children are retained. Native removal is recursive, so descendants are outside this opt-in. The plugin delegates removal to the authenticated desktop bridge, because native plugin contexts lack `session.list/remove`. The bridge obtains authoritative intent through the narrow read-only `cleanupTarget` RPC, revalidates ownership/connection/worktree fences and calls the native HTTP client. It never modifies OpenCode storage directly. An incomplete cleanup returns `503 cleanup-pending` after the tombstone is committed; replay the exact original request ID, revision and option. The editor retains that request through live snapshot refreshes and locks the option after the first attempt. Only an explicit retry resumes cleanup.

### Explicit execution controls

The UI creates missions with `prepared: true`. Its one-screen form has a single **Create** button that only creates; the prepared mission is then started by its explicit Play, never automatically by creation. A single Play button starts a prepared mission or resumes a paused one; Pause and terminal Stop are adjacent. Mission journals created without `prepared` run until an explicit control changes them. `POST /api/workspaces/:id/missions/:missionID/control` brokers the typed `lifecycle` RPC (`action: start | pause | stop`, `requestId`, `expectedRevision`).

`mission.control-requested` records the durable desired state and exact root actors before native side effects; `mission.control-applied` receipts track acknowledgements. The project mutation lock serializes controls with assignments and report admissions. Partial failure returns `503 control-pending`, and the snapshot retains the original request and remaining targets for an explicit retry, including after a UI/plugin restart. Old completed requests cannot replay their side effects over newer states. Stop may supersede an incomplete start/pause; no action can restart a stopped/completed/failed mission. Receipt capacity is reserved before intent publication.

Pause immediately calls native `session.interrupt({ resume: false })` for the coordinator and all specialist roots, and first for every active native descendant of each root (see recursive interruption below), preserves task/inbox context, blocks new Mission dispatch/revision/finalization, and parks report notifications. A report arriving while paused is saved without waking the coordinator. Play resumes the coordinator and roots with unfinished admitted work via stable-ID native synthetic admissions, with fresh server-side environment and Git context and unchanged native agent/model selection. Play never creates or dispatches a new task graph.

Stop is irreversible for that mission. It interrupts those roots, cancels this mission's pending native inbox inputs, retains conversations/results, and withdraws unfinished tasks. Native controls always pass through the authenticated desktop bridge, authoritative snapshot, exact ownership/location and worktree/connection fences. Interruption is acknowledged per session; an already running tool process can outlive it.

**Recursive interruption (best effort, honestly reported).** Tasks often delegate recursively with the ordinary background `subagent` tool, so a mission family can hold hundreds of native sessions. For each Pause/Stop root target the backend walks native descendants with `readNativeControlFamily` (up to 4096 sessions, paginated, cycle-safe; inconsistent or foreign children are skipped and make the walk incomplete), then interrupts active ones level by level, deepest first, before the root. Native background subagent jobs deliver their (cancelled) result to the parent inbox asynchronously with `resume`, which would wake an already interrupted parent, and a still-running parent may launch new subagents meanwhile; up to three bounded passes therefore re-read the family and `session.active` and interrupt again, with a final quiet read. The deadline is checked before every session, and in-flight native calls are cancelled at it. Native read or interrupt failures and the deadline make the receipt partial instead of skipping the root interrupt. After the root interrupt the backend re-reads the family once to interrupt sub-agents the root launched before its interrupt landed, settles the root, and re-reads once more to verify. Stop additionally cancels queued user/synthetic inputs in descendants, and on the root cancels this mission's inputs plus native `metadata.source === "subagent"` deliveries, including ones arriving during a short settle loop after the root interrupt, so cancelled-child results do not re-wake a stopped coordinator. Pause cancels nothing: deliveries stay parked behind `resume: false` and are processed when Play resumes the coordinator. The descendant passes run under a 50 s family budget and each post-root read under 10 s, inside an 85 s lifecycle bridge timeout (below the plugin's 95 s).

The `interrupt-observed` receipt carries an optional `descendants` summary: `observed`, `interrupted`, `cancelled`, `unconfirmed`, `complete` and up to 64 interrupted session IDs. `complete` is true only when the family was fully enumerated, the deadline did not expire, no descendant or the root remained active or had a failed cancellation, and the verification read after the root settled observed the whole family quiet. Otherwise the UI shows a compact "Some sub-agents may still be running." status beside the toolbar; it never claims a full stop without that evidence. Receipts without the summary claim nothing. Late deliveries after the settle loop and external wakeups remain possible. Play's coordinator prompt lists only descendants that the latest preceding Pause receipts reported interrupting (projected as the start operation's `pausedDescendants`) and that are still natively interrupted; user interruptions and earlier, already handled Pause cycles are never attributed to that Pause, and a partial receipt adds only a generic hint.

On Play, the coordinator's resume message lists descendant conversations whose native `outcome` is `interrupted` (mapped to task keys when the conversation is a task actor, bounded to 32) and asks it to re-delegate or continue them; assignments are never replayed automatically.

Display activity and recovery keep the 32-descendant bounded read. When it fails (an oversized family), a bounded ancestry probe over `session.active` reports the actor `running`/`background`, and targeted recovery answers `recovery-busy` rather than `recovery-unknown`, on positive evidence only. The UI offers coordinator recovery only on observed `idle-without-report`, never on `unknown`.

`mission.revise` is a coordinator-only, append-only plan change with `expectedRevision`, stable `requestID`, and a required reason. It can update objective/notes, add tasks with new keys linked to retired predecessors, retire tasks, and rewrite dependencies in one atomic event. A retired task never counts as completed. Every remaining dependent must explicitly point to a live task or remove that dependency; cycles and edits to already dispatched dependencies are rejected. Existing task contracts and reports are immutable. A late report from retired admitted work remains visible as late history and never changes the task back to completed. Revision never interrupts sessions or reconfigures busy actors.

Mission snapshots expose the latest 50 plan changes (`history`, with `historyTruncated` when older entries are omitted), including human objective/notes edits and coordinator revisions. Each entry has a revision and timestamp; `source` distinguishes `user` from `coordinator`. Human edits carry no actor session or reason; coordinator entries retain their actor and required reason. Entries without `source` are coordinator-originated. Snapshots also expose task lineage (`replacesTaskKey`/`replacedByTaskKey`), late reports, and `outstandingExecution`. A withdrawn task with admitted native work must receive a terminal report before the mission can be finished.

Build the shipped plugin with `npm run build:missions --workspace @neuralnomads/codenomad`, then run `node scripts/test-missions-native.mjs <absolute-isolated-opencode-cli>`: through the real bundled plugin, typed RPC, WorkspaceManager and bridge with a local deterministic provider, it exercises native tool registration/restart plus revision, late-report delivery, lifecycle create/update/delete replay, tombstone projection, transcript preservation, catalog selection, variant persistence, a busy actor's durable queue, mismatched selection refusal, per-send actor/coordinator environment, presence removal/re-registration and retry idempotence. Report checks observe the actual provider request containing the report after resuming both an idle and a busy coordinator. It provisions its own home/config/database/provider and must never be pointed at the shared daemon.

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
JSONC layer. Saving compares the original full file/target expectation and
preserves comments, sibling fields and WSL atomic-write protections. Removing the
override restores inheritance.
`node --import tsx scripts/test-subagent-depth-settings-native.mjs <absolute-isolated-opencode-cli>`
(also in the latest-runtime CI job) qualifies this against a private runtime: depth
capability, JSONC save/reset preserving comments and siblings, stale-expectation
conflicts and foreign-location rejection.

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
`config.get` discovery root; backend leases live outside that watched root. Tools, context hooks and typed
RPC initially register through backend presence. `retainMissionWork` preserves
registered Missions while active/unsettled work, receipts or uncertain storage
remain, including after lease loss; subsequent protected sends still pass the
owning backend's fresh admission checks. Never install project-local files; the
server typecheck covers the plugin contract.

Assignment prompts and report synthetics use a narrow authenticated loopback bridge mode. The owning backend reconciles the persisted task/report via `codenomad.missions.snapshot`, validates complete native session ownership and selection, acquires the worktree mutation fence, and applies the current full profile environment before admission. Native environment errors are redacted and fail closed. Environment data never travels through the UI or plugin. Multiple owning backends are rejected rather than choosing a profile arbitrarily.

Before either kind of admission, the backend also refreshes its owned `codenomad.git-availability` instruction through `syncSessionGitContext`, removing stale context after recovery. This bounded Git advisory is separate from fail-closed environment synchronization: admission proceeds when it fails, while cancellation and connection retirement block admission.

The bridge accepts up to 250,000 assembled text characters within its 512 KiB JSON body limit. This accommodates the maximum objective, brief, title and dependencies after XML escaping (up to 5×), including JSON control-character escaping on the wire. HTTP regression coverage exercises maximum accepted contracts for all playbooks.

This transport reuses only the automation bridge discovery; automation keeps its own execution-time session/window fences. Environment and model state are session-scoped: a queued inbox item runs with the session's state at execution time; see [SESSION_ENVIRONMENT.md](SESSION_ENVIRONMENT.md).

## Safety limits

- One native project per mission.
- Coordinator and independent actor admission require exact owned roots; native
  descendant observation/reporting uses its separate ancestry/provenance contract.
  Foreign projects are rejected; a graph edge never grants session authority.
- At most 8 actors, 96 tasks, 20 live maps, and 2,000 stored journal entries per
  project. Tombstones retain evidence and count against journal storage only.
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
  receipt-backed native `mission-limit`): the UI keeps the draft and re-enables
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
- **Wayfinder Map** adapts destination, map, frontier, claims, and fog-of-war planning to visible sessions. It remains planning-first and uses native Forms for human decisions.
- **Product delivery** (`delivery`) adapts the NomadWorks Collective method (`NeuralNomadsAI/NomadWorks`) without requiring that plugin. The coordinator acts as Product Manager: it classifies each request by complexity (tiny, standard, complex) and track (implementation, investigation, spec), has the business analyst and tech lead draft a Spec Change Request for any behavioral change (tiny included), standard or complex implementation and spec work, runs read-only pre-sync readiness reviews before implementation, decomposes complex work into slices with the technical architect, keeps one shared-checkout implementation task at a time, and closes only with QA/tech-lead evidence and resolved documentation impact. The six roles are business analyst, technical architect, tech lead, developer, QA engineer and UI/UX designer. Request approval is coordinator guidance through a native Form, and the human owns commits. One playbook covers both NomadWorks team presets; the coordinator declares only the roles each complexity needs. Same-scope rework retires the task and adds a replacement (`replacesTaskKey`); continuing a native specialist's context uses a follow-up task whose `reuseFromTaskKey` names that specialist's finished, still-live task.

## Validation

`node scripts/test-missions-native-trajectory.mjs <absolute-isolated-opencode-cli>` also checks one-time Wayfinder refusal without journal mutation, then artifact-free completion from a native child question answered through the authenticated UI route. The invocation unit tests cover graph isolation, missing/stale invocations, interruption joining and per-check deadlines.

Each complete one-time human-gate call (acquisition plus its nested SQL/Form/storage reads) shares one 10-second deadline, matching `missions/native-human-evidence.ts`, combined with invocation cancellation. The check aborts and joins only its own runtimes and clears its timer on settlement; later checks get a fresh budget, excluding intervening session/authority work. The invocation joins all pending checks/reads before graph release. A raw Promise that ignores abort may remain pending, but cannot resume its cancelled Effect into the graph, and later reads through that expired check are refused. A stuck native finalizer or uninterruptible read is joined before its graph is released: never abandon such work with a Promise race, and keep reads interruptible and cleanup finite. Recurring gates use their own runners.

`node scripts/test-missions-native-family-control.mjs <absolute-isolated-opencode-cli>` (latest-runtime CI) qualifies recursive Pause/Play and Stop with real background subagents in a private runtime: a five-session, three-level family interrupted deepest-first with complete receipts, Pause parking results without model turns, Play resuming only the coordinator with interrupted-child context, Stop emptying family inboxes.

`npm run qualify:browser:native-mission-replay --workspace @codenomad/ui`
(`tests/browser/native-mission-integration.qualification.ts`) replays a captured
private native run through the real renderer only: it requires `NATIVE_MISSION_CAPTURE`
as the absolute path of that run's `capture.json`, fails when it is missing,
answers mutations with 405 and writes `browser-report.json` to the absolute
`NATIVE_MISSION_OUTPUT` (default: a temporary folder).

## Agent conventions

- Mission sections use `components/mission-disclosure.tsx` and the shared `.disclosure-chevron`. Keep disclosure/selection/reader identities in the native per-window layout via `stores/mission-view-state.ts`, independent of refreshed snapshot object identity. Long mission content uses `components/mission-reader.tsx` above the transcript; its chrome follows `.window-*`. Mission styles live under `styles/panels/mission-*.css`. Recurring setup/list geometry lives in `styles/panels/mission-recurrence.css`. Template and execution mode are orthogonal; recurring drafts freeze the chosen template, optional verbatim notes and exact coordinator/playbook-role profiles. Recurring uses the same brief-only library, never storing clock, watch or invocation state in a brief. CREATE and UI share `recurrenceReadBudget` / `recurrenceInputBudget`, with exact native Location room; never raise a ceiling automatically. Creation is one screen (`components/mission-editor.tsx`, `styles/panels/mission-create.css`): the shared objective/instructions draft, an editable title prefilled from its first sentence (≤60, `missions/mission-title.ts`), Once / Every day at [time] with the resolved zone, and everything else under one collapsed Options disclosure (catalog-backed profile selectors stay lazily nested), except Compare's required Model A/B selectors in the main form. The panel's Create button heads the form. The footer has a single **Create** submit: creation never starts anything; one-time Missions and schedules start only through their separate explicit Play. Validation stays inline beside its field.
- The Missions panel header (`components/mission-picker.tsx`, `styles/panels/mission-picker.css`) has a compact right-aligned toolbar ([+] create, then the panel's preferences gear and refresh) above one "current mission" line modelled on the provider account control: chevron, then the selected-title field (title + small square status mark). Edit and delete live in the selected detail's toolbar (below). The chevron toggles a persistent inline list, saved per project as `listExpanded` in `stores/mission-view-state.ts`; the field opens the same list as a transient ARIA combobox/listbox popup (arrows/Home/End/Enter, Escape, outside click, selection close it). Rows (one-time and recurring) show only the title (`lib/mission-display.ts`) and a status mark; full state lives in the tooltip and screen-reader text. Lists scroll natively within a bounded height; the title filter appears only while the rendered list measurably overflows, or still holds text. The chevron mirrors a collapsed session parent's activity among the OTHER entries (`mission-picker-model.ts`): waiting → permission colour, failed → error colour, running → working colour with pulse, with counts in its label. Row actions live only at the top of the selected detail (`components/mission-action-bar.tsx`, `mission-selected-actions.tsx`): ▶/⏸ (▶ becomes coordinator recovery only when the coordinator is observed idle-without-report), Stop… (schedules add Run now), then the Summary eye, Open conversation, edit and delete — always visible, disabled when not applicable (edit only for an active one-time Mission; edit/delete apply to one-time Missions only), never folded into a `…` overflow menu; Request an update is a compact left-aligned `.window-text-button` below the toolbar (above the task separator, `--space-sm` rhythm), relabelled and disabled while pending/uncertain, hidden when unavailable (a schedule keeps one only for secondary controls such as Run now). Retrying an unconfirmed control belongs to the header ⟳: it reads status first, then resends only a still-unconfirmed exact request (original requestID/expectedRevision) from that explicit click. Stop and Delete confirm first. Selection uses the shared `--list-item-highlight-*` tokens; never use the input-field surface (`--surface-base`) as a panel or popup background. Nothing is selected by default, and only the picker changes the persisted per-project selection: opening a Mission's conversation never reselects it.
- Nothing renders below the list until a Mission or schedule is selected. The selection's detail is then a separate `section.mission-detail` after the whole list (`components/mission-tracking.tsx`, `styles/panels/mission-detail.css`), never inside its row: the action toolbar, whose "Summary" eye (`MissionActionBar`'s `.mission-overview-toggle` `icon-toggle`) toggles the central overview reader, then "Needs you" (`components/mission-attention.tsx`: one compact line per open native Form/permission with an Answer button; who asks stays in the tooltip and accessible description), then the task tree. `components/mission-task-tree.tsx` is THE task view: `mission-graph.tsx` draws only declared `blockedBy` dependencies (including completed/retired work, never inferred native ancestry) beside one row per task, each edge leaving and entering the measured status icons (done, active, awaiting input, assigned/ready, waiting, blocked, failed, retired); the status word lives only in the tooltip and screen-reader text. Clicking a node toggles its exact task reader; never add a per-row eye. All prose (results, summaries, briefings, explanations) belongs in the central reader. Graph styles live in `styles/panels/mission-graph.css`; the remaining shared list chrome (`components/mission-list-item.tsx`, `styles/panels/mission-list-item.css`) serves cleanup receipts.
- The overview reader (`components/mission-reader.tsx`) keeps the result/briefing/objective first and folds secondary material at its bottom through `components/mission-overview-details.tsx`: Plan changes, Reports (each opening its exact reader), conversation cleanup history and Technical details (mission/coordinator/schedule/passage IDs and requested profiles), plus the pending coordinator-notification note. Task and schedule readers also keep identifiers in a collapsed Technical details. Only cleanup that needs an explicit retry stays in the panel. Task readers consolidate bounded brief/report/evidence pages with dependency navigation and existing truthful execution/profile/notification surfaces. Useful recursive delegation guidance propagates through canonical assignment prompts; native runtime permissions and configured depth remain authoritative, never an imposed target or a root-fallback trigger.
- A selected schedule uses the same detail (`styles/panels/mission-schedule.css`): the same action toolbar, whose Summary eye opens the admitted passage's overview, else the schedule reader; one interrupted/uncertain sentence pointing at the toolbar's primary Resume/Check action and any last scheduled-check failure; the current passage's Needs you/tree when a passage is admitted; then a compact list of past runs (date · outcome), each toggling its exact run reader centrally. Running schedule rows show their next run. Schedule times always use the schedule zone (`components/mission-schedule-text.ts`), labelled only when it differs from the viewer's zone. The central schedule reader (`components/mission-recurrence-reader.tsx`) follows the same plain grammar: rule, the selected run's result (or one plain failure sentence with Retry), every run, and identifiers only in a collapsed Technical details.
- Task readers put results before collapsed brief/technical details. "Needs you" contains only open native Forms/permissions and routes "Answer" to the exact actor conversation and interruption dock; reported obstacles stay in the readers, and retired/replaced attempts never become current blockers. Tree statuses stay truthful: admission is only "Assigned", observed native activity alone is "Active", an observed native Form/permission is "Awaiting your input", unmet dependencies are "Waiting" and a reported blockage is "Blocked". Task navigation uses only exact owned non-coordinator actors, never a generic coordinator fallback or inferred bindings; the row's Open conversation supplies the single coordinator link. Uncertain sends are never replayed automatically.
- One-shot Missions and exact admitted recurring passages share `components/mission-tracking.tsx`. `recurrenceCurrent` derives the owned isolated journal; `recurrencePassageRead` reads archived bounded prose while CREATE retains its separate `recurrenceRead({ id })` schedule lookup. Reader targets preserve exact instance/project/schedule/passage and semantic section identity, never arbitrary session selectors or transcript substitutes. Calendar CAS emits `rpc.codenomad.missions.scheduleChanged` only after commit through the fresh native graph's Bus; a lost invalidation never replays a mutation.
- `stores/mission-recurrence.ts` owns shared visible list/current/reader demand, connection fencing and coalesced trailing reads without polling, and preserves unknown holds across remounts; the control and snapshot contract is `MISSIONS_RECURRING.md`.
- Archived and current remote reader numeric drafts use `components/mission-reader-number.tsx` and commit on Enter/blur, not the first digit. Keep existing toolbar DOM mounted during same-source reads; local in-memory reader pagination stays immediate. A selected schedule's past-run list lives in `styles/panels/mission-detail.css`.
- Coordinators publish project briefings automatically at business milestones (initial plan, each task settlement, waiting on a human, before the final report) with requestID `auto:<revision>` and plain user-facing summaries (`missions/recipes.ts`); briefings come only from these milestones and explicit requests. An explicit update request is `createMissionBriefingRequest` in `components/mission-briefing.tsx` (the "Request an update" text button below the selected toolbar; its pending/uncertain feedback shows under it). Full briefing/final prose and task sources belong in the central `MissionReader`, opened/hidden with the detail toolbar's Summary eye. The fixed request follows `lib/mission-coordinator-message.ts` through ordinary native admission. Match its exact request ID before acknowledging a received briefing, retain pending/uncertain state by identity, and never replay it automatically. The coordinator-only `missions/briefing.ts` contract records a bounded narrative with assessed revision and exact task sources, separate from observed activity/task settlement/final outcome. Show stale-map/new-result notices and source readers in the reader without inventing semantic updates or human requests. For existing missions without a briefing, expose bounded exact current results/obstacles in the overview reader and use the tree for the remaining plan. Mission rows say "In progress" for an open mission (its lifecycle state); never show declared task counts as progress. Terminal missions omit settled lifecycle actions but retain unresolved control receipts. Project cleanup uses one disclosure for pending and settled receipts.
- Mission display demand follows the actual right-panel visibility and selected tab. Preserve cached snapshots while hidden, cancel queued trailing display reads, and revalidate on activation. Only native lifecycle events (`session.execution.*`, compaction, inbox, Shell, Form and permission events) invalidate activity; text/tool-progress deltas never do. Explicit recovery reuses the selected Mission's ▶ and the tree's task recovery actions through `createMissionRecoveryAction`, mounted once per Mission row; never add a separate administration surface or an automatic mutation retry.
- Missions preferences live in the Settings/Preferences window's Missions section (`components/settings/missions-settings-section.tsx`); the Missions panel header gear deep-links there via `openSettings("missions")`. `stores/settings-screen.ts` is the single Settings route for every entry point: local Electron/Tauri windows always reuse/focus the one native Preferences window with the active instance/Location; only browser and remote windows use the embedded screen. A native rejection (e.g. an installed host lacking the section, which needs a native rebuild) shows an error notification and never opens a second, embedded Settings surface. Keep the section allowlist identical across renderer, Electron and Tauri (`native-mission-preferences.test.ts`). Project-scoped parts (catalog, Location depth) use the opener's instance/Location and stay disabled without one. `components/mission-preferences.tsx` writes each choice at once, compare-and-swapped against the value stored at its turn. Edits made during a write stay enabled (disabling a control drops its keyboard focus) and queue behind it, shown immediately, across window/section remounts. Each edit touches one role or the task-session policy of one scope and is refused when that stored value is no longer the one it was made from, so a queued edit never overwrites another window's change to that value or resends a rejected edit of it. (Customizing an inherited role copies the global values shown at edit time.) A rejected or unconfirmed write is never resent: a read-only reload shows the stored values, with Reload offered only when that read fails or the document is unreadable. The fold's Reset (confirmed) clears only the shown scope's agents/models; resetting an unreadable document is a separate confirmed repair. Catalog/depth demand stays fenced by that section's visibility. Agent/model choices use one `MissionProfileControls` row per role everywhere (coordinator, then the type's roles, Debugging included). In a mission-type scope, rows show the inherited global values with a muted Global mark; editing a field customizes the role starting from those values, its revert icon inherits again, and an all-native choice remains an explicit override (inherit, native default and a selected profile stay distinct). Creation waits for loaded preferences, shows requested choices and keeps overrides collapsed. Profiles use compact square native selectors in `components/mission-profile-controls.tsx`; preference/profile/library layout lives in `styles/panels/mission-preferences.css`. Saved briefs are bounded versioned brief-only records under existing owned UI preferences (`lib/mission-model-library.ts`). Creation shows one "Start from a brief" select at the top of Options that loads on selection (Remove/Reload in its small `…` overflow) and a footer "Save as brief" text button that asks for a name inline (`components/mission-model-library.tsx`, styles in `styles/panels/mission-create.css`); only Preferences keeps the full library manager and invalid-library repair. A selected one-time Mission, including a finished one, offers the same "Save as brief" text action beside its update request (`MissionActionBar` secondary row): `missionRecordedBrief` copies only its recorded objective, verbatim notes, template, frozen profiles and taskMode (the title only prefills the name). Loading copies into ordinary manual creation and is never a launch, delete preserves all executions, and arrays retain config merge-patch replacement semantics. Preserve exact choices in uncertain creation drafts. Defaults never silently reconfigure existing/busy actors.
- Delegation is a per-new-mission task-session policy (`taskMode`, omitted means native). `mission-task-mode-controls.tsx` shares its compact native selector between preferences and creation. Task agents use subagent/all in native mode and primary/all in independent mode; coordinators always use primary/all. Freeze the policy with the creation/defaults snapshot and uncertain request identity, preserve it in explicitly selected saved briefs, and never change existing Missions or OpenCode configuration. Ordinary internal helper calls remain governed by native permissions/depth.
- Delegation's native depth editor (`mission-subagent-depth.tsx`) is separately Location/project scoped and affects all OpenCode conversations there, unlike global new-mission defaults. Demand only while the Preferences window's Missions section is visible, retain dirty drafts and exact file expectations by instance/directory, and never invent an unknown effective depth or label zero as disabled. Enter or leaving the field writes a changed valid value (Inherit writes at once; pressing it keeps focus in the field so the typed value is not saved first; Escape discards an unsaved value) without reload/restart; invalid values are flagged, never written. A write acknowledged after the view was left or hidden is accepted and reread on the next activation. Reads and writes make the field read-only rather than disabled, preserving focus. The refresh icon appears only after an error or an unconfirmed write; uncertain writes remain fenced until that explicit refresh and are never replayed automatically.
- Missions task scrolling uses `components/mission-task-scroll.ts` with `styles/panels/mission-task-tree.css`: the task flow fills the remaining panel height and owns scrolling when the header and task minimum fit; on shorter layouts the whole panel is the sole task-content scroller so controls remain reachable. Size/child-list observations select the policy without polling or oscillation. The picker retains its independently bounded list. Graph endpoints measure the status-icon edges in SVG coordinates, including RTL and zoom. Keep IME composition keys in the picker search, and preserve Space activation without a duplicate keyup click. Validate with `tests/browser/mission-panel-geometry.test.ts`.
- One-time Missions ships through `DesktopPluginLifecycle("missions")` and backend presence, with project-scoped native storage. Every backend that publishes its loopback bridge provisions it, desktop or standalone. Bridge registrations name only `http://127.0.0.1`: the bridge reuses the HTTP listener only when bound to 127.0.0.1/0.0.0.0 (`acceptsIpv4Loopback`), otherwise (HTTP not requested, IPv6/`localhost`/LAN HTTP-only) it gets an unannounced private listener on a random 127.0.0.1 port. All listeners of one backend share a single `WorktreeDeletionFence` (with its mission holds), so a deletion through HTTPS drains bridge admissions. Window/browser automation stays desktop-only; without a desktop host the bridge's `browser-claim` answers only `purpose: "mission"`. The Missions snapshot distinguishes `host-unavailable` (no bridge, answered without reading OpenCode), `plugin-unavailable` (OpenCode has not loaded it) and `plugin-failed`; never tell users to reconnect CodeNomad for a plugin OpenCode must load. Keep roles independent of native execution IDs. Persist explicit agent/model/variant selections and never switch a busy actor for a queued task. Preserve authenticated admission, ownership/connection/worktree fences and per-send profile environment. One-time map update/control/delete/recovery routes share `server/routes/mission-map-mutation.ts`: creation's fenced connection and worktree-deletion admission, a fresh workspace/connection/location recheck after all preparation, and the permit held through the single unretried RPC. Validate one-time behavior with the isolated `scripts/test-missions-native.mjs` fixture.
- One-time Missions use the journal `codenomad-missions/v2` with wire/schema version 1 and its one-time receipts. Never read, import, mutate, delete or initialize the `codenomad-missions/authority-*` namespaces, register a managed-owner observer, add `migrateLegacy` or add migration UI (`desktop-plugin.test.ts` traps that namespace access; `managed-owner-plugin.test.ts` keeps the managed-owner observer and authority modules out of the bundle). Rollout requires the acceptance journeys in `MISSIONS_RECURRING.md` (record: `MISSIONS_RECURRING_QUALIFICATION.md`) and §User-journey regression checks above.
- `packages/server/src/host-lifetime/` holds only the private-storage, process-identity and profile-scope primitives Missions uses (`storage`, `private-storage-sync`, `windows-storage`, `process-identity`, `protocol`); never add a persistent CodeNomad backend host to it. Never replace a native ownership gate with a no-op or environment flag, steal a live/unknown owner, log secrets, or include the shared OpenCode daemon in backend cleanup.
- One-time lifecycle state and actions live in `createMissionLifecycle` (`components/mission-lifecycle-controls.tsx`), surfaced only as the toolbar's primary action and Stop, with Check status for an unresolved request; family interruption lives in `missions/native-family-interrupt.ts` and follows Explicit execution controls above (`readNativeControlFamily`, never the 32-session display read; never claim a full stop without a complete `descendants` receipt). Do not turn notification recovery into a control-action runner.
