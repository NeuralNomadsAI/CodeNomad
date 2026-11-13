import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { RemotePreviewCapabilities } from "../../codenomad-servers/preview-capabilities"
import type { RemoteServerBrowseManager } from "../../codenomad-servers/browse-manager"
import { guardLocalBackendCaller } from "../../codenomad-servers/local-caller"
import { isRelayAuthority, RELAY_AUTHORITY_HEADER } from "../../codenomad-servers/relay-authority"
import type { Logger } from "../../logger"
import { framesNoBody } from "../bodiless-request"

const Body = z.object({ sessionId: z.string().trim().min(1).max(4096), url: z.string().trim().min(1).max(2048) }).strict()
function proof(request: FastifyRequest): string {
  const value = request.headers[RELAY_AUTHORITY_HEADER]
  const count = request.raw.rawHeaders.filter((name, i) => i % 2 === 0 && name.toLowerCase() === RELAY_AUTHORITY_HEADER).length
  if (count !== 1 || !isRelayAuthority(value)) throw new Error("Invalid authority")
  return value
}

export function registerRemotePreviewCapabilityRoutes(app: FastifyInstance, deps: {
  manager: RemoteServerBrowseManager; logger: Logger; getSelfOrigins(): Set<string>
}) {
  const previews = new RemotePreviewCapabilities(deps.manager, deps.logger)
  app.addHook("preClose", () => previews.close())
  void app.register(async scope => {
    const parse = scope.getDefaultJsonParser("error", "error")
    scope.removeContentTypeParser("application/json")
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
      if (framesNoBody(request)) done(null, undefined)
      else parse(request, body.toString(), done)
    })
    scope.addHook("onRequest", async (request, reply) => { guardLocalBackendCaller(request, reply, deps.getSelfOrigins()) })
    scope.post<{ Params: { id: string } }>("/api/backends/:id/preview-capabilities", async (request, reply) => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      reply.raw.once("close", abort)
      try {
        return await previews.create(request.params.id, proof(request), Body.parse(request.body), controller.signal, request.headers.origin)
      } catch { return reply.code(404).send({ error: "unreachable" }) }
      finally { reply.raw.off("close", abort) }
    })
    scope.delete<{ Params: { id: string; capability: string } }>("/api/backends/:id/preview-capabilities/:capability", async (request, reply) => {
      try {
        if (!previews.revoke(request.params.capability, request.params.id, proof(request))) throw new Error("Unknown capability")
        return reply.code(204).send()
      } catch { return reply.code(404).send({ error: "unreachable" }) }
    })
    scope.delete<{ Params: { id: string } }>("/api/backends/:id/preview-capabilities", async (request, reply) => {
      try { previews.detach(request.params.id, proof(request)); return reply.code(204).send() }
      catch { return reply.code(404).send({ error: "unreachable" }) }
    })
  })
}
