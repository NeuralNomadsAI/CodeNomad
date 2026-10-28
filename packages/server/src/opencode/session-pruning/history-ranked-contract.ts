import { z } from "zod"
import { pruningBlockedSchema } from "./contract"
import { historyHitSchema, historyNativePageSchema } from "./history-contract"
import { dateBounds } from "./history-ranking"

const rankedOptionsSchema = z.object({
  version: z.literal(1), query: z.string().min(1).max(200),
  includeTechnical: z.boolean().default(false),
  since: z.string().optional(), until: z.string().optional(),
  limit: z.number().int().min(1).max(40).default(10),
}).strict()
const validateDates = (input: { since?: string; until?: string }, ctx: z.RefinementCtx) => {
  try { dateBounds(input.since, input.until) }
  catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message }) }
}
export const historyRankedInputSchema = rankedOptionsSchema.extend({ cursor: z.string().min(1).max(32_768).optional() }).strict().superRefine(validateDates)
export const sessionSearchInputSchema = rankedOptionsSchema.extend({ limit: z.number().int().min(1).max(20).default(10) }).strict().superRefine(validateDates)
export type HistoryRankedInput = z.infer<typeof historyRankedInputSchema>
export const historyRankedPageSchema = z.object({
  version: z.literal(1), status: z.literal("ranked"),
  scanned: z.number().int().nonnegative(), candidates: z.number().int().nonnegative(),
  judged: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  prefilterBypassed: z.number().int().nonnegative().default(0),
  matchedSessions: z.number().int().nonnegative(), capped: z.boolean(),
  examinedBefore: z.number().int().nonnegative().safe().default(0),
  cursor: z.string().min(1).max(32_768).nullable().default(null),
  exclusions: z.array(z.enum(["foreign_directory", "unknown_directory"])).max(2).default([]),
  caps: z.array(z.enum(["scan_time", "message_limit", "candidate_limit", "session_limit", "judge_limit", "total_time"])).max(6),
  hits: z.array(historyHitSchema.extend({ createdAt: z.number().finite() }).strict()).max(40),
  sessions: z.array(historyNativePageSchema.shape.sessions.element.extend({ title: z.string().max(4096),
    candidates: z.number().int().nonnegative(), judged: z.number().int().nonnegative(), matchedMessages: z.number().int().nonnegative(),
    prefilterBypassed: z.number().int().nonnegative().default(0),
  }).strict()).max(600),
}).strict()
export type HistoryRankedPage = z.infer<typeof historyRankedPageSchema>
export const historyRankedResultSchema = z.union([historyRankedPageSchema, pruningBlockedSchema])
export type HistoryRankedResult = z.infer<typeof historyRankedResultSchema>
