import assert from "node:assert/strict"
import { describe, it } from "node:test"

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

  it("prepends older cache pages without overwriting live messages", () => {
    const store = createInstanceMessageStore("instance-1")
    store.mergeCachedMessages("session-1", [message("message-3"), message("message-4")])
    store.upsertMessage({
      ...message("message-4"),
      parts: [{ id: "part-message-4", type: "text", text: "live", messageID: "message-4", sessionID: "session-1" }] as any,
    })
    store.mergeCachedMessages("session-1", [message("message-1"), message("message-2"), message("message-4")])

    assert.deepEqual(store.getSessionMessageIds("session-1"), ["message-1", "message-2", "message-3", "message-4"])
    assert.equal((store.getMessage("message-4")?.parts["part-message-4"]?.data as any).text, "live")
  })
})
