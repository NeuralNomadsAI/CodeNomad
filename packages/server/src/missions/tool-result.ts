import type { MissionMap, MissionTask } from "./model"
import { WAYFINDER_DECISION_REQUIREMENT, buildAssignmentPrompt } from "./recipes"

/** Bounded task view for model-facing mission_* results; mission.inspect keeps the full map. */
export function compactMissionTask(task: MissionTask) {
  return {
    key: task.key, title: task.title, role: task.role, status: task.status,
    ...(task.contractGeneration === undefined ? {} : { contractGeneration: task.contractGeneration }),
    blockedBy: task.blockedBy,
    ...(task.replacesTaskKey === undefined ? {} : { replacesTaskKey: task.replacesTaskKey }),
    ...(task.replacedByTaskKey === undefined ? {} : { replacedByTaskKey: task.replacedByTaskKey }),
    ...(task.actorSessionId === undefined ? {} : { actorSessionId: task.actorSessionId }),
    ...(task.report ? { reportOutcome: task.report.outcome } : {}),
    ...(task.outstandingExecution ? { outstandingExecution: true } : {}),
  }
}

/** What a coordinator acts on next: the current revision and frontier. Callers add the affected tasks. */
export function compactMission(mission: MissionMap) {
  return {
    missionID: mission.id, revision: mission.revision, status: mission.status,
    ...(mission.runState === undefined ? {} : { runState: mission.runState }),
    frontier: mission.frontier,
  }
}

export function compactMissionTasks(mission: MissionMap, taskKeys: readonly string[]) {
  return mission.tasks.filter(task => taskKeys.includes(task.key)).map(compactMissionTask)
}

/** The exact current canonical prompt of a live native task; withdrawn work is never relaunched. */
export function nativeAssignment(mission: MissionMap, task: MissionTask) {
  if (task.executionMode?.kind !== "native" || task.status === "withdrawn" || !Number.isSafeInteger(task.contractGeneration)) return {}
  return {
    contract: { missionID: mission.id, taskKey: task.key, generation: task.contractGeneration! },
    assignmentPrompt: buildAssignmentPrompt(mission, task),
    ...(mission.template === "wayfinder" && task.role === "decision" ? { requirement: WAYFINDER_DECISION_REQUIREMENT } : {}),
  }
}
