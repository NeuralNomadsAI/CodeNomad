import { z } from "zod"

export const PRUNING_RPC_ID = "codenomad.session-pruning"
export const PRUNING_EVENT = `rpc.${PRUNING_RPC_ID}.pruned` as const
const id = z.string().min(1).max(256)
export const messageTargetSchema = z.object({ sessionID: id, messageID: id }).strict()
export const pruneRequestSchema = messageTargetSchema.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  indexes: z.array(z.number().int().min(0).max(100_000)).min(1).max(4096)
    .refine((values) => new Set(values).size === values.length),
}).strict()
export type PruneRequest = z.infer<typeof pruneRequestSchema>
export const pruningBlockedSchema = z.object({
  status: z.literal("blocked"),
  reason: z.enum(["unavailable", "maintenance_required", "conflict", "not_deletable", "unsupported_storage"]),
}).strict()
export const pruneResultSchema = z.union([
  z.object({
    status: z.literal("pruned"), messageID: id,
    revision: z.string().regex(/^[a-f0-9]{64}$/), removedCount: z.number().int().positive(),
  }).strict(),
  pruningBlockedSchema,
])
export type PruneResult = z.infer<typeof pruneResultSchema>
export const prunePreviewSchema = z.union([
  z.object({
    status: z.literal("preview"), revision: z.string().regex(/^[a-f0-9]{64}$/),
    liveMutation: z.literal(false),
    parts: z.array(z.object({ index: z.number().int().nonnegative(), type: z.enum(["tool", "reasoning"]), bytes: z.number().int().nonnegative() })),
  }).strict(),
  pruningBlockedSchema,
])
export const prunedEventSchema = messageTargetSchema.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

// Portable Standard Schema contract: no Core imports or native event impersonation.
export const pruningRpcDefinition = {
  id: PRUNING_RPC_ID,
  methods: {
    preview: { input: messageTargetSchema, output: prunePreviewSchema },
    prune: { input: pruneRequestSchema, output: pruneResultSchema },
  },
  events: { pruned: { schema: prunedEventSchema } },
} as const
