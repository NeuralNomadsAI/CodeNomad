import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { PreviewSession } from "../../api-types"
import type { PreviewManager } from "../../previews/manager"

interface RouteDeps {
  previewManager: PreviewManager
}

const PreviewCreateSchema = z.object({
  sessionId: z.string().trim().min(1),
  url: z.string().trim().min(1),
})

export function registerPreviewRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.post("/api/previews", async (request, reply): Promise<PreviewSession | { error: string }> => {
    try {
      const body = PreviewCreateSchema.parse(request.body ?? {})
      return deps.previewManager.create(body.sessionId, body.url)
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to create preview" }
    }
  })

  app.delete<{ Params: { token: string } }>("/api/previews/:token", async (request, reply) => {
    const removed = deps.previewManager.delete(request.params.token)
    if (!removed) {
      reply.code(404)
      return { error: "Preview not found" }
    }
    reply.code(204)
  })
}
