import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { CODENOMAD_API_BASE } from "./api-client"

class SDKManager {
  private clients = new Map<string, OpencodeClient>()

  createClient(instanceId: string, proxyPath: string): OpencodeClient {
    const existing = this.clients.get(instanceId)
    if (existing) {
      return existing
    }

    const baseUrl = buildInstanceBaseUrl(proxyPath)
    const client = createOpencodeClient({ baseUrl })

    this.clients.set(instanceId, client)

    return client
  }

  getClient(instanceId: string): OpencodeClient | null {
    return this.clients.get(instanceId) ?? null
  }

  destroyClient(instanceId: string): void {
    this.clients.delete(instanceId)
  }

  destroyAll(): void {
    this.clients.clear()
  }
}

export type { OpencodeClient }

function buildInstanceBaseUrl(proxyPath: string): string {
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
