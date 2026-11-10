import { createHash } from "node:crypto"
import type { ProviderUsageResponse } from "../api-types"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { openCodeConsoleCredential, readUsageCredentials } from "./native-credentials"
import { OPENCODE_FREE_DAILY_REQUESTS, openCodeFreeWindow } from "./opencode-free-estimate"
import type { OpenCodeFreeExhaustion } from "./opencode-free-exhaustion"
import { openCodeConsoleError, readOpenCodeConsoleFreeRequests } from "./providers/opencode-console"
import type { AuthEntry } from "./types"

type ConsoleReading = Pick<ProviderUsageResponse, "configured" | "unavailableReason"> & { requests: number | null }

export function createOpenCodeFreeUsage(exhaustion: Pick<OpenCodeFreeExhaustion, "exhausted">) {
  const cache = new Map<string, { expiresAt: number; read: Promise<number> }>()
  const lifetime = new AbortController()
  async function consoleRequests(connection: ServiceConnection, day: number, signal: AbortSignal): Promise<ConsoleReading> {
    const auth = await readUsageCredentials(connection, signal)
    signal.throwIfAborted()
    const credential = openCodeConsoleCredential(auth)
    if ("reason" in credential) return { requests: null, configured: credential.configured, unavailableReason: credential.reason }
    const entry = auth.opencode as AuthEntry
    const key = `${day}:${createHash("sha256").update(JSON.stringify(entry)).digest("hex")}`
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return { requests: await cached.read, configured: true }
    if (cache.size >= 32) cache.delete(cache.keys().next().value!)
    const expiry = entry.type === "oauth" && typeof entry.expires === "number" ? entry.expires : Infinity
    const record = { expiresAt: Math.min(openCodeFreeWindow(day).resetAt, expiry, Date.now() + 60_000),
      read: readOpenCodeConsoleFreeRequests(auth, AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]))
        .catch(error => { if (cache.get(key) === record) cache.delete(key); throw error }) }
    cache.set(key, record)
    return { requests: await record.read, configured: true }
  }
  function refreshExhaustion(connection: ServiceConnection, usage: ProviderUsageResponse): ProviderUsageResponse {
    if (!usage.freeEstimate) return usage
    const now = Date.now(), exhausted = exhaustion.exhausted(connection, now)
    const sameDay = openCodeFreeWindow(usage.fetchedAt).from === openCodeFreeWindow(now).from
    const requests = sameDay ? usage.freeEstimate.requests : null
    const reference = OPENCODE_FREE_DAILY_REQUESTS
    const usedPercent = exhausted ? 100 : Math.min(100, (requests ?? 0) / reference * 100)
    return { ...usage, fetchedAt: now, ok: requests !== null,
      freeEstimate: { requests, reference, exhausted },
      windows: requests === null ? {} : { daily: {
        usedPercent, remainingPercent: 100 - usedPercent, windowSeconds: 86_400,
        resetAt: openCodeFreeWindow(now).resetAt,
        valueLabel: `${requests} / ${reference}`,
      } } }
  }
  return {
    async read(connection: ServiceConnection, providerId: string, modelId: string | undefined, signal: AbortSignal,
      readSignal: AbortSignal = AbortSignal.timeout(12_000)) {
      const now = Date.now(), { from } = openCodeFreeWindow(now)
      const unavailable: ConsoleReading = { requests: null, configured: true, unavailableReason: "opencode-console-network-error" }
      const bounded = AbortSignal.any([signal, readSignal])
      let abort!: () => void
      const aborted = new Promise<ConsoleReading>(resolve => {
        abort = () => resolve(unavailable)
        bounded.addEventListener("abort", abort, { once: true })
      })
      let reading = unavailable
      try {
        // Caller cancellation leaves another caller's shared Console transport alive.
        reading = bounded.aborted ? unavailable : await Promise.race([consoleRequests(connection, from, bounded), aborted])
      } catch (error) {
        reading = { ...unavailable, unavailableReason: openCodeConsoleError(error) }
      } finally { bounded.removeEventListener("abort", abort) }
      signal.throwIfAborted()
      return refreshExhaustion(connection, {
        requestedProviderId: providerId, providerId: "opencode-free", providerName: "OpenCode Console", modelId,
        supported: true, configured: reading.configured, ok: false, estimated: true, fetchedAt: now, windows: {},
        ...(reading.unavailableReason ? { unavailableReason: reading.unavailableReason } : {}),
        freeEstimate: { requests: reading.requests, reference: OPENCODE_FREE_DAILY_REQUESTS, exhausted: false },
      })
    },
    refreshExhaustion,
    dispose() { lifetime.abort(); cache.clear() },
  }
}

export type OpenCodeFreeUsage = ReturnType<typeof createOpenCodeFreeUsage>
