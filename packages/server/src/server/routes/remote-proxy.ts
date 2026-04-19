import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { RemoteProxySessionCreateResponse } from "../../api-types"
import type { Logger } from "../../logger"
import type { RemoteProxySessionManager } from "../remote-proxy"

interface RouteDeps {
  logger: Logger
  sessionManager: RemoteProxySessionManager
}

const CreateSessionSchema = z.object({
  baseUrl: z.string().min(1),
  skipTlsVerify: z.boolean().optional(),
})

export function registerRemoteProxyRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.post("/api/remote-proxy/sessions", async (request, reply): Promise<RemoteProxySessionCreateResponse | { error: string }> => {
    try {
      const body = CreateSessionSchema.parse(request.body ?? {})
      const windowUrl = await deps.sessionManager.createSession(body.baseUrl, Boolean(body.skipTlsVerify))
      return { windowUrl }
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to create remote proxy session")
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to create remote proxy session" }
    }
  })
}
