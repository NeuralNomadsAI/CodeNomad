import { FastifyInstance } from "fastify"
import type { AutoAcceptManager } from "../../permissions/auto-accept-manager"

interface RouteDeps {
  yoloManager: AutoAcceptManager
}

export function registerYoloRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/yolo/sessions/:sessionId",
    async (request) => {
      const { id, sessionId } = request.params
      await deps.yoloManager.hydrateInstance(id)
      return { enabled: deps.yoloManager.isEnabled(id, sessionId) }
    },
  )

  app.post<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/yolo/sessions/:sessionId/toggle",
    async (request, reply) => {
      const { id, sessionId } = request.params
      const enabled = await deps.yoloManager.toggle(id, sessionId)
      reply.code(200)
      return { enabled }
    },
  )
}
