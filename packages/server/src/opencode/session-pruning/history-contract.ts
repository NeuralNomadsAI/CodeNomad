import { z } from "zod"
import { pruningBlockedSchema, pruneResultSchema } from "./contract"

const id = z.string().min(1).max(256)
export const historyQuerySchema = z.object({
  sessionID: id.optional(),
  query: z.string().max(200).default(""),
  includeTechnical: z.boolean().default(true),
  purpose: z.enum(["search", "stats", "prune"]).default("search"),
  cursor: z.string().max(4096).optional(),
}).strict().refine(input => input.purpose !== "prune" || Boolean(input.sessionID))
export type HistoryQuery = z.infer<typeof historyQuerySchema>
export const historyCandidateSchema = z.object({
  messageID: id, revision: z.string().regex(/^[a-f0-9]{64}$/),
  toolCount: z.number().int().nonnegative(), reasoningCount: z.number().int().nonnegative(),
}).strict()
export type HistoryCandidate = z.infer<typeof historyCandidateSchema>
export const historyHitSchema = z.object({
  sessionID: id, messageID: id, role: z.string().max(32),
  partIndex: z.number().int().nonnegative(), kind: z.enum(["text", "tool", "reasoning"]),
  excerpt: z.string().max(320),
}).strict()
export type HistoryHit = z.infer<typeof historyHitSchema>
export const historyPageSchema = z.object({
  status: z.literal("page"),
  scanned: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(), reasoning: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  hits: z.array(historyHitSchema).max(32),
  candidates: z.array(historyCandidateSchema).max(32),
  cursor: z.string().max(4096).nullable(),
}).strict()
export type HistoryPage = z.infer<typeof historyPageSchema>
export const historyResultSchema = z.union([historyPageSchema, pruningBlockedSchema])
export type HistoryResult = z.infer<typeof historyResultSchema>
// Broker-only provenance: a shared native project ID does not establish local
// repository ownership (an independent clone can have the same project ID).
export const historyNativePageSchema = historyPageSchema.extend({
  sessions: z.array(z.object({
    sessionID: id, directory: z.string().min(1).max(4096), workspaceID: id.optional(),
    scanned: z.number().int().nonnegative(), tools: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  }).strict()).max(32),
}).strict()
export type HistoryNativePage = z.infer<typeof historyNativePageSchema>
export const historyNativeResultSchema = z.union([historyNativePageSchema, pruningBlockedSchema])
export type HistoryNativeResult = z.infer<typeof historyNativeResultSchema>
export const pruneBatchSchema = z.object({
  sessionID: id, candidates: z.array(historyCandidateSchema).min(1).max(16),
}).strict().refine(input => new Set(input.candidates.map(item => item.messageID)).size === input.candidates.length)
export const pruneBatchResultSchema = z.object({
  results: z.array(z.object({ messageID: id, result: pruneResultSchema }).strict()).max(16),
}).strict()
export type PruneBatch = z.infer<typeof pruneBatchSchema>
export type PruneBatchResult = z.infer<typeof pruneBatchResultSchema>
