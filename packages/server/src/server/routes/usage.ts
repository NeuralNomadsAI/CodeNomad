import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { getProviderUsage } from "../../usage/service"

const UsageParamsSchema = z.object({ providerId: z.string().trim().min(1) })
const UsageQuerySchema = z.object({ modelId: z.string().trim().optional() })

export function registerUsageRoutes(app: FastifyInstance) {
  app.get<{ Params: { providerId: string }; Querystring: { modelId?: string } }>(
    "/api/usage/:providerId",
    async (request, reply) => {
      try {
        const params = UsageParamsSchema.parse(request.params)
        const query = UsageQuerySchema.parse(request.query ?? {})
        return await getProviderUsage(params.providerId, { modelId: query.modelId })
      } catch (error) {
        request.log.error({ err: error }, "Failed to fetch provider usage")
        reply.code(400)
        return { error: error instanceof Error ? error.message : "Failed to fetch provider usage" }
      }
    },
  )
}
