import { z } from "zod"
import { assetTargetSchema, assetReadResultSchema } from "./assets-contract"

// Fixed gallery methods over image `read` parts of one session (dev-docs/SESSION_PRUNING_RPC.md#image-gallery).
const Id = z.string().min(1).max(256)
const Key = z.string().regex(/^[\w-]{22}$/)
export const GALLERY_RESPONSE_LIMIT = 1024 * 1024
export const generationTargetSchema = z.object({ messageID: Id, part: z.number().int().min(0).max(100000),
  digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const imagesInputSchema = z.object({ sessionID: Id, cursor: z.string().max(4096).optional(), prompts: z.boolean().optional() }).strict()
export const imageReadInputSchema = z.object({ sessionID: Id, target: assetTargetSchema }).strict()
export const imageReferenceInputSchema = z.object({ sessionID: Id, target: z.union([assetTargetSchema, generationTargetSchema]) }).strict()
export const imagesConversationInputSchema = z.object({ mode: z.enum(["lookup", "open", "new"]), title: z.string().min(1).max(256).optional(),
  agent: z.string().min(1).max(256).optional(),
  model: z.object({ providerID: Id, id: Id, variant: z.string().min(1).max(256).optional() }).strict().optional() }).strict()

const blocked = z.object({ status: z.literal("blocked"), reason: z.string().max(80) }).strict()
const annotation = { prompt: z.string().max(8192).optional(), promptTruncated: z.literal(true).optional(), model: z.string().max(256).optional() }
const common = { series: Key, time: z.number().nullable() }
const imageEntry = z.object({ kind: z.literal("image"), target: assetTargetSchema, ...common, label: z.string().max(128).nullable(),
  mime: z.string().max(128), origin: z.enum(["proven", "unverifiable"]), generationKey: Key.optional(),
  parentKeys: z.array(Key).max(100000).optional(), otherRefs: z.number().int().min(0).optional(), ...annotation }).strict()
const generationEntry = z.object({ kind: z.literal("generation"), target: generationTargetSchema, ...common, key: Key,
  tool: z.enum(["streaming", "running", "completed", "error", "unknown"]),
  outcome: z.enum(["none", "completed", "error", "cancelled", "unknown"]), ...annotation }).strict()
export const imagesResultSchema = z.union([blocked, z.object({ status: z.literal("page"),
  entries: z.array(z.union([imageEntry, generationEntry])).max(64), cursor: z.string().max(4096).nullable() }).strict()])
export const imageReadResultSchema = assetReadResultSchema
export const imageReferenceResultSchema = z.union([blocked, z.object({ status: z.literal("path"), path: z.string().min(1).max(4096) }).strict(),
  z.object({ status: z.literal("refused"), reason: z.enum(["unverifiable", "outside", "changed", "not-gallery", "missing"]) }).strict()])
export const imagesConversationResultSchema = z.union([blocked,
  z.object({ status: z.enum(["absent", "unknown"]) }).strict(),
  z.object({ status: z.literal("found"), sessionID: Id, created: z.boolean() }).strict()])

export type GenerationTarget = z.infer<typeof generationTargetSchema>
export type ImagesResult = z.infer<typeof imagesResultSchema>
export type GalleryEntry = Extract<ImagesResult, { status: "page" }>["entries"][number]
export type ImageReferenceResult = z.infer<typeof imageReferenceResultSchema>
export type ImagesConversationInput = z.infer<typeof imagesConversationInputSchema>
export type ImagesConversationResult = z.infer<typeof imagesConversationResultSchema>
