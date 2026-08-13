import assert from "node:assert/strict"
import test from "node:test"

import { clearSessionMessageRenderCache, getSessionMessageRenderCache, peekSessionMessageRenderCache, purgeMessageRenderCache } from "./message-render-cache.ts"

test("purges every render-cache entry owned by omitted messages", () => {
  const cache = {
    messageBlocks: new Map<string, unknown>([["removed", {}], ["kept", {}]]),
    recordDisplayCache: new Map<string, unknown>([["removed", {}], ["kept", {}]]),
    messageItems: new Map([
      ["removed:content:part", { messageId: "removed" }],
      ["kept:content:part", { messageId: "kept" }],
    ]),
    toolItems: new Map([
      ["removed:tool", { messageId: "removed" }],
      ["kept:tool", { messageId: "kept" }],
    ]),
  }

  purgeMessageRenderCache(cache, ["removed"])

  assert.deepEqual([...cache.messageBlocks.keys()], ["kept"])
  assert.deepEqual([...cache.recordDisplayCache.keys()], ["kept"])
  assert.deepEqual([...cache.messageItems.keys()], ["kept:content:part"])
  assert.deepEqual([...cache.toolItems.keys()], ["kept:tool"])
})

test("clears a session render cache without touching another session", () => {
  getSessionMessageRenderCache("instance", "removed").recordDisplayCache.set("message", { orderedParts: [{ text: "cached" }] })
  getSessionMessageRenderCache("instance", "kept").messageBlocks.set("message", { text: "kept" })

  clearSessionMessageRenderCache("instance", "removed")

  assert.equal(peekSessionMessageRenderCache("instance", "removed"), undefined)
  assert.equal(peekSessionMessageRenderCache("instance", "kept")?.messageBlocks.size, 1)
  clearSessionMessageRenderCache("instance", "kept")
})
