---
name: codenomad-missions
description: Coordinate bounded native tasks through the CodeNomad mission map, with explicit independent-root exceptions.
---

# CodeNomad Missions

Prefer ordinary native delegation for bounded work. Use a mission only when the user needs a durable shared task map, evidence gates, and explicit coordinator decisions.

1. Call `mission.inspect` with `start.objective` and one template: `custom`, `debug`, `wayfinder`, `delivery`, or `compare` (two required different model profiles: `model-a` and `model-b`; coordinator-written protocol, identical briefs, always a blind `comparator`, verdict only).
2. Read the returned playbook. The starting session is the coordinator and is the only session allowed to call `mission.delegate`.
3. Give every task a stable lowercase `taskKey`. Declare its role, real `blockedBy` dependencies, and execution mode separately from execution. Native is the default for new declarations; a blocked declaration waits undispatched and needs no completed prerequisite reports yet.
4. Prefer a fresh native child for independent work; reuse an exact specialist only when its context helps and continuation is eligible. Use an independent root only for a concrete `location`, `lifetime`, `existing-root`, or `playbook` reason and explanation. Native continuation names the exact live native `reuseFromTaskKey` with the same parent, never an arbitrary root or a guessed session. It selects context only; never add a `blockedBy` dependency just to reuse a session. Debugging resolvers require dependency-connected implementer and review evidence. Reuse admission requires an observed end/return of the exact current native execution and an idle bound session; never infer either from a report. Tasks stored without an execution mode keep root execution; never convert them.
5. For a native declaration, pass its canonical `assignmentPrompt` to an ordinary native subagent call only when the task is ready, preserving the declared execution profile and native continuation checks. Mutation results are compact (revision, frontier, affected tasks); `mission.inspect({ taskKey })` rereads a task's exact prompt and `mission.inspect` the full map. A native Wayfinder `decision` task needs the human's own answer, given in the CodeNomad interface, to a native question asked from that task's conversation; use `research` for self-contained analysis. Its readout may omit the artifact when exactly one answered question qualifies; `mission.inspect({ taskKey })` lists the candidates. `mission.interrupt({ taskKey })` stops a retired native task's conversations; `mission.prepare` creates a paused hand-off mission that only the user starts. Native children return actual evidence and required role artifacts through ordinary native results; the coordinator records each declared task's business readout with `mission.report`, `taskKey`, and no `contract`. Do not ask native children for duplicate reports or forward generations/bindings to helpers. Independent-root actors call `mission.report` themselves; their reports use the durable inbox to notify the coordinator.
6. Cover every explicitly requested workstream in the initial clear plan, including actionable preparation for blocked deliverables; record unclear scope in notes rather than silently dropping a workstream. Before waiting for one result, launch the other independent ready tasks using runtime-supported background or concurrent native calls. `blockedBy` must represent only real prerequisites. Missing tools, consent or failure in one workstream must not park unrelated ready work. Keep permission/evidence gates, resource limits and shared-write conflicts intact; state the concrete reason when work must be serial. An unavailable reused actor cannot run two assignments simultaneously; launch other ready work instead. Inspect after actual returned results/reports and choose the next ready frontier work. When discoveries change the plan, use coordinator-only `mission.revise` with the current revision, a stable request identity, and a reason. Add newly visible frontier tasks without a replacement link, or use linked replacements to retire old work. Never overwrite earlier contracts or reports; rewrite affected dependencies explicitly.
7. Finish through `mission.report({ final: true, ... })` only when the objective is actually met. Retired work never counts as success and its admitted native execution keeps running until `mission.interrupt` stops it; playbook proof requirements still apply. A retired native task takes no coordinator readout; record what it returned under its replacement or in the final report. Admitted retired work settles through its actor's terminal report or an observed native end.

Use `mission.inspect({ catalog: true })` before selecting a native execution profile.
The mission `role` is independent of `execution.agent`. To pin execution, pass
`execution: { agent: "catalog-agent-id", model: { providerID: "catalog-provider", id: "catalog-model", variant: "optional-catalog-variant" } }`.
Repeat the same selection when retrying a task. Omitted fields use native defaults.
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

The map is a coordination protocol: never create speculative tasks, polling loops, nested coordinators, or publication automation.

Use only tools and fields exposed by the attached server; never emulate missing tools, fabricate bindings, or migrate real mission data. Business report envelope for coordinator native readouts or assigned independent-root actors: `mission.report({ missionID, taskKey, outcome: "completed", summary, evidence: [], next: [], artifact, final: false })`; use the playbook's role-specific artifact. A business readout settles the plan only: execution termination, invocation identity and human consent each need their own evidence.
