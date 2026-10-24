import type { MissionNativeBinding, MissionTask } from "./model"

type TaskEvidence = Pick<MissionTask, "status" | "actorSessionId" | "admissionId" | "nativeBinding" | "nativeExecution"
  | "report" | "lateReports" | "outstandingExecution" | "contractGeneration">

const identity = (value: string) => typeof value === "string" && value.trim().length > 0
const validBinding = (binding: MissionNativeBinding) => Boolean(binding) && Number.isSafeInteger(binding.generation) && binding.generation > 0
  && identity(binding.parentSessionID) && identity(binding.parentMessageID) && identity(binding.toolCallID)

/** Business/native evidence only, never native idle, lifecycle or send authority.
 * The original binding (including nativeReturned) describes a historical call;
 * only nativeExecution describes the current invocation, including continuations. */
export function missionTaskExecutionEvidence(task: TaskEvidence): {
  hasExecution: boolean
  nativeCall: "none" | "active" | "ended" | "unknown"
  missingReport: boolean
} {
  const original = task.nativeBinding
  const current = task.nativeExecution
  let nativeCall: "none" | "active" | "ended" | "unknown" = "none"
  if (original || current) {
    nativeCall = "unknown"
    if (original && current && validBinding(original) && validBinding(current.binding)
      && (task.contractGeneration === undefined || task.contractGeneration === original.generation)
      && current.binding.generation === original.generation && current.binding.parentSessionID === original.parentSessionID
      // Initial invocation retains both IDs; a continuation must change both.
      && (current.binding.toolCallID === original.toolCallID) === (current.binding.parentMessageID === original.parentMessageID)) {
      nativeCall = current.observationConflict || (current.launch && current.launch.mode !== "foreground") ? "unknown"
        : current.ended === undefined ? "active"
        : current.ended === "returned" || current.ended === "error" ? "ended" : "unknown"
    }
  }
  const hasExecution = Boolean(task.actorSessionId && (task.outstandingExecution
    || (task.admissionId && identity(task.admissionId)) || (original && validBinding(original))))
  const missingReport = hasExecution && !task.report && !task.lateReports?.length
    && (task.status === "queued" || task.status === "dispatching" || task.outstandingExecution)
  return { hasExecution, nativeCall, missingReport }
}
