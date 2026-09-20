import { Service, type Endpoint } from "@opencode/client/service"
import { contractProfile, runtimeIdentity } from "./runtime"
import { assertSupportedOpenCode } from "../runtime-support"
import { negotiateRuntime } from "./negotiate"
import { applyLocationContext, LOCATION_CONTEXT_HEADER } from "./location"

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
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
    if (identity) assertSupportedOpenCode(identity.version)
    if (profile === "legacy") throw new Error("Unsupported OpenCode runtime contract")
    if (profile !== "unknown") return profile
    negotiation ??= negotiateRuntime(endpoint, fetcher, lifetime).then(value => {
      if (value !== "modern") throw new Error("Unsupported OpenCode runtime contract")
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
    const serverInfo = request.method === "GET" && (originalPath === "/api/info" || originalPath === "/api/status")
    if (serverInfo) {
      // Discovery already selected one authenticated route. The current client
      // uses info; an older renderer may still request status. Never probe here.
      const discovery = identity?.discovery ?? "info"
      url.pathname = `/api/${discovery}`
    }
    if (headers.has(LOCATION_CONTEXT_HEADER)) {
      const text = request.body ? await request.text() : undefined
      let body: unknown = text ? JSON.parse(text) : undefined
      body = applyLocationContext(url, request.method, body, headers, profile)
      if (body !== undefined && !object(body)) throw new Error("Invalid OpenCode request body")
      options.body = body === undefined ? undefined : JSON.stringify(body)
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
    return response
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
