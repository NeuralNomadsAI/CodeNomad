import { isRelayAuthority, RELAY_AUTHORITY_HEADER, RELAY_AUTHORITY_QUERY, RELAY_BOOTSTRAP } from "../../../server/src/codenomad-servers/relay-authority"
import type { BackendTransport } from "./backend-transport"

/** One candidate can acquire one proof. Revalidation may confirm it, never retarget it. */
export function bindBackendRelayAuthority(transport: BackendTransport, fetcher: typeof fetch = (...args) => fetch(...args)) {
  let proof: string | undefined
  const prefix = transport.url("/")
  function owned(value: string) {
    const target = new URL(value)
    if (!target.toString().startsWith(prefix)) throw new TypeError("Invalid relay target")
    return target
  }
  function url(value: string) {
    const target = owned(value)
    if (!proof) throw new TypeError("Relay authority unavailable")
    target.searchParams.set(RELAY_AUTHORITY_QUERY, proof)
    return target.toString()
  }
  const boundFetch: typeof fetch = async (input, init) => {
    const target = owned(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const path = target.pathname.slice(new URL(prefix).pathname.length - 1)
    const bootstrap = !target.search && ((method === "GET" && ["/api/meta", "/api/auth/status"].includes(path)) || method === "POST" && path === "/api/auth/login")
    if (!proof && !bootstrap) return Promise.reject(new TypeError("Relay authority unavailable"))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set(RELAY_AUTHORITY_HEADER, proof ?? RELAY_BOOTSTRAP)
    return fetcher(input, { ...init, headers })
  }
  function candidateUrl(path: string) {
    if (proof) return url(transport.url(path))
    if (!["/api/meta", "/api/auth/status", "/api/auth/login"].includes(path)) throw new TypeError("Relay authority unavailable")
    return transport.url(path)
  }
  return {
    fetch: boundFetch,
    transport: { ...transport,
      url: candidateUrl,
      openEventSource: (value: string, init: EventSourceInit) => transport.openEventSource(url(value), init),
    },
    admitRelayAuthority(value: string | null) {
      if (!isRelayAuthority(value) || proof !== undefined && proof !== value) return false
      proof = value
      return true
    },
  }
}
