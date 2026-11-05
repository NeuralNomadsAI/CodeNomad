import { z } from "zod"
import { ASSET_URI_LIMIT, isEmbeddedAsset } from "../embedded-asset"
export { ASSET_URI_LIMIT, isEmbeddedAsset } from "../embedded-asset"

const Id = z.string().min(1).max(256)
export const assetTargetSchema = z.object({ messageID: Id, part: z.number().int().min(0).max(100000),
  index: z.number().int().min(0).max(100000), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const assetsInputSchema = z.object({ sessionID: Id, cursor: z.string().max(4096).optional() }).strict()
export const assetReadInputSchema = z.object({ sessionID: Id, target: assetTargetSchema }).strict()
const blocked = z.object({ status: z.literal("blocked"), reason: z.string().max(80) }).strict()
export const assetsResultSchema = z.union([blocked, z.object({ status: z.literal("page"), entries: z.array(z.object({
  target: assetTargetSchema, name: z.string().max(256), tool: z.string().max(256), mime: z.string().max(128), available: z.boolean(),
}).strict()).max(64), cursor: z.string().max(4096).nullable() }).strict()])
export const assetReadResultSchema = z.union([blocked, z.object({ status: z.literal("asset"),
  mime: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).max(128), uri: z.string().max(ASSET_URI_LIMIT) }).strict().refine(isEmbeddedAsset)])
export type AssetTarget = z.infer<typeof assetTargetSchema>
export type AssetsResult = z.infer<typeof assetsResultSchema>
export type AssetReadResult = z.infer<typeof assetReadResultSchema>
