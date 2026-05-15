import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"

import type { OpenCodeSessionRepairService } from "../../opencode/session-repair"

interface RouteDeps {
  repairService: OpenCodeSessionRepairService
}

const RepairRequestSchema = z.object({
  mode: z.enum(["important", "normalize"]),
})

export function registerOpenCodeSessionRepairRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/opencode/session-repair/analyze", async (_request, reply) => {
    try {
      return await deps.repairService.analyze()
    } catch (error) {
      return handleError(error, reply)
    }
  })

  app.post("/api/opencode/session-repair/execute", async (request, reply) => {
    try {
      const body = RepairRequestSchema.parse(request.body ?? {})
      return await deps.repairService.repair(body.mode)
    } catch (error) {
      return handleError(error, reply)
    }
  })
}

function handleError(error: unknown, reply: FastifyReply) {
  reply.code(400)
  return { error: error instanceof Error ? error.message : "Unable to repair OpenCode sessions" }
}
