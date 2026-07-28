import assert from "node:assert/strict"
import test from "node:test"
import {
  createSessionMessageCacheKey,
  clearSessionMessageCache,
  isSessionMessageCacheUnsafe,
  markSessionMessageCacheUnsafe,
  prepareSessionMessageCache,
  selectSessionMessageCacheEvictions,
} from "./session-message-cache.ts"

test("session message cache keys normalize path separators", () => {
  assert.equal(createSessionMessageCacheKey("C:\\work\\repo\\", "session-1"), "C:/work/repo\u0000session-1")
})

test("session message cache evicts the oldest entries to satisfy byte and count limits", () => {
  const entries = [
    { key: "old", byteSize: 5, savedAt: 1, snapshotId: "1", messageIds: [], startIndex: 0, totalCount: 0, complete: true },
    { key: "middle", byteSize: 4, savedAt: 2, snapshotId: "2", messageIds: [], startIndex: 0, totalCount: 0, complete: true },
    { key: "new", byteSize: 3, savedAt: 3, snapshotId: "3", messageIds: [], startIndex: 0, totalCount: 0, complete: true },
  ]
  assert.deepEqual(selectSessionMessageCacheEvictions(entries, 7, 3), ["old"])
  assert.deepEqual(selectSessionMessageCacheEvictions(entries, 20, 2), ["old"])
})

test("session message cache retains the newest contiguous messages within its budget", () => {
  const messages = ["one", "two", "three"].map((id) => ({ info: { id }, parts: [{ type: "text", text: id.repeat(10) }] }))
  const byteLimit = messages.slice(1).reduce((total, message) => total + JSON.stringify(message).length * 2, 0)
  const prepared = prepareSessionMessageCache("session", messages, "snapshot", byteLimit, 1)
  assert.deepEqual(prepared?.manifest.messageIds, ["two", "three"])
  assert.equal(prepared?.manifest.startIndex, 1)
  assert.equal(prepared?.manifest.complete, false)
  assert.equal(prepared?.records.length, 2)
})

test("session message cache stores an authoritative empty manifest", () => {
  const prepared = prepareSessionMessageCache("session", [], "snapshot", 100, 1)
  assert.deepEqual(prepared?.manifest.messageIds, [])
  assert.equal(prepared?.manifest.complete, true)
  assert.equal(prepared?.manifest.totalCount, 0)
})

test("session message cache persists an unsafe marker until a successful clear", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const values = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } })
    markSessionMessageCacheUnsafe(true)
    assert.equal(isSessionMessageCacheUnsafe(), true)
    await clearSessionMessageCache()
    assert.equal(isSessionMessageCacheUnsafe(), false)
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { ...localStorage, setItem: () => { throw new Error("denied") } } },
    })
    assert.doesNotThrow(() => markSessionMessageCacheUnsafe(true))
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else delete (globalThis as any).window
  }
})

test("session message cache preserves the source range of a pre-truncated tail", () => {
  const messages = ["six", "seven", "eight"].map((id) => ({ info: { id }, parts: [] }))
  const prepared = prepareSessionMessageCache("session", messages, "snapshot", 10_000, 1, {
    startIndex: 5,
    totalCount: 8,
  })
  assert.equal(prepared?.manifest.startIndex, 5)
  assert.equal(prepared?.manifest.totalCount, 8)
  assert.equal(prepared?.manifest.complete, false)
})

test("session message cache preparation enforces the manifest message limit", () => {
  const messages = Array.from({ length: 20_001 }, (_, index) => ({ info: { id: String(index) }, parts: [] }))
  const prepared = prepareSessionMessageCache("session", messages, "snapshot", 16 * 1024 * 1024, 1)
  assert.equal(prepared?.manifest.messageIds.length, 20_000)
  assert.equal(prepared?.manifest.startIndex, 1)
})
