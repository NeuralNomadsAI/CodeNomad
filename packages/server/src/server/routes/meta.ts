import { FastifyInstance } from "fastify"
import { ServerMeta } from "../../api-types"
import { resolveNetworkAddresses } from "../network-addresses"

interface RouteDeps {
  serverMeta: ServerMeta
}

export function registerMetaRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/meta", async () => buildMetaResponse(deps.serverMeta))
}

function buildMetaResponse(meta: ServerMeta): ServerMeta {
  const localPort = resolveLocalPort(meta)
  const remote = resolveRemote(meta)
  const addresses = remote && remote.port > 0 ? resolveNetworkAddresses({ host: meta.host, protocol: remote.protocol, port: remote.port }) : []

  return {
    ...meta,
    localPort,
    remotePort: remote?.port,
    listeningMode: meta.host === "0.0.0.0" || !isLoopbackHost(meta.host) ? "all" : "local",
    addresses,
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

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.startsWith("127.")
}

// NetworkAddress shape is resolved in ../network-addresses
