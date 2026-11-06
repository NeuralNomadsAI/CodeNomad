import { MissionControlError } from "./control-error"

export const MISSION_DEFAULTS_REQUEST_INVALID = "Correct the profile-defaults request: use a supported template, valid profiles and taskMode, and a complete coordinatorModel"

// Only fixed, non-sensitive recovery and coordinator-action failures may cross the desktop bridge.
// Never pass native messages, request bodies or environment errors through it.
const errors = {
  "invalid-execution": { status: 409, message: "Correct the mission command, profiles or taskMode" },
  "recovery-busy": { status: 409, message: "Native work or a wait prevents targeted recovery" },
  "recovery-unknown": { status: 503, message: "Native activity is unknown; recovery was not admitted" },
  "recovery-conflict": { status: 409, message: "Mission changed; reload before targeted recovery" },
  "task-sessions-unavailable": { status: 409, message: "Only native tasks launched by the coordinator have observable conversations" },
  "task-not-retired": { status: 409, message: "Retire the task with mission.revise before stopping its work" },
  "task-reused": { status: 409, message: "An open task continues this task's conversation; retire that task first" },
  "prepare-refused": { status: 409, message: "The mission could not be prepared; nothing was created" },
  "prepare-no-effect": { status: 409, message: "The preparation request was refused without effects; correct the request and retry" },
  "prepare-conflict": { status: 409, message: "This requestID already prepared a different mission" },
  "prepare-uncertain": { status: 409, message: "The prepared mission's outcome is uncertain; retry with the same requestID" },
  "mission-preferences-invalid": { status: 409, message: "Correct the Missions preferences before creating a mission" },
  "mission-preferences-unavailable": { status: 503, message: "Reload or correct the Missions preferences before creating a mission" },
  "mission-preferences-update-required": { status: 503, message: "Update CodeNomad before using Missions preferences" },
  "compare-models-required": { status: 409, message: "Choose model-a and model-b profiles with explicit models before creating a Compare mission" },
  "compare-models-identical": { status: 409, message: "Choose different models for the model-a and model-b profiles before creating a Compare mission" },
} as const

export function missionRecoveryError(code: unknown, message?: unknown): { code: keyof typeof errors; status: number; message: string } | undefined {
  if (typeof code !== "string" || !Object.prototype.hasOwnProperty.call(errors, code)) return
  const key = code as keyof typeof errors
  return { code: key, ...errors[key], ...(key === "invalid-execution" && message === MISSION_DEFAULTS_REQUEST_INVALID ? { message } : {}) }
}

export function missionRecoveryControlError(code: keyof typeof errors, message?: unknown): MissionControlError {
  const failure = missionRecoveryError(code, message)!
  return new MissionControlError(failure.message, failure.code)
}

export function missionRecoveryRejection(error: unknown) {
  return error instanceof MissionControlError ? missionRecoveryError(error.code, error.message) : undefined
}
