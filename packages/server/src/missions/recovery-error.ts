import { MissionControlError } from "./control-error"

// Only fixed, non-sensitive recovery failures may cross the desktop bridge.
// Never pass native messages, request bodies or environment errors through it.
const errors = {
  "recovery-busy": { status: 409, message: "Native work or a wait prevents targeted recovery" },
  "recovery-unknown": { status: 503, message: "Native activity is unknown; recovery was not admitted" },
  "recovery-conflict": { status: 409, message: "Mission changed; reload before targeted recovery" },
} as const

export function missionRecoveryError(code: unknown): { code: string; status: number; message: string } | undefined {
  if (typeof code !== "string" || !Object.prototype.hasOwnProperty.call(errors, code)) return
  return { code, ...errors[code as keyof typeof errors] }
}

export function missionRecoveryRejection(error: unknown) {
  return error instanceof MissionControlError ? missionRecoveryError(error.code) : undefined
}
