import assert from "node:assert/strict"
import test from "node:test"
import { clearCacheForInstance, getCacheEntry, setCacheEntry } from "./global-cache.ts"

test("global render cache rejects a single oversized derived value", () => {
  const params = { instanceId: "instance", sessionId: "session", scope: "markdown", cacheId: "entry", version: "1" }
  try {
    setCacheEntry(params, "x".repeat(3 * 1024 * 1024))
    assert.equal(getCacheEntry(params), undefined)
  } finally {
    clearCacheForInstance("instance")
  }
})

test("global render cache counts raw buffers and zero-byte entries", () => {
  const oversized = { instanceId: "buffer", sessionId: "session", scope: "raw", cacheId: "entry", version: "1" }
  try {
    setCacheEntry(oversized, new ArrayBuffer(5 * 1024 * 1024))
    assert.equal(getCacheEntry(oversized), undefined)

    for (let index = 0; index <= 4_096; index += 1) {
      setCacheEntry({ instanceId: "entries", sessionId: String(index), scope: "raw", cacheId: "entry", version: "1" }, null)
    }
    assert.equal(getCacheEntry({ instanceId: "entries", sessionId: "0", scope: "raw", cacheId: "entry", version: "1" }), undefined)
    assert.equal(getCacheEntry({ instanceId: "entries", sessionId: "4096", scope: "raw", cacheId: "entry", version: "1" }), null)
  } finally {
    clearCacheForInstance("buffer")
    clearCacheForInstance("entries")
  }
})

test("global render cache counts retained backing buffers and cache keys", () => {
  const viewParams = { instanceId: "view", sessionId: "session", scope: "raw", cacheId: "entry", version: "1" }
  const keyParams = { instanceId: "key", sessionId: "session", scope: "raw", cacheId: "x".repeat(3 * 1024 * 1024), version: "1" }
  try {
    setCacheEntry(viewParams, new Uint8Array(new ArrayBuffer(5 * 1024 * 1024), 0, 1))
    setCacheEntry(keyParams, null)
    assert.equal(getCacheEntry(viewParams), undefined)
    assert.equal(getCacheEntry(keyParams), undefined)
  } finally {
    clearCacheForInstance("view")
    clearCacheForInstance("key")
  }
})

test("global render cache rejects growable buffers", () => {
  const BufferConstructor = ArrayBuffer as typeof ArrayBuffer & { new(length: number, options: { maxByteLength: number }): ArrayBuffer & { resize?: (length: number) => void } }
  const buffer = new BufferConstructor(1, { maxByteLength: 8 * 1024 * 1024 })
  if (typeof buffer.resize !== "function") return
  const params = { instanceId: "growable", sessionId: "session", scope: "raw", cacheId: "entry", version: "1" }
  try {
    setCacheEntry(params, buffer)
    assert.equal(getCacheEntry(params), undefined)
  } finally {
    clearCacheForInstance("growable")
  }
})

test("global render cache does not trust spoofed buffer tags", () => {
  const params = { instanceId: "spoof", sessionId: "session", scope: "raw", cacheId: "entry", version: "1" }
  try {
    setCacheEntry(params, { [Symbol.toStringTag]: "ArrayBuffer", payload: "x".repeat(3 * 1024 * 1024) })
    assert.equal(getCacheEntry(params), undefined)
  } finally {
    clearCacheForInstance("spoof")
  }
})
