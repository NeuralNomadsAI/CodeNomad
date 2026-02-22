import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { CODENOMAD_API_BASE } from "./api-client"

class SDKManager {
  private clients = new Map<string, OpencodeClient>()

  private key(instanceId: string, proxyPath: string): string {
    return `${instanceId}:${normalizeProxyPath(proxyPath)}`
  }

  createClient(instanceId: string, proxyPath: string, _worktreeSlug = "root"): OpencodeClient {
    const key = this.key(instanceId, proxyPath)
    const existing = this.clients.get(key)
    if (existing) {
      return existing
    }

    const baseUrl = buildInstanceBaseUrl(proxyPath)
    const client = createOpencodeClient({ baseUrl })

    this.clients.set(key, client)

    return client
  }

  getClient(instanceId: string, proxyPath: string): OpencodeClient | null {
    return this.clients.get(this.key(instanceId, proxyPath)) ?? null
  }

  destroyClient(instanceId: string, proxyPath: string): void {
    this.clients.delete(this.key(instanceId, proxyPath))
  }

  destroyClientsForInstance(instanceId: string): void {
    for (const key of Array.from(this.clients.keys())) {
      if (key === instanceId || key.startsWith(`${instanceId}:`)) {
        this.clients.delete(key)
      }
    }
  }

  destroyAll(): void {
    this.clients.clear()
  }
}

export type { OpencodeClient }

export function buildInstanceBaseUrl(proxyPath: string): string {
  const normalized = normalizeProxyPath(proxyPath)
  const base = stripTrailingSlashes(CODENOMAD_API_BASE)
  return `${base}${normalized}/`
}

function normalizeProxyPath(proxyPath: string): string {
  const withLeading = proxyPath.startsWith("/") ? proxyPath : `/${proxyPath}`
  return withLeading.replace(/\/+/g, "/").replace(/\/+$/, "")
}

function stripTrailingSlashes(input: string): string {
  return input.replace(/\/+$/, "")
}

export const sdkManager = new SDKManager()
