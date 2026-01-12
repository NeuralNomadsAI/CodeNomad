import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"
import { ERA_CODE_API_BASE } from "./api-client"

class SDKManager {
  private clients = new Map<string, OpencodeClient>()

  createClient(instanceId: string, proxyPath: string): OpencodeClient {
    if (this.clients.has(instanceId)) {
      return this.clients.get(instanceId)!
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

function buildInstanceBaseUrl(proxyPath: string): string {
  const normalized = normalizeProxyPath(proxyPath)
  const base = stripTrailingSlashes(ERA_CODE_API_BASE)
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
