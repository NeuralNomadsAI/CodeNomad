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
        data: { ...base.data, ordinal: 1, delta: "thinking" },
      })

      const message = messageStoreBus.getOrCreate(instanceId).getMessage("assistant")
      assert.equal(message?.status, "streaming")
      assert.equal((message?.parts["assistant-text-0"]?.data as any)?.text, "hello world")
      assert.equal((message?.parts["assistant-reasoning-1"]?.data as any)?.text, "thinking")
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
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "hello")

      store.upsertMessage({
        id: "assistant", sessionId: "session", role: "assistant", status: "streaming",
        parts: [{ id: "assistant-text-0", type: "text", text: "", sessionID: "session", messageID: "assistant" }],
      })
      reapplyNativeContentDeltas(instanceId, "session")
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "hello")

      settleNativeContentDeltas(instanceId, "session")
      applyNativeContentDelta(instanceId, { ...event, id: "late-event", data: { ...event.data, delta: " late" } })
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "hello")
      reconcileNativeContentAfterSnapshot(instanceId, "session")
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "hello")
      assert.equal(store.getMessage("assistant")?.status, "complete")
      store.upsertMessage({ id: "assistant", sessionId: "session", role: "assistant", status: "streaming" })
      reconcileNativeContentAfterSnapshot(instanceId, "session")
      assert.equal(store.getMessage("assistant")?.status, "complete")
    } finally {
      clearNativeContentDeltaState(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("renders parts in ordinal order even when events arrive out of order", () => {
    const instanceId = "ordered-native-streaming"
    const data = { sessionID: "session", assistantMessageID: "assistant" }
    try {
      applyNativeContentDelta(instanceId, {
        id: "second", created: 2, type: "session.reasoning.delta",
        data: { ...data, ordinal: 1, delta: "second" },
      })
      applyNativeContentDelta(instanceId, {
        id: "first", created: 1, type: "session.text.delta",
        data: { ...data, ordinal: 0, delta: "first" },
      })
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getMessage("assistant")?.partIds, [
        "assistant-text-0",
        "assistant-reasoning-1",
      ])
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
