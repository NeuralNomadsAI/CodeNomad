import { createHash } from "node:crypto"
import type { ServiceConnection } from "../workspaces/opencode-service"
import type { ProviderUsageResponse } from "../api-types"
import type { ProviderUsage } from "./types"
import { decodeJwtClaims, getString } from "./shared"
import { parseCodexUsage } from "./providers/oauth"

interface UsageScope {
  instanceId: string
  sessionId: string
  directory: string
  providerId: string
  modelId?: string
}
type Snapshot = { identity: string; usage: ProviderUsage; fetchedAt: number }
const CACHE_TTL_MS = 60_000
const MAX_RESPONSE_BYTES = 65_536

// Only normalized quota snapshots and irreversible identity digests are retained.
// Native credential exports (including refresh tokens) stay on the server stack.
export function createNativeCodexUsage() {
  const caches = new WeakMap<ServiceConnection, Map<string, Snapshot>>()
  const pending = new WeakMap<ServiceConnection, Map<string, Promise<ProviderUsage>>>()

  return async (connection: ServiceConnection, scope: UsageScope, signal: AbortSignal): Promise<ProviderUsageResponse | null> => {
    const response = (snapshot?: Snapshot): ProviderUsageResponse => ({
      requestedProviderId: scope.providerId, providerId: "codex", providerName: "Codex", modelId: scope.modelId,
      supported: true, configured: true, ok: Boolean(snapshot), windows: snapshot?.usage.windows ?? {},
      fetchedAt: snapshot?.fetchedAt ?? Date.now(),
    })
    const location = { directory: scope.directory }
    const key = JSON.stringify([scope.instanceId, scope.sessionId, scope.directory, scope.providerId])
    let requestKey: string | undefined
    let request: Promise<ProviderUsage> | undefined
    let recognized = ["openai", "codex", "chatgpt"].includes(scope.providerId.toLowerCase())
    const readSelected = async () => {
      connection.assertCurrent()
      signal.throwIfAborted()
      const provider = await connection.client.provider.get({ providerID: scope.providerId, location }, { signal })
      if (provider.location.directory !== scope.directory || provider.data.id !== scope.providerId) throw new Error("Provider location changed")
      const integrationID = provider.data.integrationID ?? scope.providerId
      if (integrationID !== "openai") return null
      recognized = true
      const integration = await connection.client.integration.get({ integrationID, location }, { signal })
      if (integration.location.directory !== scope.directory || integration.data.id !== integrationID) throw new Error("Integration location changed")
      const selected = integration.data.connections[0]
      if (selected?.type !== "credential" || selected.method !== "oauth" || selected.status?.status === "needs_auth") {
        throw new Error("Subscription OAuth unavailable")
      }
      // Available in 2.0.20+. A missing endpoint is feature-local unavailability,
      // not a reason to raise the global minimum, read SQLite or try auth.json.
      const entries = await connection.client.credential.list({ signal })
      const entry = entries.find(entry => entry.id === selected.id && entry.integrationID === integrationID && entry.active)
      const value = entry?.value
      if (value?.type !== "oauth" || !["chatgpt-browser", "chatgpt-headless"].includes(value.methodID)
        || !Number.isFinite(value.expires) || value.expires <= Date.now() + 120_000 || !getString(value.access)) {
        throw new Error("Selected subscription credential unavailable")
      }
      const claims = decodeJwtClaims(value.access)
      const jwtExpiry = Number(claims?.exp) * 1000
      if (Number.isFinite(jwtExpiry) && jwtExpiry <= Date.now() + 120_000) throw new Error("Expired subscription credential")
      const accountID = getString(value.metadata?.accountID)
        ?? getString(claims?.["https://api.openai.com/auth"]?.chatgpt_account_id)
      // Require a same-selected-credential account identity, never another store.
      if (!accountID) throw new Error("Subscription account unavailable")
      const identity = createHash("sha256").update(JSON.stringify([
        integrationID, entry!.id, value.methodID, accountID, value.expires, value.access,
      ])).digest("hex")
      connection.assertCurrent()
      signal.throwIfAborted()
      return { identity, access: value.access, accountID }
    }

    try {
      const selected = await readSelected()
      if (!selected) { caches.get(connection)?.delete(key); return null }
      let cache = caches.get(connection)
      if (!cache) { cache = new Map(); caches.set(connection, cache) }
      let requests = pending.get(connection)
      if (!requests) { requests = new Map(); pending.set(connection, requests) }
      let snapshot = cache.get(key)
      if (snapshot?.identity !== selected.identity || Date.now() - snapshot.fetchedAt >= CACHE_TTL_MS) {
        cache.delete(key)
        snapshot = undefined
      }
      if (!snapshot) {
        requestKey = JSON.stringify([key, selected.identity])
        request = requests.get(requestKey)
        if (!request) {
          request = fetchQuota(selected.access, selected.accountID, signal)
          requests.set(requestKey, request)
        }
        snapshot = { identity: selected.identity, usage: await request, fetchedAt: Date.now() }
      }
      // Warm snapshots and in-flight results both need fresh native selection.
      // Never publish or populate a cache after an account or connection switch.
      const current = await readSelected()
      if (current?.identity !== selected.identity) { cache.delete(key); return response() }
      connection.assertCurrent()
      signal.throwIfAborted()
      if (cache.size >= 128 && !cache.has(key)) cache.delete(cache.keys().next().value!)
      cache.set(key, snapshot)
      return response(snapshot)
    } catch {
      caches.get(connection)?.delete(key)
      // Native errors may contain credential values, labels or request bodies.
      // Neither public responses nor logs receive any upstream error detail.
      return recognized ? response() : null
    } finally {
      // Keep the quota promise shared until the snapshot has been revalidated
      // and published, not just until its provider HTTP response arrives.
      const requests = pending.get(connection)
      if (requestKey && requests && requests.get(requestKey) === request) requests.delete(requestKey)
    }
  }
}

async function fetchQuota(access: string, accountID: string, signal: AbortSignal): Promise<ProviderUsage> {
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    signal, redirect: "error", headers: { Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": accountID, "Content-Type": "application/json" },
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new Error("Quota unavailable")
  }
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error("Quota response too large")
      chunks.push(chunk.value)
    }
    signal.throwIfAborted()
    return parseCodexUsage(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
