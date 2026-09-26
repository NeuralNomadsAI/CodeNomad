import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { PluginControlsError } from "../../opencode/plugin-controls"
import type { McpCodeMode } from "../../opencode/mcp-code-mode"

const Location = z.object({ directory: z.string().trim().min(1).max(32_768) }).strict()
const Mutation = z.object({ location: Location, scope: z.enum(["global", "project"]),
  server: z.string().min(1).max(1024).refine(value => !/[\u0000-\u001f\u007f]/.test(value)), mode: z.boolean().nullable(),
}).strict()

export function registerMcpCodeModeRoutes(app: FastifyInstance, settings: Pick<McpCodeMode, "read" | "update">) {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/mcp-code-mode", async (request, reply) => {
    const parsed = Location.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid MCP Code Mode request" })
    try { return await settings.read(request.params.id, parsed.data) } catch (error) { return fail(error, reply) }
  })
  app.put<{ Params: { id: string } }>("/api/workspaces/:id/mcp-code-mode", async (request, reply) => {
    const parsed = Mutation.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid MCP Code Mode request" })
    try {
      await settings.update(request.params.id, parsed.data.location, parsed.data.scope, parsed.data.server, parsed.data.mode)
      return reply.code(204).send()
    } catch (error) { return fail(error, reply) }
  })
}
function fail(error: unknown, reply: FastifyReply) {
  if (error instanceof PluginControlsError) return reply.code({ "not-found": 404, forbidden: 403, invalid: 422, conflict: 409, unavailable: 503 }[error.kind]).send({ error: error.message })
  reply.log.warn({ err: error }, "MCP Code Mode settings failed")
  return reply.code(503).send({ error: "MCP Code Mode settings unavailable" })
}
