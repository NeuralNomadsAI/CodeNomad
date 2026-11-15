import { createHash } from "node:crypto"
import type { ProviderUsageResponse } from "../api-types"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { openCodeConsoleCredential, readUsageCredentials } from "./native-credentials"
import { OPENCODE_FREE_DAILY_REQUESTS } from "./opencode-free-estimate"
import { openCodeConsoleError, readOpenCodeConsoleFreeRequests, readOpenCodeConsoleCredits } from "./providers/opencode-console"
import type { AuthEntry } from "./types"

type Credits = ProviderUsageResponse["windows"][string]
type Counts = { requests: number; credits?: Credits }
type ConsoleReading = Pick<ProviderUsageResponse, "configured" | "unavailableReason"> & { requests: number | null; credits?: Credits }

/**
 * Free OpenCode models show the Console's own free-model request count (its
 * rolling 24 hours) against the observed reference, plus the Console credit
 * balance. Nothing is estimated locally: no reset time, no exhaustion state.
 */
export function createOpenCodeFreeUsage() {
  const cache = new Map<string, { expiresAt: number; read: Promise<Counts> }>()
  const lifetime = new AbortController()
  async function consoleRequests(connection: ServiceConnection, signal: AbortSignal): Promise<ConsoleReading> {
    const auth = await readUsageCredentials(connection, signal)
    signal.throwIfAborted()
    const credential = openCodeConsoleCredential(auth)
    if ("reason" in credential) return { requests: null, configured: credential.configured, unavailableReason: credential.reason }
    const entry = auth.opencode as AuthEntry
    const key = createHash("sha256").update(JSON.stringify(entry)).digest("hex")
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return { ...await cached.read, configured: true }
    if (cache.size >= 32) cache.delete(cache.keys().next().value!)
    const expiry = entry.type === "oauth" && typeof entry.expires === "number" ? entry.expires : Infinity
    const bounded = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)])
    // The optional balance runs beside the count on its own short bound.
    const credits = readOpenCodeConsoleCredits(auth, bounded)
    credits.catch(() => {})
    const record = { expiresAt: Math.min(expiry, Date.now() + 60_000),
      read: readOpenCodeConsoleFreeRequests(auth, bounded)
        .then(async requests => ({ requests, credits: await credits }))
        .catch(error => { if (cache.get(key) === record) cache.delete(key); throw error }) }
    cache.set(key, record)
    return { ...await record.read, configured: true }
  }
  return {
    async read(connection: ServiceConnection, providerId: string, modelId: string | undefined, signal: AbortSignal,
      readSignal: AbortSignal = AbortSignal.timeout(12_000)): Promise<ProviderUsageResponse> {
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
        reading = bounded.aborted ? unavailable : await Promise.race([consoleRequests(connection, bounded), aborted])
      } catch (error) {
        reading = { ...unavailable, unavailableReason: openCodeConsoleError(error) }
      } finally { bounded.removeEventListener("abort", abort) }
      signal.throwIfAborted()
      const { requests } = reading, reference = OPENCODE_FREE_DAILY_REQUESTS
      const usedPercent = Math.min(100, (requests ?? 0) / reference * 100)
      return {
        requestedProviderId: providerId, providerId: "opencode-free", providerName: "OpenCode Console", modelId,
        supported: true, configured: reading.configured, ok: requests !== null, fetchedAt: Date.now(),
        windows: {
          ...(requests === null ? {} : { daily: {
            usedPercent, remainingPercent: 100 - usedPercent, windowSeconds: 86_400, resetAt: null,
            valueLabel: `${requests} / ${reference}`,
          } }),
          ...(reading.credits ? { credits_balance: reading.credits } : {}),
        },
        ...(reading.unavailableReason ? { unavailableReason: reading.unavailableReason } : {}),
        freeEstimate: { requests, reference },
      }
    },
    dispose() { lifetime.abort(); cache.clear() },
  }
}

export type OpenCodeFreeUsage = ReturnType<typeof createOpenCodeFreeUsage>
