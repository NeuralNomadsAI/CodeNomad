import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { CODENOMAD_API_BASE } from "./api-client"
import { getLogger } from "./logger"

const log = getLogger("api")

/**
 * Instrumented fetch wrapper for the SDK client.
 * Logs method, URL, status, and elapsed time (ms) using performance.now()
 * so we can compare WebView2 (Tauri) vs Chromium (Electron) fetch latency.
 */
function createInstrumentedFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // The SDK always passes a Request object, but we handle other forms too
    const request = input instanceof Request ? input : new Request(input, init)
    ;(request as any).timeout = false
    const method = request.method
    const url = request.url
    const t0 = performance.now()
    log.info(`[sdk-fetch] ${method} ${url}`)
    try {
      const response = await fetch(request)
      const elapsed = performance.now() - t0
      log.info(`[sdk-fetch] ${method} ${url} -> ${response.status}`, {
        durationMs: Math.round(elapsed * 100) / 100,
      })
      return response
    } catch (error) {
      const elapsed = performance.now() - t0
      log.info(`[sdk-fetch] ${method} ${url} FAILED`, {
        durationMs: Math.round(elapsed * 100) / 100,
        error,
      })
      throw error
    }
  }) as typeof globalThis.fetch
}

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
    const client = createOpencodeClient({ baseUrl, fetch: createInstrumentedFetch() })

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
