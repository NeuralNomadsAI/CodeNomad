import { z } from "zod"
import { historyRankedPageSchema } from "../../opencode/session-pruning/history-ranked-contract"
import { pruningBlockedSchema } from "../../opencode/session-pruning/contract"

// Public display response: native locations, titles and technical cap sources stay broker-only.
export const rankedHistoryPageSchema = historyRankedPageSchema.omit({ sessions: true, caps: true }).strict()
export const rankedHistoryResultSchema = z.union([rankedHistoryPageSchema, pruningBlockedSchema,
  z.object({ status: z.literal("unsupported") }).strict()])
export type RankedHistoryResult = z.infer<typeof rankedHistoryResultSchema>
export type RankedHistoryPage = z.infer<typeof rankedHistoryPageSchema>
