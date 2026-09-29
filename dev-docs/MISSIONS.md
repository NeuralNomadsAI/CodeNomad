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

Lifecycle RPC methods declare expected mutation failures as `mission.rejected` with a structured `data.code`. Plugin handlers convert only recognized `MissionControlError` failures via the native invocation's `context.error`; the HTTP routes map those codes to 409 (conflict), 404 (missing), or 403 (ownership). Ordinary exceptions remain opaque plugin failures (503). The isolated native fixture exercises stale update/delete, request-ID conflicts and unknown missions through the real HTTP-to-RPC boundary.

The map is an append-only event journal in native plugin storage. Events have deterministic identities, and native prompt/synthetic admissions use deterministic message IDs. Retrying after a plugin or CodeNomad restart therefore resumes an incomplete dispatch without creating a second task, actor, or inbox item.

Report persistence and coordinator notification are separate steps. A saved `task.reported` without a matching `report.notified` acknowledgement is a pending notification, not proof that the coordinator has resumed. Active plugin instances recover these notifications on activation and retry with bounded backoff through the same authenticated bridge. They reuse the deterministic native message ID, skip acknowledged reports and terminal/deleted missions, and stop recovery when disposed. This outbox only delivers already-written reports; it never dispatches tasks or chooses a workflow transition. The snapshot exposes `report.notificationStatus` (`pending` or `admitted`), and Mission Control shows pending notification delivery separately from task completion. Admission is not evidence that the model has read the report or followed its recommendations.

Snapshots are authoritative reconstructions of the journal. RPC events are only invalidations; the UI always reloads a snapshot after reconnect because native event subscriptions are live-only.

Project mutation and journal-append exclusion is shared by all bundle incarnations in the native host. Disposing registrations does not release an in-flight mutation's lock: a content-addressed replacement must wait before reading its CAS revision. `missions-reload.test.ts` loads two independent compiled bundles and races updates across dispose/setup to verify that only one can succeed.

The Centre of mission manages map metadata through the authenticated CodeNomad routes `POST /api/workspaces/:id/missions`, `PATCH /api/workspaces/:id/missions/:missionID`, and `DELETE /api/workspaces/:id/missions/:missionID`. These broker only the typed `create`, `update`, and `delete` methods of `codenomad.missions`; they do not expose generic RPC. Create uses a stable request ID, may attach an owned root session or create a new root without prompting, and update uses revision compare-and-swap for objective/notes. Delete appends a tombstone: the map disappears from snapshots and membership, but OpenCode sessions and their conversations are never deleted or aborted. Late reports for a tombstoned mission cannot recreate its map. Tombstones remain subject to the project journal event limit.

`mission.revise` is a coordinator-only, append-only plan change with `expectedRevision`, stable `requestID`, and a required reason. It can update objective/notes, add tasks with new keys linked to retired predecessors, retire tasks, and rewrite dependencies in one atomic event. A retired task is not completed evidence. Every remaining dependent must explicitly point to a live task or remove that dependency; cycles and edits to already dispatched dependencies are rejected. Existing task contracts and reports are immutable. A late report from retired admitted work remains visible as late history and never changes the task back to completed. No session is aborted and no busy actor is reconfigured.

Mission snapshots expose the latest 50 plan changes (`history`, with `historyTruncated` when older entries are omitted), including human objective/notes edits and coordinator revisions. Each entry has a revision and timestamp; `source` distinguishes `user` from `coordinator`. Human edits intentionally have no synthetic actor session or reason; coordinator entries retain their actor and required reason. Older history entries without `source` are coordinator-originated. Snapshots also expose task lineage (`replacesTaskKey`/`replacedByTaskKey`), late reports, and `outstandingExecution`. A withdrawn task with admitted native work must receive a terminal report before the mission can be finished; runtime idle is not proof that queued/admitted work stopped. This is bookkeeping, not native cancellation or a guarantee that an external actor has stopped working.

`node scripts/test-missions-native.mjs <absolute-isolated-opencode-cli>` exercises native tool registration/restart plus revision, late-report delivery, lifecycle create/update/delete replay, tombstone projection, and transcript preservation. Report checks observe the actual provider request containing the report after resuming both an idle and a busy coordinator; waiting for native idle alone is not proof of consumption. It provisions its own home/config/database/provider and must never be pointed at the shared daemon.

The notification recovery regression removes the private bridge before a report, proves the report was durably saved despite admission failure, restores the bridge with and without a plugin restart, and requires a provider turn containing that report without another report call or human prompt. It also checks that an explicit replay after acknowledgement retains a single correlated native message and does not cause another wake-up.

## Native execution selection (2.0.11)

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

The mission index is a bounded vertical list with inline edit/delete icons and a header create action. The work section keeps all tasks in stable dependency order, including completed and retired work. Its measured rail draws only declared `blockedBy` edges, with separate side lanes so an edge never passes through an unrelated task node. Expanding details or resizing updates the geometry.

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
