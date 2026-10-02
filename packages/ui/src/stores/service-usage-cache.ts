import type { ServiceUsageSnapshot } from "../../../server/src/api-types"

type CachedUsage = { snapshot: ServiceUsageSnapshot; savedAt: number; stale: boolean }

const memory = new Map<string, CachedUsage>()
const STORAGE_PREFIX = "codenomad:service-usage:v1:"
const MAX_STORED_KEYS = 8

function key(instanceId: string, days: number, timezone: string) {
  return `${instanceId}\0${days}\0${timezone}`
}

function storageKey(cacheKey: string) {
  return `${STORAGE_PREFIX}${cacheKey.replace(/\0/g, "|")}`
}

function readStored(cacheKey: string): CachedUsage | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined
    const raw = localStorage.getItem(storageKey(cacheKey))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as CachedUsage
    if (!parsed || typeof parsed !== "object" || !parsed.snapshot) return undefined
    return { ...parsed, stale: true }
  } catch {
    return undefined
  }
}

function writeStored(cacheKey: string, entry: CachedUsage) {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(storageKey(cacheKey), JSON.stringify({ snapshot: entry.snapshot, savedAt: entry.savedAt, stale: true }))
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index)
      if (name?.startsWith(STORAGE_PREFIX)) keys.push(name)
    }
    // Bound restoration storage: drop the oldest snapshots first.
    if (keys.length > MAX_STORED_KEYS) {
      const aged = keys.map(name => {
        try {
          const parsed = JSON.parse(localStorage.getItem(name) ?? "") as CachedUsage
          return { name, savedAt: parsed?.savedAt ?? 0 }
        } catch {
          return { name, savedAt: 0 }
        }
      }).sort((a, b) => a.savedAt - b.savedAt)
      for (const victim of aged.slice(0, keys.length - MAX_STORED_KEYS)) localStorage.removeItem(victim.name)
    }
  } catch {
    // Restoration is best-effort display state, never a failure surface.
  }
}

export function getCachedServiceUsage(instanceId: string, days: number, timezone: string): CachedUsage | undefined {
  const cacheKey = key(instanceId, days, timezone)
  const hit = memory.get(cacheKey)
  if (hit) return hit
  const stored = readStored(cacheKey)
  if (stored) memory.set(cacheKey, stored)
  return stored
}

export function setCachedServiceUsage(instanceId: string, days: number, timezone: string, snapshot: ServiceUsageSnapshot) {
  const entry: CachedUsage = { snapshot, savedAt: Date.now(), stale: false }
  memory.set(key(instanceId, days, timezone), entry)
  writeStored(key(instanceId, days, timezone), entry)
}

export function markServiceUsageStale(instanceId: string) {
  for (const [cacheKey, entry] of memory) {
    if (cacheKey.startsWith(`${instanceId}\0`)) memory.set(cacheKey, { ...entry, stale: true })
  }
}
