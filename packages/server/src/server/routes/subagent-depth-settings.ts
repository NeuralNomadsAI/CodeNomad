import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { PluginControlsError } from "../../opencode/plugin-controls"
import type { SubagentDepthSettings } from "../../opencode/subagent-depth-settings"

const Location = z.object({ directory: z.string().trim().min(1).max(32_768) }).strict()
const Mutation = z.object({ location: Location, depth: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  expectation: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export function registerSubagentDepthSettingsRoutes(app: FastifyInstance, settings: Pick<SubagentDepthSettings, "read" | "update">) {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/subagent-depth", async (request, reply) => {
    const parsed = Location.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid subagent depth request" })
    try { return await settings.read(request.params.id, parsed.data) }
    catch (error) { return fail(error, reply) }
  })
  app.put<{ Params: { id: string } }>("/api/workspaces/:id/subagent-depth", async (request, reply) => {
    const parsed = Mutation.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid subagent depth request" })
    try {
      await settings.update(request.params.id, parsed.data.location, parsed.data.depth, parsed.data.expectation)
      return reply.code(204).send()
    } catch (error) { return fail(error, reply) }
  })
}

function fail(error: unknown, reply: FastifyReply) {
  if (error instanceof PluginControlsError) {
    const status = { "not-found": 404, forbidden: 403, invalid: 422, conflict: 409, unavailable: 503 }[error.kind]
    return reply.code(status).send({ error: error.message })
  }
  // Upstream errors can contain credential-bearing requests; never serialize/log them.
  return reply.code(503).send({ error: "Native subagent depth is unavailable" })
}
