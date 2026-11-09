import { z } from "zod"

/** Directory attention facts, independent of task bodies and the selected task window. */
export const missionTaskMarkSchema = z.object({
  id: z.string().min(1).max(240), key: z.string().min(1).max(64),
  status: z.enum(["blocked", "ready", "dispatching", "queued", "completed", "needs-input", "failed", "withdrawn"]),
  updatedAt: z.number().finite().nonnegative(), actorSessionId: z.string().min(1).max(240).optional(),
  replacedByTaskKey: z.string().min(1).max(64).optional(),
}).strict()
export type MissionTaskMark = z.infer<typeof missionTaskMarkSchema>
export const missionTaskMarksSchema = z.array(missionTaskMarkSchema).refine(tasks =>
  new Set(tasks.map(task => task.id)).size === tasks.length && new Set(tasks.map(task => task.key)).size === tasks.length)

export function missionTaskMarks(tasks: readonly MissionTaskMark[]): MissionTaskMark[] {
  return tasks.map(({ id, key, status, updatedAt, actorSessionId, replacedByTaskKey }) => ({ id, key, status, updatedAt,
    ...(actorSessionId ? { actorSessionId } : {}), ...(replacedByTaskKey ? { replacedByTaskKey } : {}) }))
}
