import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { messageStoreBus } from "./message-v2/bus.ts"
import {
  applyNativeContentDelta,
  clearNativeContentDeltaState,
  reconcileNativeContentAfterSnapshot,
  reapplyNativeContentDeltas,
  settleNativeContentDeltas,
} from "./native-session-streaming.ts"

const delay = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration))

describe("native session streaming", () => {
  it("creates assistant content and applies text and reasoning deltas immediately", () => {
    const instanceId = "native-streaming"
    const base = { id: "event", created: 10, data: { sessionID: "session", assistantMessageID: "assistant" } }

    try {
      assert.equal(applyNativeContentDelta(instanceId, {
        ...base,
        type: "session.text.delta",
        data: { ...base.data, ordinal: 0, delta: "hello" },
      }), true)
      applyNativeContentDelta(instanceId, {
        ...base,
        id: "event-2",
        type: "session.text.delta",
        data: { ...base.data, ordinal: 0, delta: " world" },
      })
      applyNativeContentDelta(instanceId, {
        ...base,
        id: "event-3",
        type: "session.reasoning.delta",
        data: { ...base.data, ordinal: 0, delta: "thinking" },
      })
      reapplyNativeContentDeltas(instanceId, "session")

      const message = messageStoreBus.getOrCreate(instanceId).getMessage("assistant")
      assert.equal(message?.status, "streaming")
      assert.equal((message?.parts["assistant-text-native-0"]?.data as any)?.text, "hello world")
      assert.equal((message?.parts["assistant-reasoning-native-0"]?.data as any)?.text, "thinking")
      assert.equal(message?.partIds.length, 2)
      assert.equal(messageStoreBus.getOrCreate(instanceId).getMessageInfo("assistant")?.sessionID, "session")
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("rejects malformed deltas without creating state", () => {
    const instanceId = "invalid-native-streaming"
    try {
      assert.equal(applyNativeContentDelta(instanceId, {
        type: "session.text.delta",
        data: { sessionID: "session", assistantMessageID: "", ordinal: 0, delta: "ignored" },
      } as any), false)
      assert.equal(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds("session").length, 0)
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("deduplicates replayed events and restores direct content after a stale snapshot", () => {
    const instanceId = "replayed-native-streaming"
    const event = {
      id: "event-1",
      created: 10,
      type: "session.text.delta" as const,
      data: { sessionID: "session", assistantMessageID: "assistant", ordinal: 0, delta: "hello" },
    }
    try {
      applyNativeContentDelta(instanceId, event)
      applyNativeContentDelta(instanceId, event)
      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-native-0"]?.data as any)?.text, "hello")

      store.upsertMessage({
        id: "assistant", sessionId: "session", role: "assistant", status: "streaming",
        parts: [{ id: "assistant-text-0", type: "text", text: "", sessionID: "session", messageID: "assistant" }],
      })
      reapplyNativeContentDeltas(instanceId, "session")
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "hello")
      assert.deepEqual(store.getMessage("assistant")?.partIds, ["assistant-text-0"])

      settleNativeContentDeltas(instanceId, "session")
      assert.equal(applyNativeContentDelta(instanceId, {
        ...event,
        id: "late-event",
        data: { ...event.data, ordinal: 1, delta: " late" },
      }), false)
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "hello")
      reconcileNativeContentAfterSnapshot(instanceId, "session")
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "hello")
      assert.equal(store.getMessage("assistant")?.status, "complete")
      store.upsertMessage({
        id: "assistant", sessionId: "session", role: "assistant", status: "complete",
        parts: [{ id: "assistant-text-0", type: "text", text: "hello", sessionID: "session", messageID: "assistant" }],
      })
      reconcileNativeContentAfterSnapshot(instanceId, "session")
      assert.deepEqual(store.getMessage("assistant")?.partIds, ["assistant-text-0"])
      store.upsertMessage({ id: "assistant", sessionId: "session", role: "assistant", status: "streaming" })
      reconcileNativeContentAfterSnapshot(instanceId, "session")
      assert.equal(store.getMessage("assistant")?.status, "complete")
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("orders out-of-order content parts by their source timestamp", () => {
    const instanceId = "ordered-native-streaming"
    const data = { sessionID: "session", assistantMessageID: "assistant" }
    try {
      applyNativeContentDelta(instanceId, {
        id: "second", created: 2, type: "session.text.delta",
        data: { ...data, ordinal: 1, delta: "world" },
      })
      applyNativeContentDelta(instanceId, {
        id: "first", created: 1, type: "session.text.delta",
        data: { ...data, ordinal: 0, delta: "hello " },
      })
      reapplyNativeContentDeltas(instanceId, "session")
      const message = messageStoreBus.getOrCreate(instanceId).getMessage("assistant")
      assert.deepEqual(message?.partIds, ["assistant-text-native-0", "assistant-text-native-1"])
      assert.equal((message?.parts["assistant-text-native-0"]?.data as any)?.text, "hello ")
      assert.equal((message?.parts["assistant-text-native-1"]?.data as any)?.text, "world")
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("preserves content type transitions as separate ordered parts", () => {
    const instanceId = "transition-native-streaming"
    const data = { sessionID: "session", assistantMessageID: "assistant" }
    try {
      applyNativeContentDelta(instanceId, {
        id: "text-1", created: 1, type: "session.text.delta",
        data: { ...data, ordinal: 0, delta: "before" },
      })
      applyNativeContentDelta(instanceId, {
        id: "reasoning", created: 2, type: "session.reasoning.delta",
        data: { ...data, ordinal: 0, delta: "thinking" },
      })
      applyNativeContentDelta(instanceId, {
        id: "text-2", created: 3, type: "session.text.delta",
        data: { ...data, ordinal: 1, delta: "after" },
      })
      reapplyNativeContentDeltas(instanceId, "session")

      const message = messageStoreBus.getOrCreate(instanceId).getMessage("assistant")
      assert.deepEqual(message?.partIds, [
        "assistant-text-native-0",
        "assistant-reasoning-native-0",
        "assistant-text-native-1",
      ])
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("does not duplicate a fragment already present in an ahead snapshot", () => {
    const instanceId = "ahead-snapshot-streaming"
    const data = { sessionID: "session", assistantMessageID: "assistant" }
    try {
      applyNativeContentDelta(instanceId, {
        id: "first", created: 1, type: "session.text.delta",
        data: { ...data, ordinal: 0, delta: "hello" },
      })
      const store = messageStoreBus.getOrCreate(instanceId)
      store.upsertMessage({
        id: "assistant", sessionId: "session", role: "assistant", status: "streaming",
        parts: [{ id: "assistant-text-0", type: "text", text: "hello world", sessionID: "session", messageID: "assistant" }],
      })
      reconcileNativeContentAfterSnapshot(instanceId, "session")
      applyNativeContentDelta(instanceId, {
        id: "second", created: 2, type: "session.text.delta",
        data: { ...data, ordinal: 0, delta: " world" },
      })
      reapplyNativeContentDeltas(instanceId, "session")

      const message = store.getMessage("assistant")
      assert.deepEqual(message?.partIds, ["assistant-text-0"])
      assert.equal((message?.parts["assistant-text-0"]?.data as any)?.text, "hello world")
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("keeps authoritative terminal content boundaries", () => {
    const instanceId = "terminal-boundaries-streaming"
    const data = { sessionID: "session", assistantMessageID: "assistant" }
    try {
      applyNativeContentDelta(instanceId, {
        id: "first", created: 1, type: "session.text.delta",
        data: { ...data, ordinal: 0, delta: "beforeafter" },
      })
      const store = messageStoreBus.getOrCreate(instanceId)
      store.upsertMessage({
        id: "assistant", sessionId: "session", role: "assistant", status: "complete",
        parts: [
          { id: "assistant-text-0", type: "text", text: "before", sessionID: "session", messageID: "assistant" },
          { id: "tool", type: "tool", tool: "test", sessionID: "session", messageID: "assistant" } as any,
          { id: "assistant-text-2", type: "text", text: "after", sessionID: "session", messageID: "assistant" },
        ],
      })
      settleNativeContentDeltas(instanceId, "session")
      reconcileNativeContentAfterSnapshot(instanceId, "session")

      assert.deepEqual(store.getMessage("assistant")?.partIds, ["assistant-text-0", "tool", "assistant-text-2"])
      assert.equal(store.getMessage("assistant")?.status, "complete")
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("does not overlay stale content across an authoritative tool boundary", () => {
    const instanceId = "tool-boundary-streaming"
    const data = { sessionID: "session", assistantMessageID: "assistant" }
    try {
      applyNativeContentDelta(instanceId, {
        id: "first", created: 1, type: "session.text.delta",
        data: { ...data, ordinal: 0, delta: "before" },
      })
      applyNativeContentDelta(instanceId, {
        id: "second", created: 2, type: "session.text.delta",
        data: { ...data, ordinal: 1, delta: "aftermore" },
      })
      const store = messageStoreBus.getOrCreate(instanceId)
      store.upsertMessage({
        id: "assistant", sessionId: "session", role: "assistant", status: "streaming",
        parts: [
          { id: "assistant-text-0", type: "text", text: "before", sessionID: "session", messageID: "assistant" },
          { id: "tool", type: "tool", tool: "test", sessionID: "session", messageID: "assistant" } as any,
          { id: "assistant-text-2", type: "text", text: "after", sessionID: "session", messageID: "assistant" },
        ],
      })
      reconcileNativeContentAfterSnapshot(instanceId, "session")

      assert.deepEqual(store.getMessage("assistant")?.partIds, ["assistant-text-0", "tool", "assistant-text-2"])
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "before")
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-2"]?.data as any)?.text, "aftermore")
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("coalesces long repeated-ordinal streams into one rendered part", () => {
    const instanceId = "long-native-streaming"
    const data = { sessionID: "session", assistantMessageID: "assistant" }
    try {
      for (let ordinal = 0; ordinal < 500; ordinal += 1) {
        applyNativeContentDelta(instanceId, {
          id: `event-${ordinal}`, created: ordinal, type: "session.text.delta",
          data: { ...data, ordinal: 0, delta: `${ordinal},` },
        })
      }
      applyNativeContentDelta(instanceId, {
        id: "replayed-ordinal", created: 501, type: "session.text.delta",
        data: { ...data, ordinal: 0, delta: "duplicate" },
      })
      reapplyNativeContentDeltas(instanceId, "session")

      const message = messageStoreBus.getOrCreate(instanceId).getMessage("assistant")
      assert.deepEqual(message?.partIds, ["assistant-text-native-0"])
      assert.equal((message?.parts["assistant-text-native-0"]?.data as any)?.text, `${Array.from({ length: 500 }, (_, index) => `${index},`).join("")}duplicate`)
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("coalesces rapid deltas on the render timer", async () => {
    const instanceId = "timed-native-streaming"
    const data = { sessionID: "session", assistantMessageID: "assistant", ordinal: 0 }
    try {
      applyNativeContentDelta(instanceId, {
        id: "first", created: 1, type: "session.text.delta", data: { ...data, delta: "a" },
      })
      applyNativeContentDelta(instanceId, {
        id: "second", created: 2, type: "session.text.delta", data: { ...data, delta: "b" },
      })
      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-native-0"]?.data as any)?.text, "a")
      await delay(25)
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-native-0"]?.data as any)?.text, "ab")
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("flushes pending deltas before settling and cancels cleared timers", async () => {
    const instanceId = "terminal-timer-streaming"
    const data = { sessionID: "session", assistantMessageID: "assistant", ordinal: 0 }
    try {
      applyNativeContentDelta(instanceId, {
        id: "first", created: 1, type: "session.text.delta", data: { ...data, delta: "a" },
      })
      applyNativeContentDelta(instanceId, {
        id: "second", created: 2, type: "session.text.delta", data: { ...data, delta: "b" },
      })
      settleNativeContentDeltas(instanceId, "session")
      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-native-0"]?.data as any)?.text, "ab")
      assert.equal(store.getMessage("assistant")?.status, "complete")

      clearNativeContentDeltaState(instanceId, "session")
      await delay(25)
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-native-0"]?.data as any)?.text, "ab")
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("preserves an authoritative error status during reconciliation", () => {
    const instanceId = "error-native-streaming"
    const data = { sessionID: "session", assistantMessageID: "assistant", ordinal: 0 }
    try {
      applyNativeContentDelta(instanceId, {
        id: "first", created: 1, type: "session.text.delta", data: { ...data, delta: "partial" },
      })
      const store = messageStoreBus.getOrCreate(instanceId)
      store.upsertMessage({ id: "assistant", sessionId: "session", role: "assistant", status: "error" })
      reconcileNativeContentAfterSnapshot(instanceId, "session")
      settleNativeContentDeltas(instanceId, "session")
      assert.equal(store.getMessage("assistant")?.status, "error")
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("rejects negative ordinals", () => {
    const instanceId = "negative-native-streaming"
    try {
      assert.equal(applyNativeContentDelta(instanceId, {
        id: "event", created: 1, type: "session.text.delta",
        data: { sessionID: "session", assistantMessageID: "assistant", ordinal: -1, delta: "ignored" },
      }), false)
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("does not recreate cleared session state during late reconciliation", () => {
    const instanceId = "cleared-native-streaming"
    try {
      applyNativeContentDelta(instanceId, {
        id: "event", created: 1, type: "session.text.delta",
        data: { sessionID: "session", assistantMessageID: "assistant", ordinal: 0, delta: "text" },
      })
      messageStoreBus.unregisterInstance(instanceId)
      clearNativeContentDeltaState(instanceId, "session")
      reapplyNativeContentDeltas(instanceId, "session")
      assert.equal(messageStoreBus.getInstance(instanceId), undefined)
    } finally {
      clearNativeContentDeltaState(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })
})
