---
name: codenomad-missions
description: Coordinate bounded native tasks through the CodeNomad mission map, with explicit independent-root exceptions.
---

# CodeNomad Missions

Prefer ordinary native delegation for bounded work. Use a mission only when the user needs a durable shared task map, evidence gates, and explicit coordinator decisions; a mission is not required for an ordinary helper.

1. Call `mission.inspect` with `start.objective` and one template: `custom`, `pocock-fix-bug`, or `wayfinder`.
2. Read the returned playbook. The starting session is the coordinator and is the only session allowed to call `mission.delegate`.
3. Give every task a stable lowercase `taskKey`. Declare its role, real `blockedBy` dependencies, and execution mode separately from execution. Native is the default for new declarations; blocked declarations do not dispatch or require completed prerequisite reports yet.
4. Prefer native child execution. Use an independent root only for a concrete `location`, `lifetime`, `existing-root`, or `playbook` reason and explanation. Native continuation names the exact dependency-connected `reuseFromTaskKey`, never an arbitrary root or a guessed session. Admission must prove the exact current native execution ended/returned and the actual bound session is idle; a report alone proves neither. Historical tasks without an execution mode retain their root-only behavior: omit `targetSessionID` to create a root, or supply a same-project root to reuse it. Do not automatically convert them.
5. For a native declaration, pass its canonical `assignmentPrompt` to an ordinary native subagent call only when the task is ready, preserving the declared execution profile and native continuation checks. Native children return actual evidence and required role artifacts through ordinary native results; the coordinator records each declared task's business readout with `mission.report`, `taskKey`, and no `contract`. Do not ask native children for duplicate reports or forward generations/bindings to helpers. Independent-root actors still call `mission.report`; their reports use the durable inbox to notify the coordinator.
6. Run independent ready frontier tasks in parallel when useful; `blockedBy` must represent real prerequisites, not an artificial sequence. Inspect after returned results/reports and choose the next ready frontier work. When discoveries change the plan, use coordinator-only `mission.revise` with the current revision, a stable request identity, and a reason. Add newly visible frontier tasks without a replacement link, or use linked replacements to retire old work. Never overwrite historical contracts or reports; rewrite affected dependencies explicitly.
7. Finish through `mission.report({ final: true, ... })` only when the objective is actually met. Retiring work does not abort its native admission or count as success: admitted retired work still needs a terminal report, and playbook proof requirements still apply.

Use `mission.inspect({ catalog: true })` before selecting a native execution profile.
The mission `role` is independent of `execution.agent`. To pin execution, pass
`execution: { agent: "catalog-agent-id", model: { providerID: "catalog-provider", id: "catalog-model", variant: "optional-catalog-variant" } }`.
Repeat the same selection when retrying a task. Omitted fields use native defaults.
Explicit native tasks accept subagent/all agents; independent roots and historical
no-mode tasks accept primary/all agents. Each child owns its bounded assignment and
may recursively decompose independent subtasks when useful, integrating actual returned
evidence before returning to its immediate parent. Pass relevant scope, role constraints,
safety boundaries and this delegation policy to each helper; Missions does not automatically
propagate context. Helpers gain neither coordinator topology authority nor task-report
privileges and return to their parent instead of calling `mission.report`. Respect native
permissions and the user's configured runtime depth; do not change configuration, force
delegation levels, or turn a denied/depth-limited helper into an undeclared independent root.
At a native limit, finish within scope or return the limitation. Avoid conflicting edits
and shared mutable checks; a background launch is not completion. Reused actors must already match the selection;
Missions will not switch the model of a busy session. Native queues do not freeze
model or environment state against subsequent changes from another client.

The map is a coordination protocol, not a hidden executor. Do not create speculative tasks, polling loops, nested coordinators, or publication automation.

Use only tools and fields exposed by the attached server. The native-first task contract is experimental until declaration/binding/admission authority is assembled and validated; do not emulate missing tools, fabricate bindings, or migrate real mission data. Business report envelope for coordinator native readouts or assigned independent-root actors: `mission.report({ missionID, taskKey, outcome: "completed", summary, evidence: [], next: [], artifact, final: false })`; use the playbook's role-specific artifact. Business readout proves neither execution termination nor historical invocation identity or human consent.
