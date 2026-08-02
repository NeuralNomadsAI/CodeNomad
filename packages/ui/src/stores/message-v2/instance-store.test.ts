import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { estimateRetainedBytes } from "../../lib/session-memory-budget.ts"
import { createInstanceMessageStore } from "./instance-store.ts"

describe("message-v2 permission state", () => {
  it("keeps one permission attachment when a duplicate moves from global to a tool part", () => {
    const store = createInstanceMessageStore("instance-1")

    store.upsertPermission({
      permission: { id: "permission-1", sessionID: "session-1", action: "edit", resources: ["file-a.ts"] },
      enqueuedAt: 1_000,
    })
    store.upsertPermission({
      permission: {
        id: "permission-1",
        sessionID: "session-1",
        action: "edit",
        resources: ["file-a.ts"],
        source: { type: "tool", callID: "call-1", messageID: "message-1" },
      },
      messageId: "message-1",
      partId: "part-1",
      enqueuedAt: 2_000,
    })

    assert.equal(store.state.permissions.queue.length, 1)
    assert.equal(store.getPermissionState(undefined, "permission-1"), null)
    assert.equal((store.getPermissionState("message-1", "part-1")?.entry.permission as any).source?.callID, "call-1")
    assert.equal(store.getPermissionState("message-1", "part-1")?.active, true)
  })

  it("recalculates the active permission after removing the first queue entry", () => {
    const store = createInstanceMessageStore("instance-1")

    store.upsertPermission({ permission: { id: "permission-1", sessionID: "session-1", action: "edit", resources: [] }, enqueuedAt: 1_000 })
    store.upsertPermission({ permission: { id: "permission-2", sessionID: "session-1", action: "edit", resources: [] }, enqueuedAt: 2_000 })
    store.removePermission("permission-1")

    assert.equal(store.state.permissions.active?.permission.id, "permission-2")
    assert.equal(store.getPermissionState(undefined, "permission-2")?.active, true)
  })

  it("protects legacy pending permissions that use sessionId", () => {
    const store = createInstanceMessageStore("instance-1")
    store.upsertPermission({ permission: { id: "legacy", sessionId: "session-1", permission: "edit" }, enqueuedAt: 1 })
    assert.equal(store.hasSessionActiveWork("session-1"), true)
  })

  it("charges large canonical interruption payloads once to their session", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })
    store.addOrUpdateSession({ id: "session-2" })
    const baseline = store.getSessionApproximateByteSize("session-1")
    const permission = {
      id: "permission-large",
      sessionID: "session-1",
      action: "edit",
      resources: ["p".repeat(256 * 1024)],
    }
    const question = {
      id: "question-large",
      sessionID: "session-1",
      questions: [{ header: "Confirm", question: "q".repeat(256 * 1024), options: [] }],
    }

    store.upsertPermission({ permission, messageId: "message-1", partId: "part-1", enqueuedAt: 1 })
    store.upsertQuestion({ request: question as any, messageId: "message-1", partId: "part-1", enqueuedAt: 2 })
    const expected = baseline + 3 * (
      estimateRetainedBytes(store.state.permissions.queue[0]?.permission) +
      estimateRetainedBytes(store.state.questions.queue[0]?.request)
    )
    assert.equal(store.getSessionApproximateByteSize("session-1"), expected)
    assert.ok(store.getSessionApproximateByteSize("session-2") < expected / 2)

    store.upsertPermission({ permission, messageId: "message-1", partId: "part-1", enqueuedAt: 1 })
    store.upsertQuestion({ request: question as any, messageId: "message-1", partId: "part-1", enqueuedAt: 2 })
    assert.equal(store.state.permissions.queue.length, 1)
    assert.equal(store.state.questions.queue.length, 1)
    assert.equal(store.getSessionApproximateByteSize("session-1"), baseline + 3 * (
      estimateRetainedBytes(store.state.permissions.queue[0]?.permission) +
      estimateRetainedBytes(store.state.questions.queue[0]?.request)
    ))
  })

})

describe("message-v2 authoritative hydration", () => {
  const message = (id: string) => ({
    id,
    sessionId: "session-1",
    role: "assistant" as const,
    status: "complete" as const,
    parts: [{ id: `part-${id}`, type: "text", text: id, messageID: id, sessionID: "session-1" }] as any,
  })
  const info = (id: string) => ({ id, sessionID: "session-1", role: "assistant", time: { created: 1 } }) as any

  it("replaces stale messages and accepts an authoritative empty session", () => {
    const store = createInstanceMessageStore("instance-1")
    store.hydrateMessages("session-1", [message("message-1"), message("message-2")], [info("message-1"), info("message-2")])

    store.hydrateMessages("session-1", [message("message-2")], [info("message-2")])
    assert.equal(store.getMessage("message-1"), undefined)
    assert.equal(store.getMessageInfo("message-1"), undefined)
    assert.deepEqual(store.getSessionMessageIds("session-1"), ["message-2"])

    store.hydrateMessages("session-1", [], [])
    assert.equal(store.getMessage("message-2"), undefined)
    assert.deepEqual(store.getSessionMessageIds("session-1"), [])
  })

  it("removes stale parts when authoritative hydration returns an empty part list", () => {
    const store = createInstanceMessageStore("instance-1")
    store.hydrateMessages("session-1", [message("message-1")], [info("message-1")])

    store.hydrateMessages("session-1", [{ ...message("message-1"), parts: [] }], [info("message-1")])
    assert.deepEqual(store.getMessage("message-1")?.partIds, [])
    assert.deepEqual(store.getMessage("message-1")?.parts, {})
  })

  it("releases a directly removed message and its info version", () => {
    const store = createInstanceMessageStore("instance-1")
    store.hydrateMessages("session-1", [message("message-1")], [info("message-1")])
    store.removeMessage("message-1")
    assert.equal("message-1" in store.state.messages, false)
    assert.equal("message-1" in store.state.messageInfoVersion, false)
  })

  it("bumps authority when a revert anchor is not resident", () => {
    const store = createInstanceMessageStore("instance-1")
    store.hydrateMessages("session-1", [message("message-1")], [info("message-1")])
    const revision = store.getSessionRevision("session-1")
    store.setSessionRevert("session-1", { messageID: "evicted-anchor" })
    assert.ok(store.getSessionRevision("session-1") > revision)
  })
})
