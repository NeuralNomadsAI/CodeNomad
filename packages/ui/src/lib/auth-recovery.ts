import { createSignal } from "solid-js"
import { localTransport, resolveBackendUrl, type BackendHttp } from "./backend-transport"

/** Browser login recovery only. Never retries a failed application request or
 * interprets an upstream OpenCode 401 as proof of an expired CodeNomad login. */
export function createAuthRecovery(base: string | undefined | Pick<BackendHttp, "url">, fetcher: typeof fetch = (...args) => fetch(...args)) {
  const [required, setRequired] = createSignal(false)
  // Remote Control devices cannot sign in with a password; they pair again on the host.
  const [pairingRequired, setPairingRequired] = createSignal(false)
  const restored = new Set<() => void>()
  let generation = 0
  let nextProbe = 0, publishedProbe = 0
  const checking = new Map<AbortSignal | undefined, Promise<void>>()
  const url = typeof base === "object" ? base.url : (path: string) => resolveBackendUrl(base, path)

  function authenticated(signal?: AbortSignal) {
    const current = generation
    const wasRequired = required()
    setRequired(false)
    if (wasRequired) for (const handler of [...restored]) {
      if (signal?.aborted || current !== generation) break
      if (restored.has(handler)) handler()
    }
  }

  function check(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    const existing = checking.get(signal)
    if (existing) return existing
    const current = generation
    const probe = ++nextProbe
    const pending = (async () => {
      try {
        const response = await fetcher(url("/api/auth/status"), {
          credentials: "include", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
        })
        if (!response.ok) return
        const status = await response.json()
        if (current !== generation || signal?.aborted || probe < publishedProbe) return
        if (typeof status?.authenticated !== "boolean") return
        publishedProbe = probe
        if (status?.authenticated === false) {
          setPairingRequired(status.pairingRequired === true)
          if (current !== generation || signal?.aborted) return
          setRequired(true)
        }
        else if (status?.authenticated === true) authenticated(signal)
      } catch { /* Offline/unreachable is not evidence of an expired login. */ }
    })()
    checking.set(signal, pending)
    void pending.finally(() => { if (checking.get(signal) === pending) checking.delete(signal) })
    return pending
  }

  async function signIn(username: string, password: string): Promise<"ok" | "credentials" | "unavailable"> {
    // Fence probes started before this login, including their response bodies.
    const current = ++generation
    checking.clear()
    try {
      const response = await fetcher(url("/api/auth/login"), {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15000),
      })
      if (current !== generation) return "unavailable"
      if (response.status === 401) return "credentials"
      if (!response.ok) return "unavailable"
      const body = await response.json()
      if (current !== generation || body?.ok !== true) return "unavailable"
      // A probe issued while login was in flight may still carry the old cookie.
      generation++
      checking.clear()
      authenticated()
      return "ok"
    } catch { return "unavailable" }
  }

  return {
    required, pairingRequired, check, signIn,
    onRestored(handler: () => void) { restored.add(handler); return () => restored.delete(handler) },
  }
}

export type AuthRecovery = ReturnType<typeof createAuthRecovery>

/** Probes only `auth`'s backend on a 401, whichever URL answered it. */
export function createAuthenticatedFetch(auth: AuthRecovery, fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init)
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    if (response.status === 401 && !signal?.aborted) void auth.check(signal ?? undefined)
    return response
  }
}

export const authRecovery = createAuthRecovery(localTransport.baseUrl)

export const authenticatedFetch: typeof fetch = createAuthenticatedFetch(authRecovery)

/** The local backend's transport with its authenticated fetch. */
export const localHttp: BackendHttp = { ...localTransport, fetch: authenticatedFetch }
