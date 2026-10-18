import { MissionControlError } from "./control-error"

// Only fixed, non-sensitive recovery and coordinator-action failures may cross the desktop bridge.
// Never pass native messages, request bodies or environment errors through it.
const errors = {
  "recovery-busy": { status: 409, message: "Native work or a wait prevents targeted recovery" },
  "recovery-unknown": { status: 503, message: "Native activity is unknown; recovery was not admitted" },
  "recovery-conflict": { status: 409, message: "Mission changed; reload before targeted recovery" },
  "task-sessions-unavailable": { status: 409, message: "Only native tasks launched by the coordinator have observable conversations" },
  "task-not-retired": { status: 409, message: "Retire the task with mission.revise before stopping its work" },
  "task-reused": { status: 409, message: "An open task continues this task's conversation; retire that task first" },
  "prepare-refused": { status: 409, message: "The mission could not be prepared; nothing was created" },
  "prepare-conflict": { status: 409, message: "This requestID already prepared a different mission" },
  "prepare-uncertain": { status: 409, message: "The prepared mission's outcome is uncertain; retry with the same requestID" },
} as const

export function missionRecoveryError(code: unknown): { code: string; status: number; message: string } | undefined {
  if (typeof code !== "string" || !Object.prototype.hasOwnProperty.call(errors, code)) return
  return { code, ...errors[code as keyof typeof errors] }
}

export function missionRecoveryRejection(error: unknown) {
  return error instanceof MissionControlError ? missionRecoveryError(error.code) : undefined
}
