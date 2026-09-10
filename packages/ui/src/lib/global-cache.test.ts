import assert from "node:assert/strict"
import test from "node:test"

import { captureCacheAuthority, clearCacheForInstance, clearCacheForSession, getCacheEntry, onCacheSessionChanged, setCacheEntry } from "./global-cache.ts"

test("rejects stale writes and evicts the globally oldest cache entries", () => {
  const entry = { instanceId: "cache", sessionId: "stale", scope: "render", cacheId: "value", version: "1" }
  const authority = captureCacheAuthority(entry)
  const changed: string[] = []
  const stop = onCacheSessionChanged((instanceId, sessionId) => changed.push(`${instanceId}/${sessionId}`))
  try {
    clearCacheForSession(entry.instanceId, entry.sessionId)
    setCacheEntry(entry, "stale", authority)
    assert.equal(getCacheEntry(entry), undefined)

    for (let index = 0; index < 11; index += 1) {
      setCacheEntry({ ...entry, sessionId: `session-${index}` }, "x".repeat(1_500_000))
    }
    changed.length = 0
    setCacheEntry({ ...entry, sessionId: "trigger" }, "x".repeat(1_500_000))
    assert.ok(changed.includes("cache/session-0"))
    assert.equal(getCacheEntry({ ...entry, sessionId: "session-0" }), undefined)
    assert.notEqual(getCacheEntry({ ...entry, sessionId: "session-10" }), undefined)
  } finally {
    stop()
    clearCacheForInstance(entry.instanceId)
  }
})

test("does not double-subtract an entry while replacing it", () => {
  const entry = { instanceId: "replace", scope: "render", cacheId: "value", version: "1" }
  try {
    for (let index = 0; index < 15; index += 1) {
      setCacheEntry({ ...entry, sessionId: `session-${index}` }, "x".repeat(1_060_000))
    }
    setCacheEntry({ ...entry, sessionId: "session-0" }, "x".repeat(2_000_000))
    assert.equal(getCacheEntry({ ...entry, sessionId: "session-1" }), undefined)
  } finally {
    clearCacheForInstance(entry.instanceId)
  }
})
