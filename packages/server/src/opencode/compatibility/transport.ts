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

export function createRuntimeTransport(endpoint: Endpoint, fetcher: typeof fetch = globalThis.fetch, lifetime = new AbortController().signal,
  contract: "local" | "explicit-e1" = "local") {
  const identity = runtimeIdentity(endpoint)
  let profile = contract === "explicit-e1" ? "unknown" as const : contractProfile(identity)
  let negotiation: Promise<"modern"> | undefined
  const resolveProfile = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    lifetime.throwIfAborted()
    if (identity && contract === "local") assertSupportedOpenCode(identity.version)
    if (profile !== "unknown") return profile
    negotiation ??= negotiateRuntime(endpoint, fetcher, lifetime, contract).then(value => {
      lifetime.throwIfAborted()
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
    const signal = AbortSignal.any([request.signal, lifetime])
    const options: RequestInit = { method: request.method, headers, signal, redirect: "error" }
    const bytes = request.body ? await readBody(request.body, signal) : undefined
    if (headers.has(LOCATION_CONTEXT_HEADER)) {
      const text = bytes ? new TextDecoder().decode(bytes) : undefined
      let body: unknown = text ? JSON.parse(text) : undefined
      body = applyLocationContext(url, request.method, body, headers)
      if (body !== undefined && !object(body)) throw new Error("Invalid OpenCode request body")
      options.body = body === undefined ? undefined : JSON.stringify(body)
      headers.delete("content-length")
      if (options.body === undefined) headers.delete("content-type")
    } else if (bytes) {
      options.body = bytes
    }
    signal.throwIfAborted()
    const response = await fetcher(url, options)
    if (lifetime.aborted) { await response.body?.cancel().catch(() => {}); lifetime.throwIfAborted() }
    if (!response.ok && !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel()
      return Response.json({
        _tag: "OpenCodeContractError", message: `OpenCode ${identity?.version ?? profile}: ${request.method} ${url.pathname} returned HTTP ${response.status}`,
        status: response.status, profile, method: request.method, path: url.pathname,
      }, { status: response.status })
    }
    return response
  }
  return { fetch: adaptedFetch, profile: resolveProfile }
}

async function readBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<ArrayBuffer> {
  const reader = body.getReader()
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    signal.throwIfAborted()
    while (true) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array)) throw new TypeError("OpenCode request body must contain bytes")
      chunks.push(chunk.value)
      length += chunk.value.byteLength
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes.buffer
  } catch (error) { abort(); throw error }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock() }
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
