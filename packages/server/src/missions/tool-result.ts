import type { MissionMap, MissionTask } from "./model"
import { WAYFINDER_DECISION_REQUIREMENT, buildAssignmentPrompt } from "./recipes"
import { decisionQuestionTag } from "./decision-question-tag"
import { boundedResult, contentText, withinInspectBound } from "./inspect-view"
import type { MissionTaskInterruption } from "./coordinator-actions"

const REVISION_PAGE_NOTE = "This revision affected more tasks than one result holds: the first `returned`, in map order, are listed."
  + " Read any other with mission.inspect({ taskKey }) or the map's task pages."

/** A mission_* mutation result within `MISSION_INSPECT_OUTPUT_LIMIT`: its frontier and
 * a task's assignment prompt give way, largest first, to `{ omittedCharacters, read }`
 * naming their exact mission.inspect read (a prompt is read whole before it is passed). */
export function boundedMutation<T extends Record<string, unknown>>(result: T, mission: MissionMap): T {
  const taskKey = (result.task as { key?: unknown } | undefined)?.key
  return boundedResult(result, mission, [
    ...("frontier" in result ? [{ key: "frontier" as const, selector: { kind: "mission" as const, field: "frontier" } }] : []),
    ...(typeof result.assignmentPrompt === "string" && typeof taskKey === "string"
      ? [{ key: "assignmentPrompt" as const, selector: { kind: "task" as const, taskKey, field: "assignmentPrompt" } }] : []),
  ])
}

const RECEIPT_NOTE = "This interruption's receipt is larger than one result: descendant session IDs are left out of each conversation's outcome"
  + " (their counts stay), and `sessionPage` counts conversations left out. Read the whole original receipt with mission.inspect(receipt.read)."

/** A mission.interrupt result within `MISSION_INSPECT_OUTPUT_LIMIT`. A receipt that fits
 * is returned whole. A larger one keeps `complete`, any note, the totals and each
 * conversation's outcome with its descendant counts (their session IDs left out), in
 * receipt order, as many as fit, and names in `receipt` the exact read of the whole
 * original receipt, which `hold` keeps for mission.inspect and identifies by digest. */
export function boundedInterruption(result: MissionTaskInterruption & { note?: string }, hold: (receipt: typeof result) => string) {
  if (withinInspectBound(result)) return result
  const text = contentText(result)
  const receipt = { omittedCharacters: text.length, read: { content: { kind: "receipt" as const, digest: hold(result), offset: 0 } } }
  const outcomes = result.sessions.map(({ descendants: { sessions: _sessions, ...counts }, ...outcome }) => ({ ...outcome, descendants: counts }))
  const sum = (count: (outcome: typeof outcomes[number]) => number) => outcomes.reduce((total, outcome) => total + count(outcome), 0)
  const totals = { conversations: outcomes.length, interrupted: sum(item => Number(item.interrupted)), settled: sum(item => Number(item.settled)),
    descendants: { observed: sum(item => item.descendants.observed), interrupted: sum(item => item.descendants.interrupted),
      cancelled: sum(item => item.descendants.cancelled), unconfirmed: sum(item => item.descendants.unconfirmed),
      complete: outcomes.every(item => item.descendants.complete) } }
  const page = (count: number) => ({ complete: result.complete, ...(result.note === undefined ? {} : { note: result.note }), totals,
    sessions: outcomes.slice(0, count), ...(count < outcomes.length ? { sessionPage: { returned: count, total: outcomes.length } } : {}),
    receipt, detail: RECEIPT_NOTE })
  let low = 0, high = outcomes.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (withinInspectBound(page(middle))) low = middle
    else high = middle - 1
  }
  return page(low)
}

/** A revision's result: the compact mission and its affected tasks in map order, as
 * many as a bounded result holds; `taskPage` counts them when some are left out. */
export function boundedRevision(mission: MissionMap, taskKeys: readonly string[]) {
  const tasks = compactMissionTasks(mission, taskKeys)
  const page = (count: number) => ({ ...compactMission(mission), tasks: tasks.slice(0, count),
    ...(count < tasks.length ? { taskPage: { returned: count, total: tasks.length, note: REVISION_PAGE_NOTE } } : {}) })
  const fitted = (count: number) => { try { return boundedMutation(page(count), mission) } catch { return undefined } }
  const whole = fitted(tasks.length)
  if (whole) return whole
  let low = 0, high = tasks.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fitted(middle)) low = middle
    else high = middle - 1
  }
  return boundedMutation(page(low), mission)
}

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
export function compactMission(mission: Pick<MissionMap, "id" | "revision" | "status" | "runState" | "frontier">) {
  return {
    missionID: mission.id, revision: mission.revision, status: mission.status,
    ...(mission.runState === undefined ? {} : { runState: mission.runState }),
    frontier: mission.frontier,
  }
}

export function compactMissionTasks(mission: Pick<MissionMap, "tasks">, taskKeys: readonly string[]) {
  return mission.tasks.filter(task => taskKeys.includes(task.key)).map(compactMissionTask)
}

/** The exact current canonical prompt of a live native task; withdrawn work is never relaunched. */
export function nativeAssignment(mission: Pick<MissionMap, "id" | "template" | "taskMode" | "objective">, task: MissionTask) {
  if (task.executionMode?.kind !== "native" || task.status === "withdrawn" || !Number.isSafeInteger(task.contractGeneration)) return {}
  return {
    contract: { missionID: mission.id, taskKey: task.key, generation: task.contractGeneration! },
    assignmentPrompt: buildAssignmentPrompt(mission, task),
    ...(mission.template === "wayfinder" && task.role === "decision"
      ? { requirement: WAYFINDER_DECISION_REQUIREMENT, questionTag: decisionQuestionTag(mission.id, task.key) } : {}),
  }
}
