import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { PermissionReceipts } from "../../permissions/receipts"

const querySchema = z.object({
  messageId: z.string().min(1).max(512).optional(),
  unanchored: z.literal("true").optional(),
  cursor: z.string().regex(/^[a-f0-9]{64}\.json$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict().refine(value => Boolean(value.messageId) !== Boolean(value.unanchored), "Choose messageId or unanchored")

export function registerPermissionReceiptRoutes(app: FastifyInstance, receipts: PermissionReceipts) {
  app.get<{ Params: { id: string; sessionId: string } }>("/api/workspaces/:id/sessions/:sessionId/permission-receipts", async (request, reply) => {
    reply.header("cache-control", "no-store")
    const query = querySchema.safeParse(request.query)
    if (!query.success || !request.params.sessionId.startsWith("ses") || request.params.sessionId.length > 512) {
      return reply.code(400).send({ error: "Invalid permission receipt query" })
    }
    return receipts.list(request.params.id, request.params.sessionId, { ...query.data, unanchored: query.data.unanchored === "true" })
  })
}
