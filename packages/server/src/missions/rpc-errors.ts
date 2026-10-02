// Expected lifecycle failures must cross native RPC as declared errors. Ordinary
// exceptions are deliberately opaque rpc.internal failures in OpenCode.
export const MISSION_RPC_REJECTION = "mission.rejected"

const statuses = {
  "control-pending": 503,
  "control-conflict": 409,
  "mission-not-running": 409,
  "invalid-delete-option": 400,
  "cleanup-pending": 503,
  "revision-conflict": 409,
  "request-conflict": 409,
  "already-member": 409,
  "mission-finished": 409,
  "mission-limit": 409,
  "mission-not-found": 404,
  "mission-deleted": 404,
  "session-not-found": 404,
  "foreign-session": 403,
  "child-session": 403,
} as const

export const missionMutationErrors = {
  [MISSION_RPC_REJECTION]: {
    type: "object",
    properties: { code: { type: "string", enum: Object.keys(statuses) } },
    required: ["code"],
    additionalProperties: false,
  },
} as const

export function missionMutationStatus(code: unknown): number | undefined {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(statuses, code)
    ? statuses[code as keyof typeof statuses] : undefined
}

export function readMissionMutationError(error: unknown): { code: string; message: string; status: number } | undefined {
  if (!error || typeof error !== "object" || !("type" in error) || error.type !== MISSION_RPC_REJECTION
    || !("data" in error) || !error.data || typeof error.data !== "object"
    || !("code" in error.data) || typeof error.data.code !== "string"
    || !("message" in error) || typeof error.message !== "string") return
  const status = missionMutationStatus(error.data.code)
  if (status) return { code: error.data.code, message: error.message, status }
}
