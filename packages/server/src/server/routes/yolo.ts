import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { AutoAcceptManager } from "../../permissions/auto-accept-manager"
import { WorkspaceCapabilityError } from "../../opencode/servers/capabilities"

interface RouteDeps {
  yoloManager: AutoAcceptManager
}

export function registerYoloRoutes(app: FastifyInstance, deps: RouteDeps) {
  const admit = async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id?: string }).id
    if (!id) return
    try {
      deps.yoloManager.requireCapability(id)
    } catch (error) {
      if (!(error instanceof WorkspaceCapabilityError)) throw error
      return reply.code(403).send({ error: error.code, code: error.code, capability: error.capability, reason: error.reason })
    }
  }
  app.get<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/yolo/sessions/:sessionId",
    { preHandler: admit },
    async (request) => {
      const { id, sessionId } = request.params
      await deps.yoloManager.hydrateInstance(id)
      return { enabled: deps.yoloManager.isEnabled(id, sessionId) }
    },
  )

  app.post<{ Params: { id: string; sessionId: string } }>(
    "/workspaces/:id/yolo/sessions/:sessionId/toggle",
    { preHandler: admit },
    async (request, reply) => {
      const { id, sessionId } = request.params
      const enabled = await deps.yoloManager.toggle(id, sessionId)
      reply.code(200)
      return { enabled }
    },
  )
}
