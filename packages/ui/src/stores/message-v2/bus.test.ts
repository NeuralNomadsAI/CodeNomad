import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { messageStoreBus } from "./bus.ts"
import { messagesLoaded, setMessagesLoaded } from "../session-state.ts"

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

  it("clears loaded transcript authority when an instance id is unregistered", () => {
    const instanceId = "reused-message-authority"
    messageStoreBus.getOrCreate(instanceId)
    setMessagesLoaded((prev) => new Map(prev).set(instanceId, new Set(["session-1"])))

    messageStoreBus.unregisterInstance(instanceId)

    assert.equal(messagesLoaded().has(instanceId), false)
  })

  it("flushes registered scroll persisters until they unsubscribe, isolating failures", () => {
    const calls: string[] = []
    const stopFailing = messageStoreBus.onScrollSnapshotFlush(() => {
      calls.push("failing")
      throw new Error("flush failure")
    })
    const stop = messageStoreBus.onScrollSnapshotFlush(() => calls.push("persist"))
    try {
      messageStoreBus.flushScrollSnapshots()
      assert.deepEqual(calls, ["failing", "persist"])
      stopFailing()
      stop()
      messageStoreBus.flushScrollSnapshots()
      assert.deepEqual(calls, ["failing", "persist"])
    } finally {
      stopFailing()
      stop()
    }
  })

  it("replaces a stored position instead of merging a previous anchor into it", () => {
    const instanceId = "scroll-replace-anchor"
    const store = messageStoreBus.getOrCreate(instanceId)
    try {
      store.setScrollSnapshot("session-1", "message-stream", { scrollTop: 0, atBottom: false, anchorKey: "intended", anchorOffset: 0 })
      store.setScrollSnapshot("session-1", "message-stream", { scrollTop: 900, atBottom: true })
      const captured = store.getScrollSnapshot("session-1", "message-stream")
      assert.equal(captured?.anchorKey, undefined)
      assert.equal(captured?.anchorOffset, undefined)
      store.restoreScrollSnapshot("session-1", "message-stream", { scrollTop: 100, atBottom: false, anchorKey: "restored", anchorOffset: 4, updatedAt: 1 })
      store.restoreScrollSnapshot("session-1", "message-stream", { scrollTop: 0, atBottom: true, updatedAt: 2 })
      assert.equal(store.getScrollSnapshot("session-1", "message-stream")?.anchorKey, undefined)
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
