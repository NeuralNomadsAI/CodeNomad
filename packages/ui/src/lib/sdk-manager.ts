import { OpenCode, type OpenCodeClient } from "@opencode-ai/client"
import { CODENOMAD_API_BASE } from "./api-client"

class SDKManager {
  private clients = new Map<string, OpenCodeClient>()

  private key(instanceId: string, proxyPath: string): string {
    return `${instanceId}:${normalizeProxyPath(proxyPath)}`
  }

  createClient(instanceId: string, proxyPath: string): OpenCodeClient {
    const key = this.key(instanceId, proxyPath)
    const existing = this.clients.get(key)
    if (existing) {
      return existing
    }

    const baseUrl = buildInstanceBaseUrl(proxyPath)
    const client = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })

    this.clients.set(key, client)

    return client
  }

  destroyClientsForInstance(instanceId: string): void {
    for (const key of Array.from(this.clients.keys())) {
      if (key === instanceId || key.startsWith(`${instanceId}:`)) {
        this.clients.delete(key)
      }
    }
  }
}

export type { OpenCodeClient }

export function buildInstanceBaseUrl(proxyPath: string, apiBase = CODENOMAD_API_BASE): string {
  const normalized = normalizeProxyPath(proxyPath)
  const base = stripTrailingSlashes(apiBase ?? "")
  return `${base}${normalized}/`
}

function createInstanceFetch(baseUrl: string): typeof globalThis.fetch {
  return (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : input)
    const relativeUrl = `${requestUrl.pathname.replace(/^\/+/, "")}${requestUrl.search}`
    return globalThis.fetch(new URL(relativeUrl, baseUrl), {
      ...init,
      credentials: init?.credentials ?? "include",
    })
  }
}

function normalizeProxyPath(proxyPath: string): string {
  const withLeading = proxyPath.startsWith("/") ? proxyPath : `/${proxyPath}`
  return withLeading.replace(/\/+/g, "/").replace(/\/+$/, "")
}

function stripTrailingSlashes(input: string): string {
  return input.replace(/\/+$/, "")
}

export const sdkManager = new SDKManager()
