import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { messageStoreBus } from "./bus.ts"
import { messagesLoaded, setMessagesLoaded } from "../session-state.ts"
import { getCacheEntry, setCacheEntry } from "../../lib/global-cache.ts"

describe("message store scroll snapshots", () => {
  it("seeds an unregistered instance without claiming runtime authority", () => {
    const instanceId = "session-restore-test"
    const snapshot = {
      scrollTop: 120,
      scrollRatio: 0.5,
      atBottom: false,
      followModeType: "escaped" as const,
      updatedAt: 1234,
    }
    const events: Array<{ instanceId: string; sessionId: string; scope: string; updatedAt: number }> = []
    const stopListening = messageStoreBus.onScrollSnapshotChanged((id, sessionId, scope, value) => {
      events.push({ instanceId: id, sessionId, scope, updatedAt: value.updatedAt })
    })

    try {
      messageStoreBus.seedScrollSnapshots(instanceId, [
        { sessionId: "session-1", scope: "message-stream", snapshot },
      ])
      const store = messageStoreBus.getOrCreate(instanceId)

      assert.deepEqual(store.getScrollSnapshot("session-1", "message-stream"), snapshot)
      assert.deepEqual(events, [])
    } finally {
      stopListening()
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("clears rehydrate values without publishing permanent instance removal", () => {
    const instanceId = "scroll-rehydrate-cleanup"
    const store = messageStoreBus.getOrCreate(instanceId)
    let removals = 0
    const stopListening = messageStoreBus.onInstanceDestroyed((id) => {
      if (id === instanceId) removals += 1
    })

    try {
      store.restoreScrollSnapshot("session-1", "message-stream", {
        scrollTop: 80,
        atBottom: false,
        updatedAt: 1234,
      })
      messageStoreBus.clearInstanceScrollSnapshots(instanceId)

      assert.equal(store.getScrollSnapshot("session-1", "message-stream"), undefined)
      assert.equal(removals, 0)

      messageStoreBus.unregisterInstance(instanceId)
      assert.equal(removals, 1)
    } finally {
      stopListening()
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("preserves scroll and invalidates message hydration during render-cache eviction", () => {
    const instanceId = "scroll-render-cache-eviction"
    const store = messageStoreBus.getOrCreate(instanceId)
    const snapshot = { scrollTop: 240, atBottom: false, updatedAt: 2400 }
    setMessagesLoaded((prev) => new Map(prev).set(instanceId, new Set(["session-1"])))
    try {
      store.restoreScrollSnapshot("session-1", "message-stream", snapshot)
      store.clearSession("session-1", { preserveScroll: true })
      assert.deepEqual(store.getScrollSnapshot("session-1", "message-stream"), snapshot)
      assert.equal(messagesLoaded().get(instanceId)?.has("session-1") ?? false, false)
    } finally {
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("does not replace newer runtime scroll with a late native seed", () => {
    const instanceId = "scroll-late-seed"
    const store = messageStoreBus.getOrCreate(instanceId)
    const current = { scrollTop: 300, atBottom: false, updatedAt: 3000 }
    try {
      store.restoreScrollSnapshot("session-1", "message-stream", current)
      messageStoreBus.seedScrollSnapshots(instanceId, [{
        sessionId: "session-1",
        scope: "message-stream",
        snapshot: { scrollTop: 100, atBottom: false, updatedAt: 1000 },
      }])
      assert.deepEqual(store.getScrollSnapshot("session-1", "message-stream"), current)
    } finally {
      messageStoreBus.unregisterInstance(instanceId)
    }
  })
})

describe("authoritative message removal", () => {
  it("publishes omitted ids and clears render caches outside transcript accounting", () => {
    const instanceId = "authoritative-omission", sessionId = "session"
    const store = messageStoreBus.getOrCreate(instanceId)
    const removed: string[] = []
    const stopListening = messageStoreBus.onMessagesRemoved((id, removedSessionId, messageIds) => {
      if (id === instanceId && removedSessionId === sessionId) removed.push(...messageIds)
    })
    const cacheEntry = { instanceId, sessionId, scope: "markdown", cacheId: "old-part", version: "1" }

    try {
      store.hydrateMessages(sessionId, [{ id: "old", sessionId, role: "assistant", status: "complete" }])
      setCacheEntry(cacheEntry, "retained render output")
      store.hydrateMessages(sessionId, [{ id: "new", sessionId, role: "user", status: "complete" }])

      assert.deepEqual(removed, ["old"])
      assert.equal(getCacheEntry(cacheEntry), undefined)

      setCacheEntry(cacheEntry, "new retained render output")
      store.reconcileEmptyAuthoritativeSnapshot(sessionId)
      assert.deepEqual(removed, ["old", "new"])
      assert.equal(getCacheEntry(cacheEntry), undefined)
    } finally {
      stopListening()
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("clears global caches for direct deletion and revert pruning", () => {
    const instanceId = "direct-and-revert-removal", sessionId = "session"
    const store = messageStoreBus.getOrCreate(instanceId)
    const removed: string[] = []
    const stopListening = messageStoreBus.onMessagesRemoved((id, removedSessionId, messageIds) => {
      if (id === instanceId && removedSessionId === sessionId) removed.push(...messageIds)
    })
    const cacheEntry = { instanceId, sessionId, scope: "tool-call", cacheId: "part", version: "1" }

    try {
      store.hydrateMessages(sessionId, [{ id: "direct", sessionId, role: "assistant", status: "complete" }])
      setCacheEntry(cacheEntry, "direct cache")
      store.removeMessage("direct", sessionId)
      assert.deepEqual(removed, ["direct"])
      assert.equal(getCacheEntry(cacheEntry), undefined)

      store.hydrateMessages(sessionId, [
        { id: "keep", sessionId, role: "user", status: "complete" },
        { id: "revert", sessionId, role: "assistant", status: "complete" },
      ])
      setCacheEntry(cacheEntry, "revert cache")
      store.setSessionRevert(sessionId, { messageID: "revert" })
      assert.deepEqual(removed, ["direct", "revert"])
      assert.equal(getCacheEntry(cacheEntry), undefined)
    } finally {
      stopListening()
      messageStoreBus.unregisterInstance(instanceId)
    }
  })
})
