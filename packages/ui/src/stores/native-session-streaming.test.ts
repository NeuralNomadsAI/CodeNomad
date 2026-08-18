import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { messageStoreBus } from "./message-v2/bus.ts"
import {
  applyNativeContentDelta,
  clearNativeContentDeltaState,
  estimateNativeContentDeltaRetainedBytes,
  reconcileNativeContentAfterSnapshot,
  reapplyNativeContentDeltas,
  settleNativeContentDeltas,
} from "./native-session-streaming.ts"

const delay = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration))
const data = { sessionID: "session", assistantMessageID: "assistant" }
const text = (id: string, ordinal: number, delta: string, created = ordinal) => ({
  id, created, type: "session.text.delta" as const, data: { ...data, ordinal, delta },
})

function cleanup(instanceId: string) {
  clearNativeContentDeltaState(instanceId)
  if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
}

describe("native session streaming", () => {
  it("rejects malformed native deltas at the event boundary", () => {
    const instanceId = "invalid-native-streaming"
    try {
      assert.equal(applyNativeContentDelta(instanceId, {
        type: "session.text.delta",
        data: { sessionID: "session", assistantMessageID: "", ordinal: 0, delta: "ignored" },
      } as any), false)
      assert.equal(applyNativeContentDelta(instanceId, text("negative", -1, "ignored")), false)
      assert.equal(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds("session").length, 0)
    } finally {
      cleanup(instanceId)
    }
  })

  it("deduplicates replayed events and restores deltas after a stale snapshot", () => {
    const instanceId = "replayed-native-streaming"
    const event = text("event-1", 0, "hello", 10)
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
    } finally {
      cleanup(instanceId)
    }
  })

  it("orders content parts by source time when native events arrive out of order", () => {
    const instanceId = "ordered-native-streaming"
    try {
      applyNativeContentDelta(instanceId, text("second", 1, "world", 2))
      applyNativeContentDelta(instanceId, text("first", 0, "hello ", 1))
      reapplyNativeContentDeltas(instanceId, "session")
      const message = messageStoreBus.getOrCreate(instanceId).getMessage("assistant")
      assert.deepEqual(message?.partIds, ["assistant-text-native-0", "assistant-text-native-1"])
      assert.equal((message?.parts["assistant-text-native-0"]?.data as any)?.text, "hello ")
      assert.equal((message?.parts["assistant-text-native-1"]?.data as any)?.text, "world")
    } finally {
      cleanup(instanceId)
    }
  })

  it("does not overlay stale deltas across an authoritative tool boundary", () => {
    const instanceId = "tool-boundary-streaming"
    try {
      applyNativeContentDelta(instanceId, text("first", 0, "before", 1))
      applyNativeContentDelta(instanceId, text("second", 1, "aftermore", 2))
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
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-2"]?.data as any)?.text, "aftermore")
    } finally {
      cleanup(instanceId)
    }
  })

  it("flushes pending deltas before settling and cancels cleared timers", async () => {
    const instanceId = "terminal-timer-streaming"
    try {
      applyNativeContentDelta(instanceId, text("first", 0, "a", 1))
      applyNativeContentDelta(instanceId, text("second", 0, "b", 2))
      settleNativeContentDeltas(instanceId, "session")
      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-native-0"]?.data as any)?.text, "ab")
      assert.equal(store.getMessage("assistant")?.status, "complete")

      clearNativeContentDeltaState(instanceId, "session")
      await delay(25)
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-native-0"]?.data as any)?.text, "ab")
    } finally {
      cleanup(instanceId)
    }
  })

  it("does not recreate cleared session state during late reconciliation", () => {
    const instanceId = "cleared-native-streaming"
    try {
      applyNativeContentDelta(instanceId, text("event", 0, "text", 1))
      messageStoreBus.unregisterInstance(instanceId)
      clearNativeContentDeltaState(instanceId, "session")
      reapplyNativeContentDeltas(instanceId, "session")
      assert.equal(messageStoreBus.getInstance(instanceId), undefined)
    } finally {
      cleanup(instanceId)
    }
  })

  it("accounts and releases native streaming state", async () => {
    const instanceId = "native-stream-accounting"
    try {
      applyNativeContentDelta(instanceId, text("event", 0, "retained text", 1))
      assert.ok(await estimateNativeContentDeltaRetainedBytes(instanceId, "session") > 0)
      clearNativeContentDeltaState(instanceId, "session")
      assert.equal(await estimateNativeContentDeltaRetainedBytes(instanceId, "session"), 0)
    } finally {
      cleanup(instanceId)
    }
  })
})
