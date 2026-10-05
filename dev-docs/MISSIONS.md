# CodeNomad Missions / Session Mesh

Missions are a thin coordination plane over native OpenCode V2 sessions. They intentionally do not provide a YAML workflow language, general interpreter, scheduler, or hidden worker runtime.

## Ownership

| Concern | Owner |
| --- | --- |
| Root sessions, prompts, durable inbox, execution, Forms, permissions | OpenCode V2 |
| Mission map and role context | Bundled `codenomad.missions` plugin; project-scoped native storage |
| Workspace/location authorization and browser access | CodeNomad |
| Checkout isolation and Git policy | Existing CodeNomad worktree/Git modules |
| Developer feedback | Separate `codenomad.automation` plugin and its visible-session fence |

The plugin exposes `mission.inspect`, `mission.delegate`, `mission.revise`, and `mission.report`. The coordinator is the sole topology writer. Specialists receive one bounded assignment and report through a correlated synthetic inbox item. Delegation uses native `queue` delivery and `resume: true`, so a busy actor keeps the work in its durable inbox while an idle actor can begin immediately.

## Durability and recovery

### Human instructions and actionable attention

Mission Control starts with a recorded-result overview, current task counts and
observed activity. Open native Forms/permissions ("Your response is needed") are
the only human-response alerts. Returned blocked reports are obstacles to read,
not an assertion that the user must decide something. Retired or replaced blockers
remain readable in the historical results but are not current requests.
Recent recorded advances and results lead into the declared dependency graph.
The overview does not repeat each task result or blockage title. Technical reports,
native conversations and plan-change history are
progressive details, not competing top-level tracking surfaces. Cleanup receipts
appear at the bottom; successful historical cleanup is collapsed.

Work and task readers link only to an exact owned non-coordinator task actor when
recorded. Missing bindings produce no generic coordinator substitute. The mission
index keeps its single coordinator action. Native ancestry or text mentioning a
child session never manufactures a task/actor association. Task readers show the
current result/evidence/next steps first; the brief and native technical metadata
are separate collapsed details. A historical late attempt must not replace a
current result or become evidence of current completion.

Reader pages retain exact surrogate-safe source slices. `mission-markdown-pages.ts`
adds bounded display-only continuation fences for standalone fenced code; interrupted
or oversized fence contexts fall back to literal source pages. Copy always uses
the complete original section, not synthesized Markdown. Arbitrary list/table/quote
excerpts are not a promise of full-document Markdown pagination equivalence.

"Give direction" is a collapsed, explicit ordinary user prompt, with optional
priority/constraint/alternative intent and exact task context. It uses
native `steer` delivery through the existing authorized session proxy and its
per-send profile environment. It preserves the coordinator's native agent/model,
does not switch the selected conversation or edit the main composer, and is
separate from objective/shared technical-note metadata edits. Mission identity,
connection, view lifetime and current running state are rechecked during
preparation/admission; paused/prepared/terminal missions cannot be sent from this
surface. These UI checks are not an atomic Mission lifecycle/native prompt
transaction and do not replace native ownership or execution gates.

Drafts are in-memory and scoped by instance, project/directory, mission and
coordinator; they survive navigation/remount, not application restart. Confirmation
means prompt admission only, never model consumption or execution of the requested
change. An uncertain send preserves its draft and disables another attempt until
the user explicitly discards it and starts anew after checking the conversation.
No automatic resume, report recovery, assignment replay or failed-prompt retry is
added. Late acknowledgements settle the original draft, not the currently viewed
mission. Browser fixtures exercise real Solid components/generated clients against
isolated HTTP responses; they never send instructions to a user's live Mission.

### Defaults, reusable briefs and separate executions

Settings → Missions owns the global requested coordinator/task profiles. The
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
implement deduplication by itself. Date/recurrence/event automation remains gated
on qualified host continuity, explicit activation, bounded overlap/missed-run
policy, revision-scoped idempotency and publication safeguards. Continuing an
existing native background task is not proof that a future mission can launch
while CodeNomad is closed.

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

`packages/ui/tests/browser/mission-control.test.ts`, `mission-guidance.test.ts`,
`mission-task-reader.test.ts`, the editor/default/model fixtures and the progress
projection unit tests cover these surfaces. Native `test-missions-native.mjs`
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
but unreconciled save stays explicitly pending and creation remains fenced until
an explicit reload succeeds. Earlier GETs/ACKs never substitute stale cached defaults
as authoritative creation input.

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
Pocock's resolver still requires dependency-connected implementer/review evidence,
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

The independent-of-desktop target and private proof artifacts are documented in `MISSIONS_CONTINUITY_CONTRACT.md`, `MISSIONS_CONTINUITY_SPIKE.md`, `MISSIONS_AUTHORITY_SPIKE.md` and `MISSIONS_HOST_SPIKE.md`. They are not proof of a shipped persistent authorization backend or secure migration. The current product still follows backend presence; full Electron/Tauri detach/reattach, trust provisioning, old-writer exclusion and whole-refactor Gatekeeper acceptance remain separate implementation gates. In particular, interrupting a parent alone cannot prevent a native background child's late notification from waking it.

Snapshots are authoritative reconstructions of the journal. RPC events are only invalidations; the UI always reloads a snapshot after reconnect because native event subscriptions are live-only.

Project mutation and journal-append exclusion is shared by all bundle incarnations in the native host. Disposing registrations does not release an in-flight mutation's lock: a content-addressed replacement must wait before reading its CAS revision. `missions-reload.test.ts` loads two independent compiled bundles and races updates across dispose/setup to verify that only one can succeed.

Mission Control manages map metadata through the authenticated CodeNomad routes `POST /api/workspaces/:id/missions`, `PATCH /api/workspaces/:id/missions/:missionID`, and `DELETE /api/workspaces/:id/missions/:missionID`. These broker only the typed `create`, `update`, and `delete` methods of `codenomad.missions`; they do not expose generic RPC. Create uses a stable request ID, may attach an owned root session or create a new root without prompting, and update uses revision compare-and-swap for objective/notes. Delete appends a tombstone: the map disappears from snapshots and membership. By default every conversation is preserved. Late reports for a tombstoned mission cannot recreate its map. Tombstones remain subject to the project journal event limit.

Deletion optionally accepts `deleteManagedSessions: true`. Immutable targets are recorded in the tombstone, and per-session receipts reserve journal capacity before removal. Only deterministically created specialist roots with matching native creation metadata and exact project/location identity qualify. Coordinators, reused sessions, actors referenced by another mission (including finished/deleted maps), and roots with children are retained. Native removal is recursive, so descendants are outside this opt-in. The plugin delegates removal to the authenticated desktop bridge: installed native plugin contexts do not expose `session.list/remove`. The bridge obtains authoritative intent through the narrow read-only `cleanupTarget` RPC, revalidates ownership/connection/worktree fences and calls the native HTTP client. It never modifies OpenCode storage directly. An incomplete cleanup returns `503 cleanup-pending` after the tombstone is committed; replay the exact original request ID, revision and option. The editor retains that request through live snapshot refreshes and locks the option after the first attempt. Cleanup has no background dispatcher.

### Explicit execution controls

The UI creates missions with `prepared: true`. A single Play button starts a prepared mission or resumes a paused one; Pause and terminal Stop are adjacent. Existing/agent-created mission journals remain running unless an explicit control changes them. `POST /api/workspaces/:id/missions/:missionID/control` brokers the typed `lifecycle` RPC (`action: start | pause | stop`, `requestId`, `expectedRevision`).

`mission.control-requested` records the durable desired state and exact root actors before native side effects; `mission.control-applied` receipts track acknowledgements. The project mutation lock serializes controls with assignments and report admissions. Partial failure returns `503 control-pending`, and the snapshot retains the original request and remaining targets for an explicit retry, including after a UI/plugin restart. Old completed requests cannot replay their side effects over newer states. Stop may supersede an incomplete start/pause; no action can restart a stopped/completed/failed mission. Receipt capacity is reserved before intent publication.

Pause immediately calls native `session.interrupt({ resume: false })` for the coordinator and all specialist roots, preserves task/inbox context, blocks new Mission dispatch/revision/finalization, and parks report notifications. A report arriving while paused is saved without waking the coordinator. Play resumes the coordinator and roots with unfinished admitted work via stable-ID native synthetic admissions, with fresh server-side environment and Git context and unchanged native agent/model selection. It does not automatically create or dispatch a new task graph.

Stop is irreversible for that mission. It interrupts those roots, cancels this mission's pending native inbox inputs, retains conversations/results, and withdraws unfinished tasks. Native controls always pass through the authenticated desktop bridge, authoritative snapshot, exact ownership/location and worktree/connection fences. Interruption acknowledgement is not an exact suspension of a tool process. These controls cover registered root actors, not native descendant execution or external wakeups; strict recursive pause is explicitly deferred.

`mission.revise` is a coordinator-only, append-only plan change with `expectedRevision`, stable `requestID`, and a required reason. It can update objective/notes, add tasks with new keys linked to retired predecessors, retire tasks, and rewrite dependencies in one atomic event. A retired task is not completed evidence. Every remaining dependent must explicitly point to a live task or remove that dependency; cycles and edits to already dispatched dependencies are rejected. Existing task contracts and reports are immutable. A late report from retired admitted work remains visible as late history and never changes the task back to completed. Revision itself does not interrupt sessions or reconfigure busy actors.

Mission snapshots expose the latest 50 plan changes (`history`, with `historyTruncated` when older entries are omitted), including human objective/notes edits and coordinator revisions. Each entry has a revision and timestamp; `source` distinguishes `user` from `coordinator`. Human edits intentionally have no synthetic actor session or reason; coordinator entries retain their actor and required reason. Older history entries without `source` are coordinator-originated. Snapshots also expose task lineage (`replacesTaskKey`/`replacedByTaskKey`), late reports, and `outstandingExecution`. A withdrawn task with admitted native work must receive a terminal report before the mission can be finished; runtime idle is not proof that queued/admitted work stopped. This is bookkeeping, not native cancellation or a guarantee that an external actor has stopped working.

`node scripts/test-missions-native.mjs <absolute-isolated-opencode-cli>` exercises native tool registration/restart plus revision, late-report delivery, lifecycle create/update/delete replay, tombstone projection, and transcript preservation. Report checks observe the actual provider request containing the report after resuming both an idle and a busy coordinator; waiting for native idle alone is not proof of consumption. It provisions its own home/config/database/provider and must never be pointed at the shared daemon.

The notification recovery regression removes the private bridge before a report, proves the report was durably saved despite admission failure, restores the bridge with and without a plugin restart, and requires a provider turn containing that report without another report call or human prompt. It also checks that an explicit replay after acknowledgement retains a single correlated native message and does not cause another wake-up.

## Native execution selection (2.0.11)

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

Durable actors remain root sessions. `session.create` does not expose child creation, and subagent-only profiles belong to the native `subagent` tool. Use native subagents for bounded child work, not as durable mission-map actors. Root actors use native agent/project permission rules; they do not inherit a coordinator's child-session permission state.

## Mission Centre presentation

The mission index is a bounded vertical list at the top level of the Missions tab, with two-line objectives, semantic state colors and inline reader/coordinator/edit/delete icons. A compact toolbar supplies create and refresh. Thin separators divide mission rows and top-level sections. Work comes first and initially opens; Reports, Conversations and History initially collapse, with live attention between Work and Reports when relevant. Explicit saved disclosure choices still take precedence. The work section keeps all tasks in stable dependency order, including completed and retired work. Its measured rail draws only declared `blockedBy` edges, with separate side lanes so an edge never passes through an unrelated task node. Expanding details or resizing updates the geometry.

The panel is a navigation surface: one-line excerpts and a shared eye action open individual objectives, briefs, reports or plan changes in the reader above the transcript. Evidence, next steps, artifacts and full text remain in that reader. Task details retain dependency navigation, replacement lineage and native execution comparison. Counts are secondary; actor/history sections initially collapse and attention appears only when there is a live request or recorded blockage. Native layout identities still preserve explicit disclosure, selection and reader gestures across refresh/remount.

## Distribution and environment

Desktop backends provision the content-addressed Missions bundle through `DesktopPluginLifecycle`, using the authenticated daemon's `config.get` discovery root. Backend leases live outside that watched root. Tools, context hooks and the sole typed snapshot RPC follow backend presence. No files are installed in the user's project. The old repository-local plugin entry is removed; `.opencode/checks/` still checks the published V2 plugin contract.

Assignment prompts and report synthetics use a narrow authenticated loopback bridge mode. The owning backend reconciles the persisted task/report via `codenomad.missions.snapshot`, validates complete native session ownership and selection, acquires the worktree mutation fence, and applies the current full profile environment before admission. Native environment errors are redacted and fail closed. No environment data travels through the UI or plugin. Multiple owning backends are rejected rather than choosing a profile arbitrarily.

Before either kind of admission, the backend also refreshes its owned `codenomad.git-availability` instruction through `syncSessionGitContext`, removing stale context after recovery. This bounded Git advisory remains separate from fail-closed environment synchronization; its failure does not block admission, but cancellation and connection retirement still do.

The bridge accepts up to 250,000 assembled text characters within its 512 KiB JSON body limit. This accommodates the maximum objective, brief, title and dependencies after XML escaping (up to 5×), including JSON control-character escaping on the wire. HTTP regression coverage exercises maximum accepted contracts for all playbooks.

This transport reuses desktop bridge discovery, not browser automation or its visible-window operations. Automation still has its independent execution-time session/window fences. Environment and model state are session-scoped, not atomic per-inbox-item snapshots; see [SESSION_ENVIRONMENT.md](SESSION_ENVIRONMENT.md).

## Safety limits

- One native project per mission.
- Root sessions only; child sessions and foreign projects are rejected.
- At most 8 actors, 96 tasks, 20 missions, and 2,000 stored events in one project view.
- Existing root actors may be reused, but an actor cannot join two active missions.
- Dependency tasks are mapped as blocked and are never auto-dispatched.
- Completing a mission green requires every active task to have a completed report and every withdrawn task with admitted work to have a terminal report. Pocock's completed-role evidence gates still apply; retirement cannot satisfy a gate.

## Included playbooks

- **Pocock Bug Expedition** preserves evidence-first diagnosis, behavioral TDD, independent fresh Standards and Spec reviews, implementer-session resolution, and a fresh read-only green gate. Completed role reports carry validated structured artifacts, while the coordinator still chooses each transition; no fixed state machine was ported.
- **Wayfinder Map** adapts destination, map, frontier, claims, and fog-of-war planning to visible sessions. It remains planning-first and uses native Forms for human decisions.

## Validation

Build the shipped plugin with `npm run build:missions --workspace @neuralnomads/codenomad`, then run `node scripts/test-missions-native.mjs <absolute-opencode-executable>`. The fixture uses isolated configuration/storage, the real bundled plugin, typed RPC, WorkspaceManager and bridge, plus a local deterministic provider. It verifies catalog selection, variant persistence, a busy actor's durable queue, mismatched selection refusal, per-send actor/coordinator environment, presence removal/re-registration, and retry idempotence. No shared service or user provider is used. The fixture passed on Windows with CLI/client/plugin 2.0.11 on 2026-09-20.

The native runtime findings and recovery matrix are recorded in [`MISSIONS_RUNTIME_SPIKE.md`](MISSIONS_RUNTIME_SPIKE.md).
