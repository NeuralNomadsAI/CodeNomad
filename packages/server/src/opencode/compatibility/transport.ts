import { Service, type Endpoint } from "@opencode/client/service"
import { contractProfile, runtimeIdentity } from "./runtime"
import { legacyRequest } from "./requests"
import { negotiateRuntime } from "./negotiate"
import { applyLocationContext, LOCATION_CONTEXT_HEADER } from "./location"

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeInbox(value: unknown): unknown {
  if (!object(value)) throw new Error("Invalid native inbox item")
  if (object(value.time) && typeof value.time.created === "number") return value
  if (typeof value.timeCreated !== "number" || !Number.isFinite(value.timeCreated)) {
    throw new Error("Invalid native inbox creation time")
  }
  const { timeCreated, ...rest } = value
  return { ...rest, time: { created: timeCreated } }
}

// Both the server's generated client and the authorized browser proxy use this
// transport. No error classification here retries a mutation.
export function createRuntimeFetch(endpoint: Endpoint, fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  return createRuntimeTransport(endpoint, fetcher).fetch
}

export function createRuntimeTransport(endpoint: Endpoint, fetcher: typeof fetch = globalThis.fetch, lifetime = new AbortController().signal) {
  const identity = runtimeIdentity(endpoint)
  let profile = contractProfile(identity)
  let negotiation: Promise<"modern" | "legacy"> | undefined
  const resolveProfile = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    lifetime.throwIfAborted()
    if (profile !== "unknown") return profile
    negotiation ??= negotiateRuntime(endpoint, fetcher, lifetime).then(value => {
      profile = value
      return value
    }).catch(error => { negotiation = undefined; throw error })
    return awaitLocal(negotiation, signal)
  }
  const adaptedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== new URL(endpoint.url).origin) throw new Error("OpenCode transport origin mismatch")
    const profile = await resolveProfile(request.signal)
    const headers = new Headers(request.headers)
    for (const [name, value] of Object.entries(Service.headers(endpoint) ?? {})) headers.set(name, value)
    // Credentialed native requests must never follow a redirect to another host.
    const options: RequestInit = { method: request.method, headers, signal: AbortSignal.any([request.signal, lifetime]), redirect: "error" }
    const originalPath = url.pathname
    if (originalPath === "/api/status" && request.method === "GET" && identity?.discovery === "info") {
      url.pathname = "/api/info"
    }
    if (profile === "legacy" || headers.has(LOCATION_CONTEXT_HEADER)) {
      const text = request.body ? await request.text() : undefined
      let body: unknown = text ? JSON.parse(text) : undefined
      body = applyLocationContext(url, request.method, body, headers, profile)
      if (body !== undefined && !object(body)) throw new Error("Invalid OpenCode request body")
      const translated = profile === "legacy" ? legacyRequest(url, request.method, body) : { method: request.method, body }
      options.method = translated.method
      options.body = translated.body === undefined ? undefined : JSON.stringify(translated.body)
      headers.delete("content-length")
      if (options.body === undefined) headers.delete("content-type")
    } else if (request.body) {
      options.body = await request.arrayBuffer()
    }
    const response = await fetcher(url, options)
    if (!response.ok && !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel()
      return Response.json({
        _tag: "OpenCodeContractError", message: `OpenCode ${identity?.version ?? profile}: ${request.method} ${originalPath} returned HTTP ${response.status}`,
        status: response.status, profile, method: request.method, path: originalPath,
      }, { status: response.status })
    }
    if (profile === "legacy" && response.ok && originalPath === "/api/status") {
      const health = await response.json() as { version: string; pid: number }
      return Response.json({ version: health.version, pid: health.pid, urls: [endpoint.url] })
    }
    if (profile !== "legacy" || !response.ok || !/^\/api\/session\/[^/]+\/(?:inbox|prompt|synthetic|compact)$/.test(originalPath)
      || response.status === 204) return response
    const value: unknown = await response.json()
    if (!object(value)) throw new Error("Invalid native inbox response")
    const normalized = { ...value, data: Array.isArray(value.data) ? value.data.map(normalizeInbox) : normalizeInbox(value.data) }
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete("content-length")
    responseHeaders.delete("content-encoding")
    return new Response(JSON.stringify(normalized), { status: response.status, headers: responseHeaders })
  }
  return { fetch: adaptedFetch, profile: resolveProfile }
}

// A cancelled subscriber must not cancel the connection's negotiation or wait
// for another subscriber's request to finish before observing its own abort.
function awaitLocal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason) }
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener("abort", abort, { once: true })
    pending.then(value => { signal.removeEventListener("abort", abort); resolve(value) }, error => {
      signal.removeEventListener("abort", abort); reject(error)
    })
  })
}
