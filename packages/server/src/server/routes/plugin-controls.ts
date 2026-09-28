import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import type { PluginControls } from "../../opencode/plugin-controls"
import { PluginControlsError } from "../../opencode/plugin-controls"

type PluginControlsApi = Pick<PluginControls, "read" | "mutate">

interface RouteDeps {
  controls: PluginControlsApi
}

const LocationFields = {
  directory: z.string().trim().min(1).max(32_768),
  workspaceID: z.string().trim().min(1).max(1_024).optional(),
}

const PluginControlsQuerySchema = z.object(LocationFields).strict()

const PluginActivationMutationSchema = z.object({
  location: z.object(LocationFields).strict(),
  pluginId: z.string().trim().min(1).max(256)
    .refine((value) => !value.startsWith("-") && !value.includes("*") && !/[\u0000-\u001f\u007f]/.test(value)),
  scope: z.enum(["global", "project"]),
  enabled: z.boolean(),
}).strict()

export function registerPluginControlRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{
    Params: { id: string }
    Querystring: { directory?: string; workspaceID?: string }
  }>("/api/workspaces/:id/plugin-controls", async (request, reply) => {
    const parsed = PluginControlsQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) return invalidRequest(reply)
    try {
      return await deps.controls.read(request.params.id, parsed.data)
    } catch (error) {
      return handleError(error, request.params.id, request.log, reply)
    }
  })

  app.patch<{
    Params: { id: string }
  }>("/api/workspaces/:id/plugin-controls", async (request, reply) => {
    const parsed = PluginActivationMutationSchema.safeParse(request.body ?? {})
    if (!parsed.success) return invalidRequest(reply)
    try {
      return await deps.controls.mutate(request.params.id, parsed.data)
    } catch (error) {
      return handleError(error, request.params.id, request.log, reply)
    }
  })
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ error: "Invalid plugin activation request" })
}

function handleError(error: unknown, workspaceId: string, logger: FastifyReply["log"], reply: FastifyReply) {
  if (error instanceof PluginControlsError) {
    const status = error.kind === "not-found" ? 404
      : error.kind === "forbidden" ? 403
        : error.kind === "invalid" ? 422
          : error.kind === "conflict" ? 409
            : 503
    if (status >= 500) logger.warn({ err: error, workspaceId }, "Plugin activation controls unavailable")
    return reply.code(status).send({ error: error.message })
  }
  logger.error({ err: error, workspaceId }, "Plugin activation controls failed")
  return reply.code(500).send({ error: "Plugin activation controls failed" })
}
