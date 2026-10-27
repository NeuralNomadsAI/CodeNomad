import { z } from "zod"
import { pruningBlockedSchema } from "./contract"
import { historyHitSchema, historyNativePageSchema } from "./history-contract"
import { dateBounds } from "./history-ranking"

export const historyRankedInputSchema = z.object({
  version: z.literal(1), query: z.string().min(1).max(200),
  includeTechnical: z.boolean().default(false),
  since: z.string().optional(), until: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(10),
}).strict().superRefine((input, ctx) => {
  try { dateBounds(input.since, input.until) }
  catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message }) }
})
export type HistoryRankedInput = z.infer<typeof historyRankedInputSchema>
export const historyRankedPageSchema = z.object({
  version: z.literal(1), status: z.literal("ranked"),
  scanned: z.number().int().nonnegative(), candidates: z.number().int().nonnegative(),
  judged: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  matchedSessions: z.number().int().nonnegative(), capped: z.boolean(),
  caps: z.array(z.enum(["scan_time", "candidate_limit", "session_limit", "judge_limit", "total_time"])).max(5),
  hits: z.array(historyHitSchema.extend({ createdAt: z.number().finite() }).strict()).max(20),
  sessions: z.array(historyNativePageSchema.shape.sessions.element.extend({ title: z.string().max(4096),
    candidates: z.number().int().nonnegative(), judged: z.number().int().nonnegative(), matchedMessages: z.number().int().nonnegative(),
  }).strict()).max(600),
}).strict()
export type HistoryRankedPage = z.infer<typeof historyRankedPageSchema>
export const historyRankedResultSchema = z.union([historyRankedPageSchema, pruningBlockedSchema])
export type HistoryRankedResult = z.infer<typeof historyRankedResultSchema>
