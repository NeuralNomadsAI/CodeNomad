import assert from "node:assert/strict"
import test from "node:test"
import { messageStoreBus } from "./message-v2/bus.ts"
import { runSessionMemorySweep, setVisibleSessionMemory } from "./session-memory.ts"
import { setSessions } from "./session-state.ts"

function addMessage(instanceId: string, sessionId: string, status: "complete" | "streaming" = "complete") {
  messageStoreBus.getOrCreate(instanceId).upsertMessage({
    id: `${sessionId}-message`,
    sessionId,
    role: "assistant",
    status,
    parts: [{ id: `${sessionId}-part`, type: "text", text: sessionId.repeat(100) }] as any,
  })
}

test("resident message budget evicts globally across five workspaces while preserving visible and streaming sessions", () => {
  const instanceIds = Array.from({ length: 5 }, (_, index) => `memory-workspace-${index}`)
  try {
    for (const instanceId of instanceIds) {
      addMessage(instanceId, "parent")
      addMessage(instanceId, "subagent")
    }
    addMessage(instanceIds[0], "streaming", "streaming")
    setVisibleSessionMemory(instanceIds[4], "parent", true)

    const protectedBytes = messageStoreBus.getInstance(instanceIds[4])!.getSessionApproximateByteSize("parent") +
      messageStoreBus.getInstance(instanceIds[0])!.getSessionApproximateByteSize("streaming")
    const evicted = runSessionMemorySweep(protectedBytes)

    assert.equal(evicted.length, 9)
    assert.deepEqual(messageStoreBus.getInstance(instanceIds[4])!.getSessionMessageIds("parent"), ["parent-message"])
    assert.deepEqual(messageStoreBus.getInstance(instanceIds[0])!.getSessionMessageIds("streaming"), ["streaming-message"])
    assert.deepEqual(messageStoreBus.getInstance(instanceIds[0])!.getSessionMessageIds("parent"), [])
    assert.deepEqual(messageStoreBus.getInstance(instanceIds[0])!.getSessionMessageIds("subagent"), [])
  } finally {
    setVisibleSessionMemory(instanceIds[4], "parent", false)
    for (const instanceId of instanceIds) messageStoreBus.unregisterInstance(instanceId)
  }
})

test("visible session leases keep a child resident until every visible owner releases it", () => {
  const instanceId = "memory-visible-leases", sessionId = "child"
  try {
    addMessage(instanceId, sessionId)
    setVisibleSessionMemory(instanceId, sessionId, true)
    setVisibleSessionMemory(instanceId, sessionId, true)
    setVisibleSessionMemory(instanceId, sessionId, false)

    assert.deepEqual(runSessionMemorySweep(0), [])
    setVisibleSessionMemory(instanceId, sessionId, false)
    assert.deepEqual(runSessionMemorySweep(0), [`${instanceId}\u0000${sessionId}`])
  } finally {
    setVisibleSessionMemory(instanceId, sessionId, false)
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("authoritative working status protects a resident session", () => {
  const instanceId = "memory-working-status", sessionId = "session"
  try {
    addMessage(instanceId, sessionId)
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, { id: sessionId, status: "working" } as any]])))
    assert.deepEqual(runSessionMemorySweep(0), [])

    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, { id: sessionId, status: "idle" } as any]])))
    assert.deepEqual(runSessionMemorySweep(0), [`${instanceId}\u0000${sessionId}`])
  } finally {
    setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
    messageStoreBus.unregisterInstance(instanceId)
  }
})

test("idle metadata cannot evict a normalized streaming message", () => {
  const instanceId = "memory-idle-streaming", sessionId = "session"
  try {
    addMessage(instanceId, sessionId, "streaming")
    setSessions((prev) => new Map(prev).set(instanceId, new Map([[sessionId, { id: sessionId, status: "idle" } as any]])))
    assert.deepEqual(runSessionMemorySweep(0), [])

    addMessage(instanceId, sessionId, "complete")
    assert.deepEqual(runSessionMemorySweep(0), [`${instanceId}\u0000${sessionId}`])
  } finally {
    setSessions((prev) => { const next = new Map(prev); next.delete(instanceId); return next })
    messageStoreBus.unregisterInstance(instanceId)
  }
})
