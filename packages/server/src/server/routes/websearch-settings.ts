import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { PluginControlsError } from "../../opencode/plugin-controls"
import type { WebSearchSettings } from "../../opencode/websearch-settings"

const Location = z.object({ directory: z.string().trim().min(1).max(32_768) }).strict()
const Mutation = z.object({ location: Location, scope: z.enum(["global", "project"]),
  provider: z.union([z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value)), z.literal(false), z.null()]),
}).strict()

export function registerWebSearchSettingsRoutes(app: FastifyInstance, settings: Pick<WebSearchSettings, "read" | "update">) {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/websearch-settings", async (request, reply) => {
    const parsed = Location.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid web search settings request" })
    try { return await settings.read(request.params.id, parsed.data) }
    catch (error) { return fail(error, reply) }
  })
  app.put<{ Params: { id: string } }>("/api/workspaces/:id/websearch-settings", async (request, reply) => {
    const parsed = Mutation.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid web search settings request" })
    try {
      await settings.update(request.params.id, parsed.data.location, parsed.data.scope, parsed.data.provider)
      return reply.code(204).send()
    } catch (error) { return fail(error, reply) }
  })
}

function fail(error: unknown, reply: FastifyReply) {
  if (error instanceof PluginControlsError) {
    const code = { "not-found": 404, forbidden: 403, invalid: 422, conflict: 409, unavailable: 503 }[error.kind]
    return reply.code(code).send({ error: error.message })
  }
  reply.log.warn({ err: error }, "Web search settings failed")
  return reply.code(503).send({ error: "Web search settings unavailable" })
}
