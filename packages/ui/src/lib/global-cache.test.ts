import assert from "node:assert/strict"
import test from "node:test"
import { clearCacheForInstance, getCacheEntry, setCacheEntry } from "./global-cache.ts"

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
