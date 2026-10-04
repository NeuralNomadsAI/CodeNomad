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
5. Actors must call `mission.report`. Reports are delivered back to the coordinator through the native durable inbox and resume it when possible.
6. Inspect after reports and choose the next frontier task. When discoveries change the plan, use coordinator-only `mission.revise` with the current revision, a stable request identity, and a reason. Add newly visible frontier tasks without a replacement link, or use linked replacements to retire old work. Never overwrite historical contracts or reports; rewrite affected dependencies explicitly.
7. Finish through `mission.report({ final: true, ... })` only when the objective is actually met. Retiring work does not abort its native admission or count as success: admitted retired work still needs a terminal report, and playbook proof requirements still apply.

Use `mission.inspect({ catalog: true })` before selecting a native execution profile.
The mission `role` is independent of `execution.agent`. To pin execution, pass
`execution: { agent: "catalog-agent-id", model: { providerID: "catalog-provider", id: "catalog-model", variant: "optional-catalog-variant" } }`.
Repeat the same selection when retrying a task. Omitted fields use native defaults.
Explicit native tasks accept subagent/all agents; independent roots and historical
no-mode tasks accept primary/all agents. Ordinary native helpers inherit the nearest
task's context, not coordinator topology authority or task-report privileges; they
return to their parent instead of calling `mission.report`. Reused actors must already match the selection;
Missions will not switch the model of a busy session. Native queues do not freeze
model or environment state against subsequent changes from another client.

The map is a coordination protocol, not a hidden executor. Do not create speculative tasks, polling loops, nested coordinators, or publication automation.

Use only tools and fields exposed by the attached server. The native-first task contract is experimental until declaration/binding/admission authority is assembled and validated; do not emulate missing tools, fabricate bindings, or migrate real mission data. Current report envelope: `mission.report({ missionID, taskKey, outcome: "completed", summary, evidence: [], next: [], artifact, final: false })`; use the playbook's role-specific artifact.
