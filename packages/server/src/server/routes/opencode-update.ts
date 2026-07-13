import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { Logger } from "../../logger"
import { OpenCodeUpdateError, type OpenCodeUpdateService } from "../../opencode-update/service"

interface RouteDeps {
  service: OpenCodeUpdateService
  logger: Logger
}

const BinaryQuerySchema = z.object({ binary: z.string().trim().min(1).optional() })
const BinaryBodySchema = z.object({ binary: z.string().trim().min(1).optional() })

function statusCode(error: OpenCodeUpdateError): number {
  if (error.code === "no_ready_instance") return 409
  if (error.code === "binary_unavailable") return 422
  return 502
}

function requestError(error: unknown, fallback: string): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "invalid_request" }
  if (error instanceof OpenCodeUpdateError) return { status: statusCode(error), code: error.code }
  return { status: 500, code: fallback }
}

export function registerOpenCodeUpdateRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/opencode/update", async (request, reply) => {
    try {
      const query = BinaryQuerySchema.parse(request.query ?? {})
      return await deps.service.getStatus(query.binary)
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to check OpenCode update status")
      const failure = requestError(error, "update_check_failed")
      reply.code(failure.status)
      return { error: failure.code }
    }
  })

  app.post("/api/opencode/update", async (request, reply) => {
    try {
      const body = BinaryBodySchema.parse(request.body ?? {})
      return await deps.service.upgrade(body.binary)
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to update OpenCode")
      const failure = requestError(error, "upgrade_failed")
      reply.code(failure.status)
      return { success: false, error: failure.code }
    }
  })
}
