import { MissionControlError } from "./control-error"
import type { MissionSessionAdapter } from "./control-types"
import { stableToken } from "./journal"
import { missionIsRunning } from "./lifecycle-model"
import type { MissionMap } from "./model"
import { missionTaskExecutionEvidence } from "./execution-evidence"

export interface MissionRecoveryInput {
  missionID: string
  expectedRevision: number
  target: "coordinator" | "report"
  taskKey?: string
}

// A recovery is not another assignment. One native input identity per observed
// plan revision prevents repeated clicks/reconnects from duplicating the nudge.
export function missionRecoveryInput(mission: MissionMap, request: MissionRecoveryInput): Parameters<MissionSessionAdapter["synthetic"]>[0] {
  if (mission.id !== request.missionID) throw new MissionControlError("Mission not found", "mission-not-found")
  if (!missionIsRunning(mission)) throw new MissionControlError("Mission is not running", "mission-not-running")
  if (mission.control?.pending.length) throw new MissionControlError("Native mission control is pending", "control-pending")
  if (mission.revision !== request.expectedRevision) throw new MissionControlError("Mission changed; reload before recovery", "revision-conflict")
  let sessionID = mission.coordinatorSessionId
  if (request.target === "report") {
    const task = mission.tasks.find(task => task.key === request.taskKey)
    const evidence = task && missionTaskExecutionEvidence(task)
    if (evidence) {
      if (evidence.nativeCall === "active") throw new MissionControlError("Native invocation has not ended; recovery was not admitted", "recovery-busy")
      if (evidence.nativeCall === "unknown") throw new MissionControlError("Native invocation evidence is unknown; recovery was not admitted", "recovery-unknown")
    }
    if (!task?.actorSessionId || !evidence?.missingReport) {
      throw new MissionControlError("No outstanding report for this task", "recovery-conflict")
    }
    sessionID = task.actorSessionId
  } else if (request.taskKey !== undefined || request.target !== "coordinator") {
    throw new MissionControlError("Invalid recovery target", "recovery-conflict")
  }
  if (!mission.actors.some(actor => actor.sessionId === sessionID)) throw new MissionControlError("Missing recovery actor", "foreign-session")
  const correlation = `${mission.id}\0${mission.revision}\0${request.target}\0${request.taskKey ?? ""}`
  return {
    sessionID, id: `msg_${stableToken(`recovery\0${correlation}`, 28)}`,
    text: request.target === "report"
      ? `Recover the missing report for task ${request.taskKey} in existing mission ${mission.id}. Inspect the saved mission map and your transcript/tool results first. Record the existing result through mission.report, or report a concrete blocker if the evidence is incomplete. This is not a new assignment: do not rerun completed work, restart validation, or create a replacement task or mission.`
      : `Recover coordination of existing mission ${mission.id}. Inspect its saved map and reports, and use existing results to decide the next step or produce the terminal conclusion when justified. This is not permission to replay assignments, restart validation, or create a replacement mission. Respect unresolved gates, paused/stopped work, permissions and human decisions.`,
    description: "CodeNomad targeted mission recovery",
    metadata: { "codenomad.mission": { version: 1, missionID: mission.id, kind: "recovery", target: request.target,
      revision: mission.revision, ...(request.taskKey === undefined ? {} : { taskKey: request.taskKey }) } },
    delivery: "queue", resume: true,
  }
}
