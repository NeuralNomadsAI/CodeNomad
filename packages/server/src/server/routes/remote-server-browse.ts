import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { guardLocalBackendCaller } from "../../codenomad-servers/local-caller"
import { BrowseBody, ConnectBody, type RemoteServerBrowseManager } from "../../codenomad-servers/browse-manager"
import { endpointErrorCode } from "../../codenomad-servers/client"
import { listSshHosts } from "../../codenomad-servers/ssh"
import type { BackendCallerGuard } from "../../codenomad-servers/ui-caller"

export function registerRemoteServerBrowseRoutes(app: FastifyInstance, deps: {
  manager: RemoteServerBrowseManager
  getSelfOrigins(): Set<string>
  guardCaller?: BackendCallerGuard
  guardSecret?: (request: FastifyRequest, reply: FastifyReply, body: unknown) => boolean
  principalSignal?: (request: FastifyRequest) => AbortSignal | undefined
}) {
  const guard = deps.guardCaller ?? ((request: FastifyRequest, reply: FastifyReply) => guardLocalBackendCaller(request, reply, deps.getSelfOrigins()))
  app.get("/api/remote-servers/ssh-hosts", {
    onRequest: async (request, reply) => { guard(request, reply) },
  }, async () => ({ hosts: listSshHosts() }))
  // This guard is deliberately stricter than CORS and runs before body parsing or secret/network access.
  for (const action of ["browse", "connect", "forget"] as const) {
    app.post<{ Params: { id: string } }>(`/api/remote-servers/:id/${action}`, {
      bodyLimit: 24 * 1024,
      onRequest: async (request, reply) => {
        guard(request, reply)
      },
    }, async (request, reply) => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      reply.raw.once("close", abort)
      try {
        const principal = deps.principalSignal?.(request)
        const signal = principal ? AbortSignal.any([principal, controller.signal]) : controller.signal
        signal.throwIfAborted()
        const id = request.params.id
        if (!id || id.length > 256) return reply.code(404).send({ error: "unknown_server" })
        let result: unknown
        if (action === "forget") result = await deps.manager.forget(id)
        else if (action === "connect") {
          if (deps.guardSecret?.(request, reply, request.body)) return
          const body = ConnectBody.parse(request.body ?? {})
          result = await deps.manager.connect(id, body, signal)
        }
        else result = await deps.manager.browse(id, BrowseBody.parse(request.body ?? {}), signal, principal !== undefined)
        signal.throwIfAborted()
        return result
      } catch (error) {
        const code = endpointErrorCode(error)
        return reply.code(code === "unknown_server" ? 404 : ["needs_credentials", "auth", "pairing_unavailable", "pairing_expired", "pairing_rate_limited"].includes(code) ? 409 : 502).send({ error: code })
      } finally { reply.raw.off("close", abort) }
    })
  }
}
