import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { clearEvictedSessionMessages } from "../../components/instance/shell/session-cache-eviction.ts"
import { messageStoreBus } from "./bus.ts"

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
    const loaded = new Map([[instanceId, new Set(["session-1"])]])
    const stopListening = messageStoreBus.onSessionCleared((id, sessionId) => loaded.get(id)?.delete(sessionId))
    try {
      store.restoreScrollSnapshot("session-1", "message-stream", snapshot)
      clearEvictedSessionMessages(store, "session-1")
      assert.deepEqual(store.getScrollSnapshot("session-1", "message-stream"), snapshot)
      assert.equal(loaded.get(instanceId)?.has("session-1") ?? false, false)
    } finally {
      stopListening()
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
