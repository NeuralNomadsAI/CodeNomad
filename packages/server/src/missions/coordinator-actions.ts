import { z } from "zod"
import type { MissionMap, MissionTask } from "./model"

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

export function missionListEntry(mission: MissionMap, relation: "member" | "prepared") {
  return {
    missionID: mission.id, ...(mission.title === undefined ? {} : { title: mission.title }), relation,
    template: mission.template, status: mission.status, ...(mission.runState === undefined ? {} : { runState: mission.runState }),
    revision: mission.revision, createdAt: mission.createdAt, ...(mission.summary === undefined ? {} : { summary: mission.summary }),
  }
}
