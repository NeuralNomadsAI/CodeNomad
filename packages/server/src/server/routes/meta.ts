import { FastifyInstance } from "fastify"
import { ServerMeta } from "../../api-types"


interface RouteDeps {
  serverMeta: ServerMeta
}
export function registerMetaRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/meta", async () => buildMetaResponse(deps.serverMeta))
}
function buildMetaResponse(meta: ServerMeta): ServerMeta {
  const localPort = resolveLocalPort(meta)

  return {
    ...meta,
    localPort,
  }
}

function resolveLocalPort(meta: ServerMeta): number {
  if (Number.isInteger(meta.localPort) && meta.localPort > 0) {
    return meta.localPort
  }
  try {
    const parsed = new URL(meta.localUrl)
    const port = Number(parsed.port)
    return Number.isInteger(port) && port > 0 ? port : 0
  } catch {
    return 0
  }
}
