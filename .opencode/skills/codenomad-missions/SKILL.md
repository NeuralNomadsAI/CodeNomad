---
name: codenomad-missions
description: Coordinate bounded native tasks through the CodeNomad mission map, with explicit independent-root exceptions.
---

# CodeNomad Missions

Prefer ordinary native delegation for bounded work. Use a mission only when the user needs a durable shared task map, evidence gates, and explicit coordinator decisions.

1. To attach THIS root conversation as coordinator, call `mission.inspect` with `start.objective` and one template: `custom`, `debug`, `wayfinder`, `delivery`, or `compare` (two required different model profiles: `model-a` and `model-b`; coordinator-written protocol, identical briefs, always a blind `comparator`, verdict only). For a separate mission, use `mission.prepare` from any owned project session: an ordinary root, coordinator, descendant, current or historical task actor, or scheduled passage. It creates a new coordinator by default; calendar-backed work may explicitly select an eligible idle root. The actual caller stays unchanged; native ancestry supplies source provenance. Keep exactly one owning backend available; ambiguous ownership is refused. Creation defaults to paused for explicit Play. Only `prepare` accepts `startOnCreation: true`, and only when the user explicitly requests automatic first Play. Never combine `missionID` and `start`. Both accept optional `title` (1–60 characters, single-line, trimmed) and verbatim `notes`, including empty notes.
2. Read the returned playbook. The starting session is the coordinator and is the only session allowed to call `mission.delegate`.
3. Give every task a stable lowercase `taskKey`. Declare its role, real `blockedBy` dependencies, and execution mode separately from execution. Follow the mission's persisted `taskMode`: `native` defaults new declarations to native execution; `independent` requires explicit `executionMode.kind: "independent"`, a concrete reason and explanation for every declaration, including additions through `mission.revise`. The user-selected policy may justify reason `playbook` with an explicit explanation. A blocked declaration waits undispatched and needs no completed prerequisite reports yet.
4. In native task mode, prefer a fresh native child for independent work; reuse an exact specialist only when its context helps and continuation is eligible. Use an independent root only for a concrete `location`, `lifetime`, `existing-root`, or `playbook` reason and explanation. Native continuation names the exact live native `reuseFromTaskKey` with the same parent, never an arbitrary root or a guessed session. It selects context only; never add a `blockedBy` dependency just to reuse a session. Debugging resolvers require dependency-connected implementer and review evidence. Reuse admission requires an observed end/return of the exact current native execution and an idle bound session; never infer either from a report. Tasks stored without an execution mode keep root execution; never convert them.
5. For a native declaration, pass its canonical `assignmentPrompt` to an ordinary native subagent call only when the task is ready, preserving the declared execution profile and native continuation checks. Mutation results are compact (revision, frontier, affected tasks); `mission.inspect({ taskKey })` rereads a task's exact prompt and `mission.inspect` the full map. Only the coordinator asks the human: task actors and their helpers return open questions with options, evidence, consequences, reversibility and a recommendation. Before asking, resolve what you can (repository, research, an investigation task, a reversible default recorded as an assumption); ask only consent, credentials, choices expensive to reverse or product decisions the objective leaves open, batched into one native question call, after launching unrelated ready work. A native Wayfinder `decision` task returns a brief; settle it with your own decision (`decidedBy: "coordinator"`, cheap to reverse), defer it to the notes, or ask the human from your own conversation, ending the question with the task's `questionTag` (one tag per question; batch decisions as separate questions), and report it without an artifact; a human answer counts only with its confirmed UI mark, and only for the one decision its question names. `mission.interrupt({ taskKey })` stops a retired native task's conversations. Native children return actual evidence and required role artifacts through ordinary native results; the coordinator records each declared task's business readout with `mission.report`, `taskKey`, and no `contract`. Do not ask native children for duplicate reports or forward generations/bindings to helpers. Independent-root actors call `mission.report` themselves; their reports use the durable inbox to notify the coordinator.
6. Cover every explicitly requested workstream in the initial clear plan, including actionable preparation for blocked deliverables; record unclear scope in notes rather than silently dropping a workstream. Before waiting for one result, launch the other independent ready tasks using runtime-supported background or concurrent native calls. `blockedBy` must represent only real prerequisites. Missing tools, consent or failure in one workstream must not park unrelated ready work. Keep permission/evidence gates, resource limits and shared-write conflicts intact; state the concrete reason when work must be serial. An unavailable reused actor cannot run two assignments simultaneously; launch other ready work instead. Inspect after actual returned results/reports and choose the next ready frontier work. When discoveries change the plan, use coordinator-only `mission.revise` with the current revision, a stable request identity, and a reason. Add newly visible frontier tasks without a replacement link, or use linked replacements to retire old work. Never overwrite earlier contracts or reports; rewrite affected dependencies explicitly.
7. Finish through `mission.report({ final: true, ... })` only when the objective is actually met. Retired work never counts as success; retiring does not interrupt admitted native execution, which can finish on its own or be stopped with `mission.interrupt` when eligible; playbook proof requirements still apply. A retired native task takes no coordinator readout; record what it returned under its replacement or in the final report. Admitted retired work settles through its actor's terminal report or an observed native end.

Use `mission.inspect({ catalog: true })` before selecting a native execution profile.
Use `mission.inspect({ list: true })` to discover all project Missions, including human-created ones; explicit `missionID` reads them from any owned conversation. `project` provides pure bounded native views: `panel` for summaries, cleanup and mission fields; `current`, `current-page` and `current-content` for scheduled passages; `sources` for branch, conversation, coordinator and forge discovery. Continue only the returned pages/cursors explicitly. File criteria take relative paths; existing file tools discover them. Project reads preserve work and request identities.
Use `mission.inspect({ project: { kind: "playbook", template, taskMode } })` to read the UI's exact steps, roles and full prompts before creation (taskMode defaults to native).
Use `mission.inspect({ configurations: true })` to list the unique owning backend's saved configurations, including from an owned root outside a mission; pass `configurations: "<id>"` to read one record and its suggested title. Copy the chosen fields explicitly into `prepare` or `start`. For an oversized record, pass its `read` whole and join every slice following `next`; a changed digest requires a fresh read. Invalid or unavailable libraries require recovery, preserving their stored data.
Copy only `objective`, suggested `title`, `notes`, `template`, `profiles` and `taskMode`;
the saved record's `id`, `version` and `name` belong to the library.
Follow the [creation and retry discipline](../../../dev-docs/MISSIONS.md#mission-profile-selection-and-creation-recovery)
and its editor/tool option inventory. Subagent depth is a project setting; preparation
uses native permissions and the effective configured depth.

Use `mission.settings` from any owned project conversation for the library and
Missions settings. `scope: "configurations"` reads short IDs/names/templates;
`save` supplies `configuration` (stable UUID id, name, objective, notes, template,
optional profiles/taskMode), replacing/renaming an existing ID. Copy an inspected
Mission's recorded inputs to save its instructions. `delete` takes configurationID;
`reset` clears or repairs the library. `scope: "preferences"` selects field
`missionProfileDefaults` or `missionDeleteSessions`: save a complete `defaults`
array (all plus playbook scopes) or `deleteSessions`; reset restores defaults.
Omit a scope/role/taskMode to inherit; `{}` explicitly selects native defaults.
These preferences and the library are global to the owning CodeNomad profile.
Read first and pass its `expectation` on every write, including invalid-data repair:
it hashes the raw field and its presence, preserving concurrent human changes.
`scope: "depth"` reads the project snapshot; save 1–10 or null (Inherit/empty
experimental repair) with `snapshot.project.expectation`. Keep native permissions
and delegation limits intact. After conflict or uncertainty, read afresh; never
blindly replay a settings write.

`prepare` returns `outcome: prepared | activated | refused | uncertain`, a compact
`target` when created, and `acknowledgement: fresh | recovered` for confirmed outcomes.
`activated` confirms the original first Play. Reuse the same requestID and original
inputs, including `startOnCreation`; never substitute a returned native request ID.
Replay identity belongs to the actual author and its native source when present,
including after source completion. Another caller has its own identity and visibility.
A changed flag conflicts. A recovered creation
never continues Play: an unattempted automatic start stays prepared, an attempted
one exposes its original acknowledgement or uncertainty. Inspect the saved target;
never replace an uncertain request or emulate controls.

`mission.program` manages the programmed Missions of this conversation's directory: a
Mission launched again by a repeating schedule or by Git/forge events, each launch in
the same coordinator conversation. `list` returns each one's id, title, paused, current
`missionID`, launch criteria and next due time. `save` takes a stable `id` and the
complete configuration, with an agent and model for the coordinator and every role;
saving the same `id` again replaces it. `pause`, `resume` and `delete` take the `id`;
the current Mission is deleted with `mission.delete`. A refusal names its code:
`calendar-unsupported` with its reason, `calendar-missing` or `calendar-unavailable`.

`mission.control` controls any one-time project Mission from any owned conversation:
`play`, `resume`, graceful `pause`, immediate `interrupt`, terminal `stop`,
`recover-coordinator` (including failed Missions), `recover-report` with `taskKey`,
and `request-update` with optional `language`. The last action asks for a briefing;
the coordinator publishes with `mission.briefing`. `mission.interrupt` instead stops
a retired task's native family. Mutations take a stable `requestID` and the fresh
`expectedRevision`. Use `action: "read"` and the original `requestID` to observe an
uncertain result without sending again.

`mission.configure({ action: "save", ... })` edits a Mission's objective and notes.
`mission.delete({ action: "delete", ... })` uses the
ordinary cleanup; omitted `deleteManagedSessions` freezes the owning profile's
preference. Its `read` retains cleanup after deletion. Never replace an unknown
request identity. Explicit `retry: true` keeps every original field and requires a
positively read partial lifecycle or cleanup receipt.

`prepare` creates a one-time Mission: `launch` absent, empty or a sole `now`. A repeating
schedule or an event is refused with `use-mission-program`. Keep followed sources
(`watchedConversationIDs`) and the start flag unchanged on retry.

The mission `role` is independent of `execution.agent`. To pin execution, pass
`execution: { agent: "catalog-agent-id", model: { providerID: "catalog-provider", id: "catalog-model", variant: "optional-catalog-variant" } }`.
Repeat the same selection when retrying a task. Omitted task execution fields use native defaults.
Native tasks accept subagent/all agents; independent roots and tasks stored
without an execution mode accept primary/all agents. Each child owns its bounded assignment and
may recursively decompose independent subtasks when useful, integrating actual returned
evidence before returning to its immediate parent. Pass relevant scope, role constraints,
safety boundaries and this delegation policy to each helper yourself. Helpers gain neither coordinator topology authority nor task-report
privileges and return to their parent instead of calling `mission.report`. Respect native
permissions and the user's configured runtime depth; do not change configuration, force
delegation levels, or turn a denied/depth-limited helper into an undeclared independent root.
At a native limit, finish within scope or return the limitation. Avoid conflicting edits
and shared mutable checks; never treat a background launch as completion. Reused actors must already match the selection;
Missions never switches the model of a busy session. Queued native inputs can pick up
later model or environment changes made from another client.

Never create speculative tasks, polling loops, nested coordinators, or publication automation.

Use only tools and fields exposed by the attached server; never emulate missing tools, fabricate bindings, or migrate real mission data. Business report envelope for coordinator native readouts or assigned independent-root actors: `mission.report({ missionID, taskKey, outcome: "completed", summary, evidence: [], next: [], artifact, final: false })`; use the playbook's role-specific artifact. A business readout settles the plan only: execution termination, invocation identity and human consent each need their own evidence.
