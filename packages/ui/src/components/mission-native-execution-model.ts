import type { MissionActorActivity, MissionMap, MissionReport, MissionTask } from "../../../server/src/api-types"
import { missionTaskExecutionEvidence } from "../../../server/src/missions/execution-evidence"

export type MissionNativeTask = Pick<MissionTask, "status" | "executionMode" | "contractGeneration" | "nativeBinding" | "nativeExecution" | "actorSessionId" | "admissionId" | "report" | "lateReports" | "outstandingExecution">

/** Display only: a native return is neither a terminal session nor a business report. */
export function missionTaskStatusKey(task: MissionNativeTask): string {
  if (task.status === "withdrawn") return "missions.control.task.status.superseded"
  if (task.status === "ready" && task.executionMode?.kind === "native" && !task.nativeBinding) return "missions.control.native.planned"
  if (task.status === "queued" && task.nativeBinding) return "missions.control.native.bound"
  return `missions.control.task.status.${task.status}`
}

export function hasUnreturnedNativeInvocation(task: MissionNativeTask): boolean {
  return missionTaskExecutionEvidence(task).nativeCall === "active"
}

export function missionNativeCallKey(task: MissionNativeTask): string {
  const observed = missionTaskExecutionEvidence(task).nativeCall
  return observed === "active" ? "missions.control.native.call.unreturned"
    : observed === "ended" ? `missions.control.native.call.${task.nativeExecution!.ended}` : "missions.control.execution.unknown"
}

export function missionActivityKey(activity: MissionActorActivity["state"] | undefined, native: boolean): string {
  return activity === "queued" && native ? "missions.control.native.activityQueued" : `missions.control.activity.state.${activity ?? "unknown"}`
}

/** UI preflight only; the backend still verifies live activity, identity and ownership. */
export function canRecoverMissionReport(task: MissionNativeTask | undefined, activity?: MissionActorActivity["state"]): boolean {
  if (!task?.actorSessionId || task.report || task.lateReports?.length) return false
  const evidence = missionTaskExecutionEvidence(task)
  if (!evidence.missingReport) return false
  if (task.nativeBinding || task.nativeExecution || task.executionMode?.kind === "native") {
    return activity === "idle-without-report" && evidence.nativeCall === "ended"
      && !task.outstandingExecution
      && task.nativeExecution?.binding.generation === task.contractGeneration
  }
  return Boolean(task.admissionId) && (task.status !== "withdrawn" || task.outstandingExecution)
    && (!activity || activity === "unknown" || activity === "idle-without-report")
}

export type MissionReportDelivery = Pick<MissionReport, "notificationStatus" | "delivery">

export function missionReportNotificationKey(report: MissionReportDelivery): string | undefined {
  if (report.delivery === "coordinator-readout") return undefined
  if (report.delivery === "native-return" && report.notificationStatus === "pending") return "missions.control.report.notification.nativeReturnPending"
  return `missions.control.report.notification.${report.notificationStatus ?? "unknown"}`
}

/** The latest Pause/Stop could not confirm that every native sub-agent stopped
 * (incomplete inventory or a session still observed active). Older receipts
 * without a family summary claim nothing either way. */
export function partialInterrupt(mission: Pick<MissionMap, "control">): boolean {
  const control = mission.control
  if (!control || control.action === "start") return false
  return Boolean(control.receipts?.some(receipt => receipt.nativeAcknowledgement?.disposition === "interrupt-observed"
    && receipt.nativeAcknowledgement.descendants?.complete === false))
}
