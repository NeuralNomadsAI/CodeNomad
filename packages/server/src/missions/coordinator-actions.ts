import { z } from "zod"
import type { MissionMap } from "./model"

/** Bridge replies are revalidated before they reach a model: bounded and credential-free. */
const sessionID = z.string().min(1).max(240)

export const taskObservationSchema = z.object({
  sessions: z.array(z.object({ sessionID, active: z.boolean() }).strict()).max(200),
  complete: z.boolean(),
}).strict()
export type MissionTaskObservation = z.infer<typeof taskObservationSchema>

const descendants = z.object({ observed: z.number().int().nonnegative(), interrupted: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(), unconfirmed: z.number().int().nonnegative(), complete: z.boolean(),
  sessions: z.array(sessionID).max(64) }).strict()
export const taskInterruptionSchema = z.object({
  sessions: z.array(z.object({ sessionID, interrupted: z.boolean(), settled: z.boolean(), descendants }).strict()).max(200),
  complete: z.boolean(),
}).strict()
export type MissionTaskInterruption = z.infer<typeof taskInterruptionSchema>

/** Missions a session may read: those it belongs to, and hand-offs it prepared (read-only). */
export function missionRelation(mission: MissionMap, sessionID: string): "member" | "prepared" | undefined {
  if (mission.actors.some(actor => actor.sessionId === sessionID)) return "member"
  if (mission.preparedBy?.coordinatorSessionId === sessionID) return "prepared"
  return undefined
}

export function missionListEntry(mission: MissionMap, relation: "member" | "prepared") {
  return {
    missionID: mission.id, ...(mission.title === undefined ? {} : { title: mission.title }), relation,
    template: mission.template, status: mission.status, ...(mission.runState === undefined ? {} : { runState: mission.runState }),
    revision: mission.revision, createdAt: mission.createdAt, ...(mission.summary === undefined ? {} : { summary: mission.summary }),
  }
}
