import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { PluginSourcesError, type PluginSources } from "../../opencode/plugin-sources"
import { PLUGIN_SOURCE_MAX_SPEC_LENGTH } from "../../opencode/plugin-source-document"

interface RouteDeps {
  sources: Pick<PluginSources, "add" | "remove">
}

const Location = z.object({
  directory: z.string().trim().min(1).max(32_768),
  workspaceID: z.string().trim().min(1).max(1_024).optional(),
}).strict()
const Scope = z.enum(["global", "project"])

// Specs are validated as exact strings (no trimming): the stored entry is exactly what was sent.
const AddSchema = z.object({ location: Location, scope: Scope, spec: z.string().min(1).max(PLUGIN_SOURCE_MAX_SPEC_LENGTH) }).strict()
const RemoveSchema = z.object({
  location: Location,
  scope: Scope,
  target: z.string().min(1).max(32_768),
  entryIndex: z.number().int().min(0).max(100_000),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export function registerPluginSourceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/plugin-sources", async (request, reply) => {
    const parsed = AddSchema.safeParse(request.body ?? {})
    if (!parsed.success) return invalidRequest(reply)
    try {
      return await deps.sources.add(request.params.id, parsed.data)
    } catch (error) {
      return handleError(error, request.params.id, request.log, reply)
    }
  })

  app.delete<{ Params: { id: string } }>("/api/workspaces/:id/plugin-sources", async (request, reply) => {
    const parsed = RemoveSchema.safeParse(request.body ?? {})
    if (!parsed.success) return invalidRequest(reply)
    try {
      return await deps.sources.remove(request.params.id, parsed.data)
    } catch (error) {
      return handleError(error, request.params.id, request.log, reply)
    }
  })
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ error: "Invalid plugin source request" })
}

function handleError(error: unknown, workspaceId: string, logger: FastifyReply["log"], reply: FastifyReply) {
  if (error instanceof PluginControlsError) {
    const status = error.kind === "not-found" ? 404
      : error.kind === "forbidden" ? 403
        : error.kind === "invalid" ? 422
          : error.kind === "conflict" ? 409
            : 503
    if (status >= 500) logger.warn({ status }, "Plugin sources unavailable")
    return reply.code(status).send({ error: "Plugin source update refused", ...(error instanceof PluginSourcesError ? { code: error.code } : {}) })
  }
  logger.error({ status: 500 }, "Plugin source update failed")
  return reply.code(500).send({ error: "Plugin source update failed" })
}
