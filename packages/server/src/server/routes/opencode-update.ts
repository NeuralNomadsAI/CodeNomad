import type { FastifyInstance } from "fastify"
import type { Logger } from "../../logger"
import { OpenCodeUpdateError, type OpenCodeUpdateService } from "../../opencode-update/service"
import { z } from "zod"
import { InstallationBusyError } from "../../opencode-update/installation-lock"

interface RouteDeps {
  service: OpenCodeUpdateService
  logger: Logger
}

function statusCode(error: OpenCodeUpdateError): number {
  if (error.code === "unsupported_binary") return 409
  if (error.code === "binary_unavailable") return 422
  return 502
}

function requestError(error: unknown, fallback: string): { status: number; code: string } {
  if (error instanceof InstallationBusyError) return { status: 409, code: error.code }
  if (error instanceof OpenCodeUpdateError) return { status: statusCode(error), code: error.code }
  return { status: 500, code: fallback }
}

export function registerOpenCodeUpdateRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.post("/api/opencode/service", async (request, reply) => {
    const parsed = z.object({ restart: z.boolean().default(false), reload: z.boolean().default(false) }).strict()
      .refine(value => !(value.restart && value.reload)).safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: "invalid_service_action" })
    try { return await (parsed.data.reload ? deps.service.reload() : deps.service.start(parsed.data.restart)) }
    catch (error) {
      deps.logger.warn({ err: error }, "Failed to activate OpenCode")
      return reply.code(502).send({ error: "service_activation_failed" })
    }
  })
  app.get("/api/opencode/update", async (_request, reply) => {
    try {
      return await deps.service.getStatus()
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to check OpenCode update status")
      const failure = requestError(error, "update_check_failed")
      reply.code(failure.status)
      return { error: failure.code }
    }
  })

  app.post("/api/opencode/update", async (_request, reply) => {
    try {
      return await deps.service.upgrade()
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to update OpenCode")
      const failure = requestError(error, "upgrade_failed")
      reply.code(failure.status)
      return { success: false, error: failure.code }
    }
  })
}
