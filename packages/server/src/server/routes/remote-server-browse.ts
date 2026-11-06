import type { FastifyInstance } from "fastify"
import { isLocalRequest } from "../../remote-control/request-origin"
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
        const origin = request.headers.origin
        if (!isLocalRequest(request) || !origin || origin === "null" || !deps.getSelfOrigins().has(origin)) {
          return reply.code(403).send({ error: "auth" })
        }
        reply.header("Cache-Control", "no-store")
      },
    }, async (request, reply) => {
      try {
        const id = request.params.id
        if (!id || id.length > 256) return reply.code(404).send({ error: "unknown_server" })
        if (action === "forget") return await deps.manager.forget(id)
        if (action === "connect") return await deps.manager.connect(id, ConnectBody.parse(request.body ?? {}))
        return await deps.manager.browse(id, BrowseBody.parse(request.body ?? {}))
      } catch (error) {
        const code = endpointErrorCode(error)
        return reply.code(code === "unknown_server" ? 404 : ["needs_credentials", "auth", "pairing_unavailable", "pairing_expired", "pairing_rate_limited"].includes(code) ? 409 : 502).send({ error: code })
      }
    })
  }
}
