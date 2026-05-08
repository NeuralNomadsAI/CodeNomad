import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { SshConnectionBootstrapResponse } from "../../api-types"
import type { Logger } from "../../logger"
import type { SshConnectionSessionManager } from "../ssh-connections"

interface RouteDeps {
  logger: Logger
  sshConnectionSessionManager: SshConnectionSessionManager
}

const SshConnectSchema = z.object({
  connectionProfileId: z.string().trim().optional(),
  name: z.string().trim().optional(),
  host: z.string().trim().min(1),
  port: z.number().int().positive().max(65535).optional(),
  username: z.string().trim().optional(),
  remotePath: z.string().trim().optional(),
  remoteServerPort: z.number().int().positive().max(65535).optional(),
  bootstrapScript: z.string().optional(),
})

export function registerRemoteConnectionRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.post(
    "/api/remote-connections/ssh/connect",
    async (request, reply): Promise<SshConnectionBootstrapResponse | { error: string }> => {
      try {
        const body = SshConnectSchema.parse(request.body ?? {})
        reply.code(201)
        return await deps.sshConnectionSessionManager.connect(body)
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to establish SSH remote connection")
        reply.code(400)
        return { error: error instanceof Error ? error.message : "Failed to establish SSH remote connection" }
      }
    },
  )

  app.delete<{ Params: { id: string } }>("/api/remote-connections/ssh/:id", async (request, reply) => {
    await deps.sshConnectionSessionManager.disposeByProfileId(request.params.id)
    reply.code(204)
    return undefined
  })
}
