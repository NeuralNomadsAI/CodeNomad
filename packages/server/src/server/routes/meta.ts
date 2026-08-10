import { FastifyInstance } from "fastify"
import { ServerMeta } from "../../api-types"
import { isLoopbackHost, isWildcardHost } from "../network-host"
 

interface RouteDeps {
  serverMeta: ServerMeta
}

export function registerMetaRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/meta", async () => buildMetaResponse(deps.serverMeta))
}

function buildMetaResponse(meta: ServerMeta): ServerMeta {
  const localPort = resolveLocalPort(meta)
  const remote = resolveRemote(meta)

  return {
    ...meta,
    localPort,
    remotePort: remote?.port,
    listeningMode: isWildcardHost(meta.host) || !isLoopbackHost(meta.host) ? "all" : "local",
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

function resolveRemote(meta: ServerMeta): { protocol: "http" | "https"; port: number } | null {
  if (!meta.remoteUrl) {
    return null
  }
  try {
    const parsed = new URL(meta.remoteUrl)
    const protocol = parsed.protocol === "https:" ? "https" : "http"
    const port = Number(parsed.port)
    return { protocol, port: Number.isInteger(port) && port > 0 ? port : 0 }
  } catch {
    return null
  }
}

// NetworkAddress shape is resolved in ../network-addresses
