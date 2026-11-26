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

/** A task that can still work or ask: neither finished nor replaced. */
export function missionTaskMarkLive(task: Pick<MissionTaskMark, "status" | "replacedByTaskKey">): boolean {
  return !["completed", "failed", "withdrawn"].includes(task.status) && !task.replacedByTaskKey
}

/** Attention order: the live tasks in plan order, then the others from the newest
 * change to the oldest, so a reader needs no window past the first one it has seen. */
export function missionTaskMarks(tasks: readonly MissionTaskMark[]): MissionTaskMark[] {
  const marks = tasks.map(({ id, key, status, updatedAt, actorSessionId, replacedByTaskKey }) => ({ id, key, status, updatedAt,
    ...(actorSessionId ? { actorSessionId } : {}), ...(replacedByTaskKey ? { replacedByTaskKey } : {}) }))
  return [...marks.filter(missionTaskMarkLive), ...marks.filter(task => !missionTaskMarkLive(task)).sort((left, right) => right.updatedAt - left.updatedAt)]
}

/** Whether the first windows of a Mission's marks hold every one a reader still needs:
 * each live task, and each other task changed after `seenThrough`. */
export function missionTaskMarksCover(read: readonly MissionTaskMark[], seenThrough: number): boolean {
  const last = read.at(-1)
  return last !== undefined && !missionTaskMarkLive(last) && last.updatedAt <= seenThrough
}
