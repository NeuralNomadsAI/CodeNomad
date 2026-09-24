import { createSignal } from "solid-js"
import { CODENOMAD_API_BASE } from "./api-base"

/** Browser login recovery only. Never retries a failed application request or
 * interprets an upstream OpenCode 401 as proof of an expired CodeNomad login. */
export function createAuthRecovery(base: string | undefined, fetcher: typeof fetch = (...args) => fetch(...args)) {
  const [required, setRequired] = createSignal(false)
  const restored = new Set<() => void>()
  let generation = 0
  let checking: Promise<void> | undefined
  const url = (path: string) => base ? new URL(path, base).toString() : path

  function authenticated() {
    const wasRequired = required()
    setRequired(false)
    if (wasRequired) for (const handler of restored) handler()
  }

  function check(): Promise<void> {
    if (checking) return checking
    const current = generation
    const pending = (async () => {
      try {
        const response = await fetcher(url("/api/auth/status"), {
          credentials: "include", cache: "no-store", signal: AbortSignal.timeout(8000),
        })
        if (!response.ok) return
        const status = await response.json()
        if (current !== generation) return
        if (status?.authenticated === false) setRequired(true)
        else if (status?.authenticated === true) authenticated()
      } catch { /* Offline/unreachable is not evidence of an expired login. */ }
    })()
    checking = pending
    void pending.finally(() => { if (checking === pending) checking = undefined })
    return pending
  }

  async function signIn(username: string, password: string): Promise<"ok" | "credentials" | "unavailable"> {
    // Fence probes started before this login, including their response bodies.
    const current = ++generation
    checking = undefined
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
      checking = undefined
      authenticated()
      return "ok"
    } catch { return "unavailable" }
  }

  return {
    required, check, signIn,
    onRestored(handler: () => void) { restored.add(handler); return () => restored.delete(handler) },
  }
}

export const authRecovery = createAuthRecovery(CODENOMAD_API_BASE)

export const authenticatedFetch: typeof fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init)
  if (response.status === 401) void authRecovery.check()
  return response
}
