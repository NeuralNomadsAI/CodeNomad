import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { ServiceUsage } from "../../opencode/service-usage"
import { PluginControlsError } from "../../opencode/plugin-controls"

const Query = z.object({
  from: z.coerce.number().int().min(0).max(8_640_000_000_000_000),
  to: z.coerce.number().int().min(1).max(8_640_000_000_000_000),
  timezone: z.string().min(1).max(128).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true } catch { return false } }),
}).strict().refine(value => value.to > value.from && value.to - value.from <= 366 * 86_400_000)

export function registerServiceUsageRoutes(app: FastifyInstance, usage: Pick<ServiceUsage, "read">) {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/service-usage", async (request, reply) => {
    const query = Query.safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: "Invalid bounded service usage query" })
    try { return await usage.read(request.params.id, query.data) }
    catch (error) {
      if (error instanceof PluginControlsError) return reply.code({ "not-found": 404, forbidden: 403, invalid: 422, conflict: 409, unavailable: 503 }[error.kind]).send({ error: error.message })
      request.log.warn({ err: error }, "Service usage unavailable")
      return reply.code(503).send({ error: "Service usage unavailable" })
    }
  })
}
