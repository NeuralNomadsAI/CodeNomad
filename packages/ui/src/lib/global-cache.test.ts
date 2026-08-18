import assert from "node:assert/strict"
import test from "node:test"

import { captureCacheAuthority, clearCacheForInstance, clearCacheForSession, getCacheEntry, onCacheSessionChanged, setCacheEntry } from "./global-cache.ts"

test("rejects stale writes and remeasures sessions removed by a global budget reset", () => {
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
  } finally {
    stop()
    clearCacheForInstance(entry.instanceId)
  }
})
