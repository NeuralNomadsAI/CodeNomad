import { reportAdmissionID } from "./receipt-identity"
import { buildAssignmentPrompt } from "./recipes"
import type { MissionMap, MissionReport, MissionTask } from "./model"
import type { MissionSessionAdapter } from "./control-types"

export function assignmentInput(mission: MissionMap, task: MissionTask): Parameters<MissionSessionAdapter["prompt"]>[0] {
  if (!task.actorSessionId || !task.admissionId || !task.delivery) throw new Error("Incomplete mission dispatch")
  return {
    sessionID: task.actorSessionId, id: task.admissionId, text: buildAssignmentPrompt(mission, task),
    metadata: { "codenomad.mission": { version: 1, missionID: mission.id, kind: "assignment", taskKey: task.key, role: task.role } },
    delivery: task.delivery, resume: true,
  }
}

export function reportInput(mission: MissionMap, report: MissionReport): Parameters<MissionSessionAdapter["synthetic"]>[0] {
  return {
    sessionID: mission.coordinatorSessionId, id: reportAdmissionID(report.id),
    text: `${report.late ? "Late report for retired work" : "Mission report received"} for “${report.taskKey}” from ${report.sessionId}. Outcome: ${report.outcome}.\n\n${report.summary}`,
    description: report.late ? "Late CodeNomad mission report" : "CodeNomad mission report",
    metadata: { "codenomad.mission": { version: 1, missionID: mission.id, kind: "report", taskKey: report.taskKey,
      reportID: report.id, fromSessionID: report.sessionId } },
    delivery: "queue", resume: true,
  }
}
