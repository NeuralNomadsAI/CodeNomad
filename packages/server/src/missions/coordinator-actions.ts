import { z } from "zod"
import type { MissionMap, MissionSnapshot, MissionTask } from "./model"
import type { NativeMissionSession } from "./control-types"
import { MissionControlError } from "./control-error"
import { isReservedMissionScheduleSessionID } from "./mission-schedule-carrier-identity"
import { sameLocation } from "../opencode/compatibility/location"

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

/** Display relation; project ownership authorizes reads independently. */
export function missionRelation(mission: MissionMap, sessionID: string): "member" | "prepared" | undefined {
  if (mission.actors.some(actor => actor.sessionId === sessionID)) return "member"
  if (mission.preparedBy?.coordinatorSessionId === sessionID) return "prepared"
  return undefined
}

/** Actual native authors retain their identity; ancestry supplies source provenance.
 * Passage and historical actor markers remain usable outside the ordinary journal. */
export async function missionPreparationSource(snapshot: MissionSnapshot, session: NativeMissionSession,
  get: (sessionID: string) => Promise<NativeMissionSession>): Promise<Pick<MissionMap, "id"> | undefined> {
  const refuse = (): never => { throw new MissionControlError("This session cannot prepare a separate mission", "prepare-refused") }
  if (snapshot.discardedEvents || snapshot.controlUnavailable) return refuse()
  const seen = new Set<string>(), location = session.location
  for (let depth = 0; depth <= 32; depth++) {
    if (seen.has(session.id) || session.projectID !== snapshot.projectID || !sameLocation(session.location, location)
      || isReservedMissionScheduleSessionID(session.id)) return refuse()
    seen.add(session.id)
    const memberships = snapshot.missions.filter(mission => mission.actors.some(actor => actor.sessionId === session.id))
    const marker = session.metadata?.["codenomad.mission"]
    if (marker !== undefined && (!marker || typeof marker !== "object" || Array.isArray(marker)
      || typeof marker.missionID !== "string")) return refuse()
    // A conversation may take part in several active Missions. The source stays stable
    // across rereads: the marked one, otherwise the oldest.
    const active = memberships.filter(mission => mission.status === "active")
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    const marked = active.find(mission => marker && typeof marker === "object" && mission.id === marker.missionID)
    if (marked ?? active[0]) return marked ?? active[0]
    if (marker && typeof marker === "object" && typeof marker.missionID === "string") return { id: marker.missionID }
    if (memberships.length) return memberships.sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!session.parentID) return undefined
    const parentID = session.parentID
    session = await get(parentID)
    if (session.id !== parentID) return refuse()
  }
  return refuse()
}

export function missionListEntry(mission: MissionMap, relation: "member" | "prepared" | "project") {
  return {
    missionID: mission.id, ...(mission.title === undefined ? {} : { title: mission.title }), relation,
    template: mission.template, status: mission.status, ...(mission.runState === undefined ? {} : { runState: mission.runState }),
    revision: mission.revision, createdAt: mission.createdAt, ...(mission.summary === undefined ? {} : { summary: mission.summary }),
  }
}
