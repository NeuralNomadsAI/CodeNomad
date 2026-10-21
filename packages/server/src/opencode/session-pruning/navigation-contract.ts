import { z } from "zod"
import { pruningBlockedSchema } from "./contract"

const id = z.string().min(1).max(256)
export const navigationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("latest") }).strict(),
  z.object({ kind: z.literal("oldest") }).strict(),
  z.object({ kind: z.literal("around"), messageID: id }).strict(),
  z.object({ kind: z.literal("before"), messageID: id }).strict(),
  z.object({ kind: z.literal("after"), messageID: id }).strict(),
])
export type NavigationTarget = z.infer<typeof navigationTargetSchema>
export const navigationWindowInputSchema = z.object({ sessionID: id, target: navigationTargetSchema }).strict()
const outlineCursorSchema = z.object({ after: z.number().int().nonnegative(), through: z.number().int().nonnegative() }).strict()
export const outlineCheckpointSchema = z.object({ after: z.number().int().min(-1), through: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type OutlineCheckpoint = z.infer<typeof outlineCheckpointSchema>
export const outlineInputSchema = z.object({ sessionID: id,
  cursor: outlineCursorSchema.optional(),
  after: z.number().int().min(-1).optional(),
  known: z.array(outlineCheckpointSchema).max(512).optional(),
}).strict()
const messageType = z.enum(["user", "assistant", "system", "synthetic", "skill", "shell", "compaction", "idle", "agent-switched", "model-switched", "location-switched"])
const count = z.number().int().nonnegative()
const outlineEntryShape = {
  id, seq: count, type: messageType, tools: count, reasoning: count,
  // Non-blank visible text parts; absent from older plugin copies, so unknown.
  text: count.optional(),
  toolName: z.string().max(256).optional(),
}
/** The `outline` method's entries. Backends validate them strictly: never extend this shape. */
export const outlineEntrySchema = z.object(outlineEntryShape).strict()
/**
 * The versioned `outlineLayout` method's entries add an assistant step's
 * visible parts in order: R reasoning and T text runs, X per tool. Beyond 64
 * kinds the layout keeps the first 32 and last 31 around `-`, and `omitted`
 * counts the reasoning and text runs between them (tools follow from `tools`).
 */
export const outlineLayoutEntrySchema = z.object({ ...outlineEntryShape,
  layout: z.string().regex(/^(?:[RTX]{0,64}|[RTX]{32}-[RTX]{31})$/).optional(),
  omitted: z.object({ reasoning: count, text: count }).strict().optional(),
}).strict()
export type OutlineEntry = z.infer<typeof outlineLayoutEntrySchema>
const outlinePageSchema = <T extends z.ZodTypeAny>(entry: T) => z.union([pruningBlockedSchema, z.object({
  status: z.literal("outline"), entries: z.array(entry).max(16384),
  total: count, cursor: outlineCursorSchema.nullable(),
  checkpoints: z.array(outlineCheckpointSchema.extend({ changed: z.boolean() })).max(512),
}).strict()])
export const outlineResultSchema = outlinePageSchema(outlineEntrySchema)
export const outlineLayoutResultSchema = outlinePageSchema(outlineLayoutEntrySchema)
export type OutlineResult = z.infer<typeof outlineLayoutResultSchema>
export const outlinePreviewInputSchema = z.object({ sessionID: id, messageIDs: z.array(id).min(1).max(12) }).strict()
export const outlinePreviewResultSchema = z.union([pruningBlockedSchema, z.object({
  status: z.literal("previews"), entries: z.array(z.object({ id, text: z.string().max(4096), tools: z.string().max(4096) }).strict()).max(12),
}).strict()])
export type OutlinePreviewResult = z.infer<typeof outlinePreviewResultSchema>
export const navigationWindowResultSchema = z.union([pruningBlockedSchema,
  z.object({ status: z.literal("blocked"), reason: z.literal("anchor_missing") }).strict(), z.object({
  status: z.literal("window"),
  messages: z.array(z.object({ id, type: messageType, time: z.object({ created: z.number() }).passthrough() }).passthrough()).max(200),
  older: navigationTargetSchema.nullable(), newer: navigationTargetSchema.nullable(),
  resume: navigationTargetSchema, latest: z.boolean(),
}).strict()])
export type NavigationWindowResult = z.infer<typeof navigationWindowResultSchema>
