import assert from "node:assert/strict"
import test from "node:test"
import {
  captureCacheAuthority,
  clearCacheForInstance,
  clearCacheForSession,
  getCacheEntry,
  onCacheSessionChanged,
  setCacheEntry,
} from "./global-cache.ts"

test("global render cache rejects oversized values and bounds each scope", () => {
  const oversized = { instanceId: "instance", sessionId: "session", scope: "markdown", cacheId: "oversized", version: "1" }
  try {
    setCacheEntry(oversized, "x".repeat(3 * 1024 * 1024))
    assert.equal(getCacheEntry(oversized), undefined)
    for (let index = 0; index < 65; index += 1) {
      setCacheEntry({ ...oversized, cacheId: String(index) }, index)
    }
    assert.equal(getCacheEntry({ ...oversized, cacheId: "0" }), undefined)
    assert.equal(getCacheEntry({ ...oversized, cacheId: "64" }), 64)
  } finally {
    clearCacheForInstance("instance")
  }
})

test("cleared cache authority rejects stale async session and instance writes", () => {
  const sessionEntry = { instanceId: "authority", sessionId: "session", scope: "markdown", cacheId: "part", version: "1" }
  const diffEntry = { ...sessionEntry, scope: "tool-call", cacheId: "diff" }
  const otherSessionEntry = { ...sessionEntry, sessionId: "other" }
  try {
    const staleSessionAuthority = captureCacheAuthority(sessionEntry)
    const staleDiffAuthority = captureCacheAuthority(diffEntry)
    clearCacheForSession(sessionEntry.instanceId, sessionEntry.sessionId)
    setCacheEntry(sessionEntry, "stale", staleSessionAuthority)
    setCacheEntry(diffEntry, "stale", staleDiffAuthority)
    setCacheEntry(otherSessionEntry, "current", captureCacheAuthority(otherSessionEntry))

    assert.equal(getCacheEntry(sessionEntry), undefined)
    assert.equal(getCacheEntry(diffEntry), undefined)
    assert.equal(getCacheEntry(otherSessionEntry), "current")

    const staleInstanceAuthority = captureCacheAuthority(otherSessionEntry)
    clearCacheForInstance(sessionEntry.instanceId)
    setCacheEntry(otherSessionEntry, "stale", staleInstanceAuthority)
    assert.equal(getCacheEntry(otherSessionEntry), undefined)
  } finally {
    clearCacheForInstance(sessionEntry.instanceId)
  }
})

test("cache misses implicitly reject stale async writes after session clear", () => {
  const entry = { instanceId: "implicit-authority", sessionId: "session", scope: "markdown", cacheId: "part", version: "1" }
  try {
    assert.equal(getCacheEntry(entry), undefined)
    clearCacheForSession(entry.instanceId, entry.sessionId)
    setCacheEntry(entry, "stale")
    assert.equal(getCacheEntry(entry), undefined)
  } finally {
    clearCacheForInstance(entry.instanceId)
  }
})

test("semantic cache hits reject late async writes after session clear", () => {
  const entry = { instanceId: "semantic-authority", sessionId: "session", scope: "diff", cacheId: "part", version: "1" }
  try {
    setCacheEntry(entry, { mode: "split" })
    assert.deepEqual(getCacheEntry(entry), { mode: "split" })
    clearCacheForSession(entry.instanceId, entry.sessionId)
    setCacheEntry(entry, { mode: "unified" })
    assert.equal(getCacheEntry(entry), undefined)
  } finally {
    clearCacheForInstance(entry.instanceId)
  }
})

test("session-owned cache writes request transcript remeasurement", () => {
  const entry = { instanceId: "cache-accounting", sessionId: "session", scope: "markdown", cacheId: "part", version: "1" }
  const changed: string[] = []
  const stop = onCacheSessionChanged((instanceId, sessionId) => changed.push(`${instanceId}/${sessionId}`))
  try {
    setCacheEntry(entry, "rendered")
    assert.deepEqual(changed, ["cache-accounting/session"])
  } finally {
    stop()
    clearCacheForInstance(entry.instanceId)
  }
})

test("cache authority rejects superseded and scope-evicted async writes", () => {
  const entry = { instanceId: "authority-races", sessionId: "session", scope: "markdown", cacheId: "part", version: "1" }
  try {
    setCacheEntry(entry, "existing")
    const evictedAuthority = captureCacheAuthority(entry)
    for (let index = 0; index < 64; index += 1) {
      setCacheEntry({ ...entry, cacheId: `other-${index}` }, index)
    }
    setCacheEntry(entry, "resurrected", evictedAuthority)
    assert.equal(getCacheEntry(entry), undefined)

    const staleAuthority = captureCacheAuthority(entry)
    const currentAuthority = captureCacheAuthority(entry)
    setCacheEntry(entry, "stale", staleAuthority)
    setCacheEntry(entry, "current", currentAuthority)
    assert.equal(getCacheEntry(entry), "current")
  } finally {
    clearCacheForInstance(entry.instanceId)
  }
})
