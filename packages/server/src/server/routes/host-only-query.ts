import type { FastifyReply, FastifyRequest } from "fastify"
import type { ServerCapability } from "../../opencode/servers/capabilities"

/** Host mutations have no query scope; never discard a caller's target intent. */
export function hostOnlyQuery(capability: ServerCapability) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (Object.keys(request.query ?? {}).length) {
      return reply.code(403).send({
        error: "explicit_capability_unavailable", code: "explicit_capability_unavailable",
        capability, reason: { code: "localOnly" },
      })
    }
  }
}
