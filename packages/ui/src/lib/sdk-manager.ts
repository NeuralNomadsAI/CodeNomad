import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { CODENOMAD_API_BASE } from "./api-client"

class SDKManager {
  private clients = new Map<string, OpencodeClient>()

  private key(instanceId: string, worktreeSlug: string): string {
    return `${instanceId}:${worktreeSlug || "root"}`
  }

  createClient(instanceId: string, proxyPath: string, worktreeSlug = "root"): OpencodeClient {
    const key = this.key(instanceId, worktreeSlug)
    const existing = this.clients.get(key)
    if (existing) {
      return existing
    }

    const baseUrl = buildInstanceBaseUrl(proxyPath)
    const client = createOpencodeClient({ baseUrl })

    this.clients.set(key, client)

    return client
  }

  getClient(instanceId: string, worktreeSlug = "root"): OpencodeClient | null {
    return this.clients.get(this.key(instanceId, worktreeSlug)) ?? null
  }

  destroyClient(instanceId: string, worktreeSlug = "root"): void {
    this.clients.delete(this.key(instanceId, worktreeSlug))
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
