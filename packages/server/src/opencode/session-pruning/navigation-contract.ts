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
export const outlineInputSchema = z.object({ sessionID: id,
  cursor: outlineCursorSchema.optional(),
}).strict()
const messageType = z.enum(["user", "assistant", "system", "synthetic", "skill", "shell", "compaction", "idle", "agent-switched", "model-switched", "location-switched"])
export const outlineEntrySchema = z.object({
  id, seq: z.number().int().nonnegative(), type: messageType,
  preview: z.string().max(220), chars: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(), reasoning: z.number().int().nonnegative(),
}).strict()
export type OutlineEntry = z.infer<typeof outlineEntrySchema>
export const outlineResultSchema = z.union([pruningBlockedSchema, z.object({
  status: z.literal("outline"), entries: z.array(outlineEntrySchema).max(256),
  total: z.number().int().nonnegative(), cursor: outlineCursorSchema.nullable(),
}).strict()])
export type OutlineResult = z.infer<typeof outlineResultSchema>
export const navigationWindowResultSchema = z.union([pruningBlockedSchema, z.object({
  status: z.literal("window"),
  messages: z.array(z.object({ id, type: messageType, time: z.object({ created: z.number() }).passthrough() }).passthrough()).max(200),
  older: navigationTargetSchema.nullable(), newer: navigationTargetSchema.nullable(),
  resume: navigationTargetSchema, latest: z.boolean(),
}).strict()])
export type NavigationWindowResult = z.infer<typeof navigationWindowResultSchema>
