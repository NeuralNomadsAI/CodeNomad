import { FastifyInstance } from "fastify"
import os from "os"
import { NetworkAddress, ServerMeta } from "../../api-types"

interface RouteDeps {
  serverMeta: ServerMeta
}

export function registerMetaRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/meta", async () => buildMetaResponse(deps.serverMeta))

  // Health check endpoint for monitoring
  app.get("/api/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }))
}

function buildMetaResponse(meta: ServerMeta): ServerMeta {
  const port = resolvePort(meta)
  const addresses = port > 0 ? resolveAddresses(port, meta.host) : []

  return {
    ...meta,
    port,
    listeningMode: meta.host === "0.0.0.0" || !isLoopbackHost(meta.host) ? "all" : "local",
    addresses,
  }
}

function resolvePort(meta: ServerMeta): number {
  if (Number.isInteger(meta.port) && meta.port > 0) {
    return meta.port
  }
  try {
    const parsed = new URL(meta.httpBaseUrl)
    const port = Number(parsed.port)
    return Number.isInteger(port) && port > 0 ? port : 0
  } catch {
    return 0
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.startsWith("127.")
}

function resolveAddresses(port: number, host: string): NetworkAddress[] {
  const interfaces = os.networkInterfaces()
  const seen = new Set<string>()
  const results: NetworkAddress[] = []

  const addAddress = (ip: string, scope: NetworkAddress["scope"]) => {
    if (!ip || ip === "0.0.0.0") return
    const key = `ipv4-${ip}`
    if (seen.has(key)) return
    seen.add(key)
    results.push({ ip, family: "ipv4", scope, url: `http://${ip}:${port}` })
  }

  const normalizeFamily = (value: string | number) => {
    if (typeof value === "string") {
      const lowered = value.toLowerCase()
      if (lowered === "ipv4") {
        return "ipv4" as const
      }
    }
    if (value === 4) return "ipv4" as const
    return null
  }

  if (host === "0.0.0.0") {
    // Enumerate system interfaces (IPv4 only)
    for (const entries of Object.values(interfaces)) {
      if (!entries) continue
      for (const entry of entries) {
        const family = normalizeFamily(entry.family)
        if (!family) continue
        if (!entry.address || entry.address === "0.0.0.0") continue
        const scope: NetworkAddress["scope"] = entry.internal ? "loopback" : "external"
        addAddress(entry.address, scope)
      }
    }
  }

  // Always include loopback address
  addAddress("127.0.0.1", "loopback")

  // Include explicitly configured host if it was IPv4
  if (isIPv4Address(host) && host !== "0.0.0.0") {
    const isLoopback = host.startsWith("127.")
    addAddress(host, isLoopback ? "loopback" : "external")
  }

  const scopeWeight: Record<NetworkAddress["scope"], number> = { external: 0, internal: 1, loopback: 2 }

  return results.sort((a, b) => {
    const scopeDelta = scopeWeight[a.scope] - scopeWeight[b.scope]
    if (scopeDelta !== 0) return scopeDelta
    return a.ip.localeCompare(b.ip)
  })
}

function isIPv4Address(value: string | undefined): value is string {
  if (!value) return false
  const parts = value.split(".")
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (part.length === 0 || part.length > 3) return false
    if (!/^[0-9]+$/.test(part)) return false
    const num = Number(part)
    return Number.isInteger(num) && num >= 0 && num <= 255
  })
}
