import type { FastifyInstance } from "fastify"
import { guardLocalBackendCaller } from "../../codenomad-servers/local-caller"
import { BrowseBody, ConnectBody, type RemoteServerBrowseManager } from "../../codenomad-servers/browse-manager"
import { endpointErrorCode } from "../../codenomad-servers/client"

export function registerRemoteServerBrowseRoutes(app: FastifyInstance, deps: {
  manager: RemoteServerBrowseManager
  getSelfOrigins(): Set<string>
}) {
  // This guard is deliberately stricter than CORS and runs before body parsing or secret/network access.
  for (const action of ["browse", "connect", "forget"] as const) {
    app.post<{ Params: { id: string } }>(`/api/remote-servers/:id/${action}`, {
      bodyLimit: 24 * 1024,
      onRequest: async (request, reply) => {
        guardLocalBackendCaller(request, reply, deps.getSelfOrigins())
      },
    }, async (request, reply) => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      reply.raw.once("close", abort)
      try {
        const id = request.params.id
        if (!id || id.length > 256) return reply.code(404).send({ error: "unknown_server" })
        if (action === "forget") return await deps.manager.forget(id)
        if (action === "connect") return await deps.manager.connect(id, ConnectBody.parse(request.body ?? {}), controller.signal)
        return await deps.manager.browse(id, BrowseBody.parse(request.body ?? {}), controller.signal)
      } catch (error) {
        const code = endpointErrorCode(error)
        return reply.code(code === "unknown_server" ? 404 : ["needs_credentials", "auth", "pairing_unavailable", "pairing_expired", "pairing_rate_limited"].includes(code) ? 409 : 502).send({ error: code })
      } finally { reply.raw.off("close", abort) }
    })
  }
}
