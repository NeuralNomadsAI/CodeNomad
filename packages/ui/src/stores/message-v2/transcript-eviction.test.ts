import assert from "node:assert/strict"
import { it } from "node:test"
import { createInstanceMessageStore } from "./instance-store.ts"

it("releases transcript payloads and owned indexes, preserving siblings and the restoration snapshot", async () => {
  const cleared: string[] = []
  const store = createInstanceMessageStore("eviction-release", {
    onSessionCleared: (_instanceId, sessionId) => cleared.push(sessionId),
  })
  for (const sessionId of ["target", "sibling"]) {
    store.upsertMessage({
      id: sessionId, sessionId, role: "assistant", status: "complete",
      parts: [{ id: "text", type: "text", text: "x".repeat(1024 * 1024) } as any],
    })
    store.setMessageInfo(sessionId, {
      id: sessionId, sessionID: sessionId, role: "assistant", cost: 1,
      time: { created: 1, completed: 2 },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } as any)
    store.bufferPendingPart({
      messageId: `pending-${sessionId}`, sessionId,
      part: { id: "part", type: "text", text: "pending" } as any, receivedAt: Date.now(),
    })
    store.setScrollSnapshot(sessionId, "message-stream", {
      scrollTop: 42, atBottom: false, windowIsLatest: false, windowCursor: "older", newerCursors: [null],
    })
    store.upsertPermission({
      permission: { id: `permission-${sessionId}`, sessionID: sessionId, action: "edit", resources: [] },
      messageId: sessionId, partId: "tool", enqueuedAt: sessionId === "target" ? 1 : 2,
    })
  }
  store.upsertPermission({
    permission: { id: "unattached", sessionID: "target", action: "edit", resources: [] }, enqueuedAt: 3,
  })
  const snapshot = store.getScrollSnapshot("target", "message-stream")
  assert.ok(await store.estimateSessionRetainedBytes("target") > 1024 * 1024)

  try {
    store.evictSessionTranscript("target")

    // Checking just the visible ID list hides merging-setter retention bugs.
    assert.equal(store.getMessage("target"), undefined)
    assert.deepEqual(Object.keys(store.state.messages), ["sibling"])
    assert.equal(store.state.sessions.target, undefined)
    assert.equal(store.state.messageInfoVersion.target, undefined)
    assert.equal(store.getMessageInfo("target"), undefined)
    assert.equal(store.state.usage.target, undefined)
    assert.equal(store.state.sessionRevisions.target, undefined)
    assert.equal(store.state.lastAssistantMessageIds.target, undefined)
    assert.equal(store.state.pendingParts["pending-target"], undefined)
    assert.equal(store.state.permissions.byMessage.target, undefined)
    assert.equal(store.state.permissions.byMessage.__global__, undefined)
    assert.deepEqual(store.state.permissions.queue.map(entry => entry.permission.id), ["permission-sibling"])
    assert.equal(store.state.permissions.active?.permission.id, "permission-sibling")
    assert.equal(store.getScrollSnapshot("target", "message-stream"), snapshot)
    assert.equal(await store.estimateSessionRetainedBytes("target"), 0)
    assert.ok(store.state.pendingParts["pending-sibling"])
    assert.ok(await store.estimateSessionRetainedBytes("sibling") > 1024 * 1024)
    assert.deepEqual(cleared, ["target"])

    store.clearSession("target")
    assert.equal(store.getScrollSnapshot("target", "message-stream"), undefined)
    assert.ok(store.getScrollSnapshot("sibling", "message-stream"))
    store.upsertMessage({ id: "target", sessionId: "target", role: "assistant", status: "complete" })
    assert.deepEqual(store.getMessage("target")?.partIds, [])
  } finally {
    store.clearInstance()
  }
})
