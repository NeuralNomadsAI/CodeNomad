import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { z } from "zod"
import { stableToken } from "../../missions/journal"
import { RECURRENCE_STORAGE_PREFIX } from "../../missions/recurrence-contract"

type Ctx = Pick<Plugin.Context, "storage" | "location">
/** Display-only sibling of the schedule document: never part of its revision/CAS,
 * never execution authority, and safe to lose. */
export const recurrenceWakeErrorSchema = z.object({
  code: z.enum(["wake-failed", "admission-failed", "settlement-failed"]),
  at: z.number().int().nonnegative().safe(),
}).strict()
export type RecurrenceWakeError = z.infer<typeof recurrenceWakeErrorSchema>

const key = (ctx: Ctx, scheduleID: string) => `${RECURRENCE_STORAGE_PREFIX}/status/${stableToken(
  `${ctx.location.project.id}\0${ctx.location.project.canonical}`, 24)}/${scheduleID}`
const bestEffort = <A>(effect: () => Effect.Effect<A, unknown>) => Effect.suspend(effect).pipe(Effect.asVoid, Effect.catchCause(() => Effect.void))

export const recordRecurrenceWakeError = (ctx: Ctx, scheduleID: string, value: RecurrenceWakeError) =>
  bestEffort(() => ctx.storage.set(key(ctx, scheduleID), value))
export const clearRecurrenceWakeError = (ctx: Ctx, scheduleID: string) =>
  bestEffort(() => ctx.storage.remove(key(ctx, scheduleID)))
export const readRecurrenceWakeError = (ctx: Ctx, scheduleID: string) =>
  Effect.suspend(() => ctx.storage.get(key(ctx, scheduleID))).pipe(
    Effect.map(value => recurrenceWakeErrorSchema.safeParse(value).data),
    Effect.catchCause(() => Effect.succeed(undefined)))
