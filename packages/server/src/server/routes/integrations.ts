import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { IntegrationsReader } from "../../opencode/integrations/integrations"
import { PluginControlsError } from "../../opencode/plugin-controls"

export interface IntegrationRouteDeps {
  integrations: Pick<IntegrationsReader, "read">
}

// The RPC ID always comes from the catalog: the query names a Location only.
const QuerySchema = z.object({
  directory: z.string().trim().min(1).max(32_768),
  workspaceID: z.string().trim().min(1).max(1_024).optional(),
}).strict()

/** The catalog integrations of one owned Location with their state (dev-docs/OPENCODE_INTEGRATIONS.md). */
export function registerIntegrationRoutes(app: FastifyInstance, deps: IntegrationRouteDeps): void {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/integrations", async (request, reply) => {
    reply.header("cache-control", "no-store")
    const parsed = QuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: "Invalid integrations request" })
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.once("close", abort)
    try {
      return await deps.integrations.read(request.params.id, parsed.data, controller.signal)
    } catch (error) {
      if (error instanceof PluginControlsError) {
        const status = error.kind === "not-found" ? 404 : error.kind === "forbidden" ? 403 : error.kind === "invalid" ? 422 : error.kind === "conflict" ? 409 : 503
        if (status >= 500) request.log.warn({ status }, "OpenCode integrations unavailable")
        return reply.code(status).send({ error: error.message })
      }
      if (controller.signal.aborted) return reply.code(499).send({ error: "Request closed" })
      request.log.error("OpenCode integrations read failed")
      return reply.code(500).send({ error: "OpenCode integrations read failed" })
    } finally {
      reply.raw.removeListener("close", abort)
    }
  })
}
