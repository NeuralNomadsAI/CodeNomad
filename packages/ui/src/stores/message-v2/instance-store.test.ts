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

describe("message-v2 hydrateMessages vs pending optimistic sends", () => {
  it("keeps a locally-pending 'sending' message visible when a force reload snapshot doesn't include it yet", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    // Simulate the optimistic bubble created when the user hits send,
    // before the server has echoed the message back in any REST snapshot.
    store.upsertMessage({
      id: "msg-temp-1",
      sessionId: "session-1",
      role: "user",
      status: "sending",
      parts: [{ type: "text", text: "hello" } as any],
      isEphemeral: true,
    })
    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-temp-1"])

    // A force reload (e.g. triggered by an SSE reconnect after backgrounding)
    // resolves with a server snapshot that doesn't include the pending send
    // yet -- it hasn't been echoed back by the server at snapshot time.
    store.hydrateMessages("session-1", [
      { id: "msg-older", sessionId: "session-1", role: "assistant", status: "complete", parts: [{ type: "text", text: "hi" } as any] },
    ])

    // The optimistic bubble must still be visible -- not silently dropped --
    // and must still be findable (status "sending", isEphemeral) so a later
    // SSE echo can cleanly replace it instead of creating a duplicate record.
    const idsAfterHydrate = store.getSessionMessageIds("session-1")
    assert.ok(idsAfterHydrate.includes("msg-temp-1"), "pending optimistic message should remain visible")
    assert.ok(idsAfterHydrate.includes("msg-older"))
    const pending = store.getMessage("msg-temp-1")
    assert.equal(pending?.status, "sending")
    assert.equal(pending?.isEphemeral, true)

    // Once the server confirms the send with its real id, replaceMessageId
    // swaps it in place -- no duplicate id should ever appear.
    store.replaceMessageId({ oldId: "msg-temp-1", newId: "msg-real-1" })
    const idsAfterReplace = store.getSessionMessageIds("session-1")
    assert.equal(idsAfterReplace.filter((id) => id === "msg-real-1" || id === "msg-temp-1").length, 1)
    assert.ok(!idsAfterReplace.includes("msg-temp-1"))

    // A subsequent force reload that now DOES include the confirmed message
    // must not produce a duplicate entry either.
    store.hydrateMessages("session-1", [
      { id: "msg-older", sessionId: "session-1", role: "assistant", status: "complete", parts: [{ type: "text", text: "hi" } as any] },
      { id: "msg-real-1", sessionId: "session-1", role: "user", status: "complete", parts: [{ type: "text", text: "hello" } as any] },
    ])
    const finalIds = store.getSessionMessageIds("session-1")
    assert.equal(finalIds.filter((id) => id === "msg-real-1").length, 1)
    assert.equal(new Set(finalIds).size, finalIds.length, "no duplicate ids should ever appear")
  })

  it("drops a pending 'sending' message once the server snapshot confirms it under the same id", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.upsertMessage({
      id: "msg-1",
      sessionId: "session-1",
      role: "user",
      status: "sending",
      parts: [{ type: "text", text: "hello" } as any],
      isEphemeral: true,
    })

    // Server snapshot echoes the SAME id back, now complete -- the normal case.
    store.hydrateMessages("session-1", [
      { id: "msg-1", sessionId: "session-1", role: "user", status: "complete", parts: [{ type: "text", text: "hello" } as any] },
    ])

    const ids = store.getSessionMessageIds("session-1")
    assert.deepEqual(ids, ["msg-1"])
    assert.equal(store.getMessage("msg-1")?.status, "complete")
  })
})
