import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { CODENOMAD_API_BASE } from "./api-client"
import { backgroundReads } from "./background-read-queue"
import { SESSION_ENVIRONMENT_FAILED_ERROR_CODE } from "../../../server/src/api-types"

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

export function createInstanceFetch(baseUrl: string): typeof globalThis.fetch {
  return (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : input)
    const relativeUrl = `${requestUrl.pathname.replace(/^\/+/, "")}${requestUrl.search}`
    const read = async () => {
      const response = await globalThis.fetch(new URL(relativeUrl, baseUrl), {
        ...init,
        credentials: init?.credentials ?? "include",
      })
      if (response.status === 426) {
        const { reportOpenCodeSetupRequired } = await import("../stores/opencode-setup")
        reportOpenCodeSetupRequired()
      }
      if (response.status === 502) {
        const body = await response.clone().json().catch(() => undefined)
        if (body?.error === SESSION_ENVIRONMENT_FAILED_ERROR_CODE) {
          const { tGlobal } = await import("./i18n")
          throw new Error(tGlobal("envEditor.applyFailed"))
        }
      }
      return response
    }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    // Catalogues from every restored project used to consume all HTTP/1.1
    // connections before the saved session/message reads could even dispatch.
    // Share the secondary budget with inventory scans, including reconnects.
    if (method === "GET" && /^\/api\/(?:project|location|agent(?:\/[^/]+)?|provider|model(?:\/default)?|command|shell|session\/active)\/?$/.test(requestUrl.pathname)) {
      return backgroundReads.run(init?.signal ?? (input instanceof Request ? input.signal : new AbortController().signal), read)
    }
    return read()
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
