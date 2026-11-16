import { z } from "zod"
import type { MissionMap, MissionSnapshot, MissionTask } from "./model"
import type { NativeMissionSession } from "./control-types"
import { MissionControlError } from "./control-error"
import { isReservedMissionScheduleSessionID } from "./mission-schedule-carrier-identity"

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

/** Open tasks whose native conversation lives in this task's conversation family: a
 * continuation (`reuseFromTaskKey`) runs in it and a nested task (`parentTaskKey`) is
 * launched under it, along chains through tasks of any status. Stopping that family
 * would stop their work too. */
export function liveContinuations(tasks: readonly MissionTask[], taskKey: string): string[] {
  const byKey = new Map(tasks.map(task => [task.key, task]))
  const edges = (task: MissionTask | undefined) => task?.executionMode?.kind !== "native" ? []
    : [task.executionMode.reuseFromTaskKey, task.executionMode.parentTaskKey].filter((key): key is string => typeof key === "string")
  const reaches = (task: MissionTask) => {
    const seen = new Set<string>(), queue = edges(task)
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index]
      if (key === taskKey) return true
      if (seen.has(key)) continue
      seen.add(key)
      queue.push(...edges(byKey.get(key)))
    }
    return false
  }
  return tasks.filter(task => task.key !== taskKey && !["withdrawn", "completed", "failed"].includes(task.status) && reaches(task)).map(task => task.key)
}

/** Missions a session may read: those it belongs to, and hand-offs it prepared (read-only). */
export function missionRelation(mission: MissionMap, sessionID: string): "member" | "prepared" | undefined {
  if (mission.actors.some(actor => actor.sessionId === sessionID)) return "member"
  if (mission.preparedBy?.coordinatorSessionId === sessionID) return "prepared"
  return undefined
}

/** Author admission shared by native tools and the authenticated backend. Session
 * metadata retains passage/actor provenance after its journal stops being active. */
export function missionPreparationSource(snapshot: MissionSnapshot, session: NativeMissionSession): MissionMap | undefined {
  const refuse = (): never => { throw new MissionControlError("This session cannot prepare a separate mission", "prepare-refused") }
  if (session.parentID || session.projectID !== snapshot.projectID || snapshot.discardedEvents
    || snapshot.controlUnavailable || isReservedMissionScheduleSessionID(session.id)) return refuse()
  const marker = session.metadata?.["codenomad.mission"]
  if (marker !== undefined) {
    if (!marker || typeof marker !== "object" || Array.isArray(marker)
      || marker.recurrence !== undefined || marker.document !== undefined
      || marker.kind !== "coordinator" || typeof marker.missionID !== "string"
      || !snapshot.missions.some(mission => mission.id === marker.missionID && mission.coordinatorSessionId === session.id)) return refuse()
  }
  const memberships = snapshot.missions.filter(mission => mission.actors.some(actor => actor.sessionId === session.id))
  if (memberships.some(mission => mission.coordinatorSessionId !== session.id)) return refuse()
  const active = memberships.filter(mission => mission.status === "active")
  if (active.length > 1) return refuse()
  return active[0]
}

export function missionListEntry(mission: MissionMap, relation: "member" | "prepared") {
  return {
    missionID: mission.id, ...(mission.title === undefined ? {} : { title: mission.title }), relation,
    template: mission.template, status: mission.status, ...(mission.runState === undefined ? {} : { runState: mission.runState }),
    revision: mission.revision, createdAt: mission.createdAt, ...(mission.summary === undefined ? {} : { summary: mission.summary }),
  }
}
