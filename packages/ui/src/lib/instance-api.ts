import type { Instance } from "../types/instance"
import type { McpServerConfig } from "../stores/preferences"
import { CODENOMAD_API_BASE } from "./api-client"

function normalizeProxyPath(proxyPath: string): string {
  const withLeading = proxyPath.startsWith("/") ? proxyPath : `/${proxyPath}`
  return withLeading.replace(/\/+/g, "/").replace(/\/+$/, "")
}

function buildInstanceBaseUrl(proxyPath: string): string {
  const normalized = normalizeProxyPath(proxyPath)
  const base = CODENOMAD_API_BASE.replace(/\/+$/, "")
  return `${base}${normalized}`
}

async function requestInstance<T>(instance: Instance, path: string, init?: RequestInit): Promise<T> {
  const url = `${buildInstanceBaseUrl(instance.proxyPath)}${path}`
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Instance request failed (${response.status})`)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

async function upsertMcp(instance: Instance, name: string, config: McpServerConfig) {
  // opencode server: POST /mcp { name, config }
  return requestInstance<Record<string, unknown>>(instance, "/mcp", {
    method: "POST",
    body: JSON.stringify({ name, config }),
  })
}

async function connectMcp(instance: Instance, name: string) {
  // Prefer the SDK method if present.
  if (instance.client?.mcp?.connect) {
    await instance.client.mcp.connect({ path: { name } })
    return
  }
  await requestInstance(instance, `/mcp/${encodeURIComponent(name)}/connect`, { method: "POST" })
}

async function disconnectMcp(instance: Instance, name: string) {
  if (instance.client?.mcp?.disconnect) {
    await instance.client.mcp.disconnect({ path: { name } })
    return
  }
  await requestInstance(instance, `/mcp/${encodeURIComponent(name)}/disconnect`, { method: "POST" })
}

export const instanceApi = {
  upsertMcp,
  connectMcp,
  disconnectMcp,
}
