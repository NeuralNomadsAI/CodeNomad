import { isDeepStrictEqual } from "node:util"
import { MissionControlError } from "./control-error"
import type { MissionReportInput } from "./control-types"
import { validateMissionReportArtifact } from "./contracts"
import { stableToken } from "./journal"
import { missionIsRunning } from "./lifecycle-model"
import type { MissionMap, MissionReport, MissionSnapshot, MissionTask } from "./model"
import type { HumanDecisionMark } from "./human-answer"

/** Coordinator-authored business evidence, not a receipt from native execution. */
export function coordinatorReadout(snapshot: MissionSnapshot, mission: MissionMap, task: MissionTask,
  input: MissionReportInput, createdAt: number, humanReceipt?: HumanDecisionMark): { report: MissionReport; existing: boolean } {
  if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.cleanupUnavailable) {
    throw new MissionControlError("Damaged Mission journal cannot authorize coordinator readout", "invalid-journal")
  }
  if (!missionIsRunning(mission)) throw new MissionControlError("Mission is not running", "mission-not-running")
  if (mission.control?.pending.length) throw new MissionControlError("Native mission control is pending", "control-pending")
  if (task.status === "withdrawn") throw new MissionControlError("Task was withdrawn", "task-withdrawn")
  if (task.blockedBy.some(key => mission.tasks.find(dependency => dependency.key === key)?.status !== "completed")) {
    throw new MissionControlError("Readout requires completed prerequisite tasks", "invalid-blocker")
  }
  // Preserve the stronger human-consent gate; a coordinator summary is not Form proof.
  if (mission.template === "wayfinder" && task.role === "decision" && input.outcome === "completed") {
    if (!humanReceipt || humanReceipt.via !== "ui" || humanReceipt.sessionID !== task.actorSessionId)
      throw new MissionControlError("Durable native human-decision evidence unavailable", "policy-unqualified")
  }
  let artifact
  try { artifact = validateMissionReportArtifact({ template: mission.template, role: task.role,
    outcome: input.outcome, artifact: input.artifact }) }
  catch (error) { throw new MissionControlError(error instanceof Error ? error.message : "Mission report contract failed", "invalid-report-contract") }
  if (task.report) {
    const previous = task.report
    if (previous.delivery !== "coordinator-readout" || previous.outcome !== input.outcome || previous.summary !== input.summary
      || !isDeepStrictEqual(previous.evidence, input.evidence) || !isDeepStrictEqual(previous.next, input.next)
      || !isDeepStrictEqual(previous.artifact, artifact)) {
      throw new MissionControlError("Task already has different immutable business evidence", "request-conflict")
    }
    return { report: previous, existing: true }
  }
  return { existing: false, report: {
    id: `rpt_${stableToken(`${mission.id}\0${task.key}\0coordinator-readout`, 24)}`,
    taskKey: task.key, sessionId: mission.coordinatorSessionId, outcome: input.outcome,
    summary: input.summary, evidence: input.evidence, next: input.next, artifact,
    delivery: "coordinator-readout", createdAt,
  } }
}
