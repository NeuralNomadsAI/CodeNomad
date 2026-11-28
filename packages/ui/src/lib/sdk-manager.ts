import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { backgroundReads } from "./background-read-queue"
import { authenticatedFetch, localHttp } from "./auth-recovery"
import { resolveBackendUrl, type BackendHttp } from "./backend-transport"
import { prioritizedRead } from "./prioritized-read"
import { backendEvents } from "./backend-events"
import { parseInstanceKey } from "./backend-identity"
import { SESSION_ENVIRONMENT_FAILED_ERROR_CODE } from "../../../server/src/api-types"
import { DEFERRED_MEDIA_HEADER, DEFERRED_MEDIA_VALUE } from "../../../server/src/opencode/session-media-contract"
import { SESSION_LOCATED_ELSEWHERE_REASON, SESSION_PLACEMENT_HEADER } from "../../../server/src/opencode/session-access-contract"

/** OpenCode clients of one backend, reached through its workspace instance proxy. */
export class SDKManager {
  private clients = new Map<string, OpenCodeClient>()

  constructor(private readonly backend: Pick<BackendHttp, "url" | "fetch"> = {
    fetch: localHttp.fetch,
    url: path => resolveBackendUrl(localHttp.baseUrl, path, "append-trimmed"),
  }) {}

  private key(instanceId: string, proxyPath: string): string {
    return `${instanceId}:${normalizeProxyPath(proxyPath)}`
  }

  createClient(instanceId: string, proxyPath: string, isForeground: () => boolean = () => false): OpenCodeClient {
    const key = this.key(instanceId, proxyPath)
    const existing = this.clients.get(key)
    if (existing) {
      return existing
    }

    const baseUrl = this.backend.url(`${normalizeProxyPath(proxyPath)}/`)
    const client = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl, isForeground, this.backend.fetch, instanceId) })

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

export function buildInstanceBaseUrl(proxyPath: string, apiBase = localHttp.baseUrl): string {
  const normalized = normalizeProxyPath(proxyPath)
  return resolveBackendUrl(apiBase, `${normalized}/`, "append-trimmed")
}

export function createInstanceFetch(baseUrl: string, isForeground: () => boolean = () => false, fetcher: typeof fetch = authenticatedFetch, instanceId?: string): typeof globalThis.fetch {
  return (input, init) => {
    const parents = [init?.signal, input instanceof Request ? input.signal : undefined].filter((signal): signal is AbortSignal => Boolean(signal))
    const parent = parents.length ? AbortSignal.any(parents) : new AbortController().signal
    // Standalone clients are client-owned; UI operations already carry their
    // admission signal. Bind an active stream too without starting one here.
    const attachment = instanceId === undefined ? undefined : backendEvents.signal(parseInstanceKey(instanceId).backendId)
    const signal = attachment ? AbortSignal.any([attachment, parent]) : parent
    const requestUrl = new URL(input instanceof Request ? input.url : input)
    const basePath = new URL(baseUrl, requestUrl).pathname.replace(/\/+$/, "") + "/"
    // The pinned client preserves baseUrl's proxy prefix. Strip it only for
    // scheduling decisions; forwarding must retain the generated URL unchanged.
    const apiPath = requestUrl.pathname.startsWith(basePath)
      ? `/${requestUrl.pathname.slice(basePath.length)}` : requestUrl.pathname
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const parentSessionId = parentSessionReadId(input, init, method, apiPath)
    // Transcript pages: CodeNomad defers their large tool images to session-media paths.
    const requestInit = method === "GET" && /^\/api\/session\/[^/]+\/message\/?$/.test(apiPath) ? withDeferredMedia(input, init)
      : parentSessionId ? withoutHeader(input, init, PARENT_SESSION_READ_HEADER) : init
    const read = async () => {
      signal.throwIfAborted()
      const response = await fetcher(input, {
        ...requestInit,
        credentials: init?.credentials ?? "include",
        signal,
      })
      signal.throwIfAborted()
      if (parentSessionId && response.status === 403) {
        const body = await response.clone().json().catch(() => undefined)
        signal.throwIfAborted()
        // Parent and restore reads reconcile a session located elsewhere as absent.
        if (body?.reason === SESSION_LOCATED_ELSEWHERE_REASON) {
          return Response.json({ _tag: "SessionNotFoundError", sessionID: parentSessionId, message: "Session not found", reason: body.reason }, { status: 404 })
        }
      }
      if (response.status === 426) {
        const { reportOpenCodeSetupRequired } = await import("../stores/opencode-setup")
        signal.throwIfAborted()
        reportOpenCodeSetupRequired()
      }
      if (response.status === 502) {
        const body = await response.clone().json().catch(() => undefined)
        signal.throwIfAborted()
        if (body?.error === SESSION_ENVIRONMENT_FAILED_ERROR_CODE) {
          const { tGlobal } = await import("./i18n")
          signal.throwIfAborted()
          throw new Error(tGlobal("envEditor.applyFailed"))
        }
        if (body?.error === "PROVIDER_ACCOUNT_SELECTION_FAILED") {
          const { tGlobal } = await import("./i18n")
          signal.throwIfAborted()
          throw new Error(tGlobal("settings.accounts.error"))
        }
      }
      return response
    }
    // Project identity gates the visible cross-worktree session list. Promote
    // this dependency with selection rather than leaving it behind Git scans.
    if (method === "GET" && /^\/api\/location\/?$/.test(apiPath)) {
      return prioritizedRead(isForeground, signal, read)
    }
    // Catalogues from every restored project used to consume all HTTP/1.1
    // connections before the saved session/message reads could even dispatch.
    // Share the secondary budget with inventory scans, including reconnects.
    if (method === "GET" && /^\/api\/(?:project|location|agent(?:\/[^/]+)?|provider|model(?:\/default)?|command|shell|session\/active)\/?$/.test(apiPath)) {
      return backgroundReads.run(signal, read)
    }
    return read()
  }
}

export function withDeferredMedia(input: RequestInfo | URL, init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set(DEFERRED_MEDIA_HEADER, DEFERRED_MEDIA_VALUE)
  return { ...init, headers }
}

/** Client-side opt-in for parent or restore reads (never sent). Only a typed
 * workspace departure becomes a missing session, retaining its reason. */
const PARENT_SESSION_READ_HEADER = "x-codenomad-parent-read"
export const parentSessionReadHeaders = { [PARENT_SESSION_READ_HEADER]: "1" } as const
export const workspaceSessionPlacementHeaders = { ...parentSessionReadHeaders, [SESSION_PLACEMENT_HEADER]: "1" } as const

function parentSessionReadId(input: RequestInfo | URL, init: RequestInit | undefined, method: string, apiPath: string): string | undefined {
  if (method !== "GET") return undefined
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  if (!headers.has(PARENT_SESSION_READ_HEADER)) return undefined
  const match = /^\/api\/session\/([^/]+)\/?$/.exec(apiPath)
  return match ? decodeURIComponent(match[1]!) : undefined
}

function withoutHeader(input: RequestInfo | URL, init: RequestInit | undefined, name: string): RequestInit {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.delete(name)
  return { ...init, headers }
}

function normalizeProxyPath(proxyPath: string): string {
  const withLeading = proxyPath.startsWith("/") ? proxyPath : `/${proxyPath}`
  return withLeading.replace(/\/+/g, "/").replace(/\/+$/, "")
}

export const sdkManager = new SDKManager()
