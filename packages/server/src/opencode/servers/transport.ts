import { Agent, fetch as undiciFetch } from "undici"
import { ExplicitEndpointError, normalizeExplicitOrigin, resolveExplicitAddress, type ResolveAddresses } from "./endpoint"

const requestDenied = /^(origin|authorization|proxy-authorization|cookie|cookie2|host|forwarded|x-forwarded-.*|x-real-ip|connection|keep-alive|proxy-connection|te|trailer|transfer-encoding|upgrade)$/i
const responseDenied = /^(authorization|proxy-authorization|cookie|set-cookie2?|www-authenticate|proxy-authenticate|authentication-info|proxy-authentication-info|server|x-powered-by|connection|keep-alive|proxy-connection|te|trailer|transfer-encoding|upgrade)$/i

function filterHeaders(input: Headers, denied: RegExp): Headers {
  const headers = new Headers(input)
  for (const name of (input.get("connection") ?? "").split(",")) if (name.trim()) headers.delete(name.trim())
  for (const name of [...headers.keys()]) if (denied.test(name)) headers.delete(name)
  return headers
}

function diagnostic(error: unknown, signal: AbortSignal): ExplicitEndpointError {
  if (error instanceof ExplicitEndpointError) return error
  if (signal.aborted) return new ExplicitEndpointError("timeout")
  const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code ?? ""
  return new ExplicitEndpointError(/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) ? "tls" : "network")
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ExplicitEndpointError("timeout"))
    if (signal.aborted) { abort(); return }
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/** Internal backend seam. All explicit HTTP dispatches, including probes, use this fetch. */
export function createExplicitTransport(options: {
  origin: string
  credentials?: { username: string; password: string }
  signal?: AbortSignal
  ca?: string
  skipTlsVerify?: boolean
  /** Backend-held cookies, set after filtering. */
  headers?: () => Record<string, string>
  /** Receives Set-Cookie values; they never reach the returned response. */
  onSetCookie?: (values: string[]) => void
  /** Explicit server protocols must not carry Fetch's automatically generated browser metadata. */
  omitFetchMetadata?: boolean
}, resolve?: ResolveAddresses) {
  const origin = normalizeExplicitOrigin(options.origin)
  if (options.ca !== undefined) throw new ExplicitEndpointError("custom_ca_unsupported")
  // Copy secret inputs; subsequent caller mutation cannot retarget credentials.
  const credentials = options.credentials ? { ...options.credentials } : undefined
  if (credentials?.username.includes(":")) throw new ExplicitEndpointError("invalid_origin")
  const lifetime = options.signal ?? new AbortController().signal
  const fetch: typeof globalThis.fetch = async (input, init) => {
    let agent: Agent | undefined
    let signal = lifetime
    try {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== origin || url.username || url.password || url.hash) throw new ExplicitEndpointError("invalid_origin")
      signal = AbortSignal.any([lifetime, request.signal])
      signal.throwIfAborted()
      const address = await abortable(resolveExplicitAddress(origin, resolve), signal)
      signal.throwIfAborted()
      agent = new Agent({ connect: {
        rejectUnauthorized: !options.skipTlsVerify,
        // No second DNS query: TLS still verifies the original hostname and sends its SNI.
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: address.address, family: address.family }] as never)
          else callback(null, address.address, address.family)
        },
      } })
      const dispatcher = options.omitFetchMetadata ? agent.compose(dispatch => (options, handler) => {
        const input = options.headers
        // Fetch supplies an object; also accept the dispatch API's flat pair form.
        const entries = Array.isArray(input) ? input.flatMap((name, i) => i % 2 ? [] : [[name, input[i + 1]]]) : Object.entries(input ?? {})
        const headers = Object.fromEntries(entries.filter(([name]) => !/^sec-fetch-/i.test(name!)))
        return dispatch({ ...options, headers }, handler)
      }) : agent
      const headers = filterHeaders(request.headers, requestDenied)
      if (credentials) headers.set("authorization", `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`)
      for (const [name, value] of Object.entries(options.headers?.() ?? {})) if (name.toLowerCase() !== "origin") headers.set(name, value)
      const response = await undiciFetch(url, {
        method: request.method, headers: Object.fromEntries(headers),
        body: request.body as never, duplex: "half", signal, redirect: "manual", dispatcher,
      })
      signal.throwIfAborted()
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        void response.body?.cancel().catch(() => {})
        throw new ExplicitEndpointError("redirect")
      }
      const cookies = response.headers.getSetCookie()
      if (response.ok && cookies.length) options.onSetCookie?.(cookies)
      const responseHeaders = filterHeaders(new Headers([...response.headers]), responseDenied)
      const owner = agent
      if (!response.body) { void owner.destroy().catch(() => {}); return new Response(null, { status: response.status, headers: responseHeaders }) }
      const reader = response.body.getReader()
      let cleaned = false
      const cleanup = () => { if (cleaned) return; cleaned = true; reader.releaseLock(); void owner.destroy().catch(() => {}) }
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            signal.throwIfAborted()
            if (chunk.done) { controller.close(); cleanup() }
            else controller.enqueue(chunk.value)
          } catch (error) { controller.error(diagnostic(error, signal)); cleanup() }
        },
        cancel() { void reader.cancel().catch(() => {}); cleanup() },
      })
      return new Response(body, { status: response.status, headers: responseHeaders })
    } catch (error) { void agent?.destroy().catch(() => {}); throw diagnostic(error, signal) }
  }

  return { origin, fetch }
}
