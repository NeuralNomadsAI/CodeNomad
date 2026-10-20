import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { ServiceUsage } from "../../opencode/service-usage"
import { PluginControlsError } from "../../opencode/plugin-controls"

const timezone = z.string().min(1).max(128).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true } catch { return false } })
const Query = z.object({
  from: z.coerce.number().int().min(0).max(8_640_000_000_000_000),
  to: z.coerce.number().int().min(1).max(8_640_000_000_000_000),
  timezone,
  restorePeriod: z.literal("true").transform(() => true).optional(),
}).strict().refine(value => value.to > value.from && value.to - value.from <= 366 * 86_400_000)

export function registerServiceUsageRoutes(app: FastifyInstance, usage: Pick<ServiceUsage, "read" | "cached" | "owner" | "close">) {
  app.addHook("onClose", () => usage.close())
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/service-usage/owner", async (request, reply) => {
    try { return await usage.owner(request.params.id) }
    catch { return reply.code(503).send({ error: "Stats display owner unavailable" }) }
  })
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/service-usage/cache", async (request, reply) => {
    const query = z.object({ timezone, days: z.coerce.number().refine(value => [7, 30, 90, 365].includes(value)).optional() }).strict().safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: "Invalid Stats display cache query" })
    try { return await usage.cached(request.params.id, query.data.timezone, query.data.days) }
    catch { return reply.code(503).send({ error: "Stats display cache unavailable" }) }
  })
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
