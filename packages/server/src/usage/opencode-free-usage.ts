import { createHash } from "node:crypto"
import type { ProviderUsageResponse } from "../api-types"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { openCodeConsoleCredential, readUsageCredentials } from "./native-credentials"
import { estimateOpenCodeFreeUsage, OPENCODE_FREE_DAILY_REQUESTS, openCodeFreeWindow } from "./opencode-free-estimate"
import type { OpenCodeFreeExhaustion } from "./opencode-free-exhaustion"
import { readOpenCodeConsoleFreeRequests } from "./providers/opencode-console"
import type { AuthEntry } from "./types"

export const OPENCODE_FREE_CONSOLE_CALIBRATION = true

export function calibrateOpenCodeFreeRequests(local: number | null, console: number | null): number | null {
  return local === null || console === null ? local : Math.max(local, console)
}

export function createOpenCodeFreeUsage(exhaustion: Pick<OpenCodeFreeExhaustion, "exhausted">,
  options: { consoleCalibration?: boolean } = {}) {
  const cache = new Map<string, { expiresAt: number; read: Promise<number | null> }>()
  const lifetime = new AbortController()
  async function consoleRequests(connection: ServiceConnection, day: number, signal: AbortSignal) {
    const auth = await readUsageCredentials(connection, signal)
    signal.throwIfAborted()
    if ("reason" in openCodeConsoleCredential(auth)) return null
    const entry = auth.opencode as AuthEntry
    const key = `${day}:${createHash("sha256").update(JSON.stringify(entry)).digest("hex")}`
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.read
    if (cache.size >= 32) cache.delete(cache.keys().next().value!)
    const expiry = entry.type === "oauth" && typeof entry.expires === "number" ? entry.expires : Infinity
    const record = { expiresAt: Math.min(openCodeFreeWindow(day).resetAt, expiry, Date.now() + 60_000),
      read: readOpenCodeConsoleFreeRequests(auth, AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]))
        .catch(() => { if (cache.get(key) === record) cache.delete(key); return null }) }
    cache.set(key, record)
    return record.read
  }
  function refreshExhaustion(connection: ServiceConnection, usage: ProviderUsageResponse): ProviderUsageResponse {
    if (!usage.freeEstimate) return usage
    const now = Date.now(), exhausted = exhaustion.exhausted(connection, now)
    const sameDay = openCodeFreeWindow(usage.fetchedAt).from === openCodeFreeWindow(now).from
    const requests = sameDay ? usage.freeEstimate.requests : null
    const reference = OPENCODE_FREE_DAILY_REQUESTS
    const usedPercent = exhausted ? 100 : Math.min(100, (requests ?? 0) / reference * 100)
    return { ...usage, fetchedAt: now, ok: requests !== null || exhausted,
      freeEstimate: { requests, reference, exhausted },
      windows: requests === null && !exhausted ? {} : { daily: {
        usedPercent, remainingPercent: 100 - usedPercent, windowSeconds: 86_400,
        resetAt: openCodeFreeWindow(now).resetAt,
        ...(requests === null ? {} : { valueLabel: `${requests} / ${reference}` }),
      } } }
  }
  return {
    async read(connection: ServiceConnection, providerId: string, modelId: string | undefined, signal: AbortSignal,
      calibrationSignal: AbortSignal = AbortSignal.timeout(12_000)) {
      const now = Date.now(), { from, to } = openCodeFreeWindow(now)
      let usage: ProviderUsageResponse = { requestedProviderId: providerId, providerId: "opencode-free", providerName: "OpenCode Console", modelId,
        supported: true, configured: true, ok: false, estimated: true, fetchedAt: now, windows: {},
        freeEstimate: { requests: null, reference: OPENCODE_FREE_DAILY_REQUESTS, exhausted: false } }
      try {
        const stats = to === from ? { models: [] } : await connection.client.session.stats({ from, to, timezone: "UTC", tools: "none" }, { signal })
        usage = estimateOpenCodeFreeUsage(stats, providerId, modelId, now)
      } catch { /* Preserve display evidence when native stats are unavailable. */ }
      signal.throwIfAborted()
      if (options.consoleCalibration ?? OPENCODE_FREE_CONSOLE_CALIBRATION) {
        // Optional calibration leaves the route time to publish its local reading.
        // Abandoning this caller's wait must not cancel another caller's shared read.
        const optional = AbortSignal.any([signal, calibrationSignal])
        let abort!: () => void
        const aborted = new Promise<null>(resolve => {
          abort = () => resolve(null)
          optional.addEventListener("abort", abort, { once: true })
        })
        try {
          const console = optional.aborted ? null
            : await Promise.race([consoleRequests(connection, from, optional).catch(() => null), aborted])
          signal.throwIfAborted()
          usage.freeEstimate!.requests = calibrateOpenCodeFreeRequests(usage.freeEstimate!.requests, console)
        } finally { optional.removeEventListener("abort", abort) }
      }
      return refreshExhaustion(connection, usage)
    },
    refreshExhaustion,
    dispose() { lifetime.abort(); cache.clear() },
  }
}

export type OpenCodeFreeUsage = ReturnType<typeof createOpenCodeFreeUsage>
