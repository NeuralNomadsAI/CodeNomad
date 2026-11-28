import type { MissionMap } from "./model"
import { controlOperationID, stableToken } from "./receipt-identity"
import { z } from "zod"

export type CreationAcknowledgement<T> = { acknowledgement: "fresh" | "recovered"; value: T }
export type PreparationTarget = { kind: "one-time"; mission: MissionMap }
export type PreparationResult =
  | { outcome: "prepared" | "activated"; acknowledgement: "fresh" | "recovered"; target: PreparationTarget }
  | { outcome: "refused"; phase: "creation" | "activation" | "start"; code: string; target?: PreparationTarget }
  | { outcome: "uncertain"; phase: "creation" | "activation" | "start"; requestID: string; missionID: string; target?: PreparationTarget }

export const automaticMissionStartID = (creationRequestID: string) => `start_${stableToken(`creation\0${creationRequestID}`, 24)}`

/** Rebuild model-facing headers from bounded known fields; the native map is read
 * independently by the owner instead of forwarding a backend's arbitrary body. */
export function preparationResult(input: unknown, mission: MissionMap, creationRequestID: string): PreparationResult {
  return validatedPreparationResult(input, { kind: "one-time", mission }, mission.id, creationRequestID)
}

function validatedPreparationResult(input: unknown, target: PreparationTarget, missionID: string, creationRequestID: string): PreparationResult {
  const value = z.object({ outcome: z.enum(["prepared", "activated", "refused", "uncertain"]),
    acknowledgement: z.enum(["fresh", "recovered"]).optional(), phase: z.enum(["creation", "activation", "start"]).optional(),
    code: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(), requestID: z.string().min(1).max(128).optional(),
    missionID: z.string().min(1).max(100).optional() }).parse(input)
  if ((value.outcome === "prepared" || value.outcome === "activated") && value.acknowledgement)
    return { outcome: value.outcome, acknowledgement: value.acknowledgement, target }
  if (value.outcome === "refused" && value.phase && value.code)
    return { outcome: "refused", phase: value.phase, code: value.code, target }
  if (value.outcome === "uncertain" && value.phase && value.missionID === missionID
    && (value.requestID === creationRequestID || value.requestID === automaticMissionStartID(creationRequestID)))
    return { outcome: "uncertain", phase: value.phase, requestID: value.requestID, missionID, target }
  throw new Error("Invalid Mission preparation acknowledgement")
}

/** Original first-Play proof only: later controls never change this receipt. */
export function recoveredPreparation(mission: MissionMap): PreparationResult {
  const target = { kind: "one-time" as const, mission }
  const automatic = mission.document?.automaticStart
  if (!automatic?.attempted) return { outcome: "prepared", acknowledgement: "recovered", target }
  const play = mission.document?.firstPlay
  if (play?.requestID === automatic.requestID && play.operationID === controlOperationID(mission.id, automatic.requestID)
    && play.admittedAt !== null) return { outcome: "activated", acknowledgement: "recovered", target }
  return { outcome: "uncertain", phase: "start", requestID: automatic.requestID, missionID: mission.id, target }
}
