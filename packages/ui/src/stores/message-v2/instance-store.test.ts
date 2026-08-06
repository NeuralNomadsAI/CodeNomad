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

  it("drops the optimistic bubble when the snapshot confirms the send under a DIFFERENT server id (no duplicate)", () => {
    // Reviewer's blocking case: the optimistic id is client-only and is never
    // sent to the server, so the normal confirmation arrives under a different
    // real id. If the force-reload snapshot already contains that real id,
    // preserving the temp id would leave BOTH visible ("real, temp") because
    // the SSE message.updated handler finds the real record and skips the
    // temp-id replacement. The temp must be matched by content and dropped.
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.upsertMessage({
      id: "msg-temp-1",
      sessionId: "session-1",
      role: "user",
      status: "sending",
      parts: [{ type: "text", text: "hello world" } as any],
      isEphemeral: true,
      createdAt: 1000,
    })
    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-temp-1"])

    // Snapshot contains the SAME send under the real server id (different id,
    // same text) while the temp is still present and un-replaced.
    store.hydrateMessages("session-1", [
      { id: "msg-real-1", sessionId: "session-1", role: "user", status: "complete", createdAt: 2000, parts: [{ type: "text", text: "hello world" } as any] },
    ])

    const ids = store.getSessionMessageIds("session-1")
    assert.deepEqual(ids, ["msg-real-1"], "only the real server id should remain")
    assert.ok(!ids.includes("msg-temp-1"), "the optimistic temp id must be dropped, not duplicated")
    assert.equal(store.getMessage("msg-temp-1"), undefined, "orphaned optimistic record must be cleaned up")
    assert.equal(new Set(ids).size, ids.length, "no duplicate ids")
  })

  it("does not preserve a different-text pending send as a false match", () => {
    // Guard the content match: an unrelated optimistic send (different text)
    // must still be preserved even if the snapshot brings other user messages.
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.upsertMessage({
      id: "msg-temp-1",
      sessionId: "session-1",
      role: "user",
      status: "sending",
      parts: [{ type: "text", text: "my in-flight message" } as any],
      isEphemeral: true,
    })

    store.hydrateMessages("session-1", [
      { id: "msg-real-1", sessionId: "session-1", role: "user", status: "complete", parts: [{ type: "text", text: "a completely different earlier message" } as any] },
    ])

    const ids = store.getSessionMessageIds("session-1")
    assert.ok(ids.includes("msg-temp-1"), "unrelated in-flight send must stay visible")
    assert.ok(ids.includes("msg-real-1"))
    assert.equal(store.getMessage("msg-temp-1")?.status, "sending")
  })

  it("does not falsely drop a second identical-text send against an already-loaded earlier one", () => {
    // Duplicate-text guard: only a NEW server id counts as the confirmation.
    // An earlier "ok" already in messageIds must not supersede a second,
    // still-in-flight "ok".
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    // Earlier confirmed "ok" already loaded under its real id.
    store.hydrateMessages("session-1", [
      { id: "msg-ok-1", sessionId: "session-1", role: "user", status: "complete", parts: [{ type: "text", text: "ok" } as any] },
    ])
    // Second "ok" now in flight (optimistic).
    store.upsertMessage({
      id: "msg-temp-ok", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "ok" } as any], isEphemeral: true,
    })

    // A reconnect snapshot that still only has the FIRST "ok" (second not yet
    // registered by the server). The temp must be preserved, not dropped.
    store.hydrateMessages("session-1", [
      { id: "msg-ok-1", sessionId: "session-1", role: "user", status: "complete", parts: [{ type: "text", text: "ok" } as any] },
    ])

    const ids = store.getSessionMessageIds("session-1")
    assert.ok(ids.includes("msg-temp-ok"), "second in-flight identical-text send must survive")
    assert.equal(store.getMessage("msg-temp-ok")?.status, "sending")
  })

  it("matches an attachment-only optimistic send by file signature (no text)", () => {
    // The content signature covers file parts, so an image/attachment send
    // with no caption is still de-duplicated on confirmation.
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.upsertMessage({
      id: "msg-temp-img", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "file", filename: "photo.png", url: "https://x/photo.png", mime: "image/png" } as any],
      isEphemeral: true,
      createdAt: 1000,
    })

    store.hydrateMessages("session-1", [
      { id: "msg-real-img", sessionId: "session-1", role: "user", status: "complete", createdAt: 2000,
        parts: [{ type: "file", filename: "photo.png", url: "https://x/photo.png", mime: "image/png" } as any] },
    ])

    const ids = store.getSessionMessageIds("session-1")
    assert.deepEqual(ids, ["msg-real-img"], "attachment-only send must de-dupe on confirmation")
    assert.equal(store.getMessage("msg-temp-img"), undefined)
  })

  it("matches confirmations one-to-one: two identical sends + one confirmation keeps the second pending", () => {
    // Regression for the shared-Set matching bug: with two simultaneous
    // optimistic "ok" sends and only ONE server confirmation, both temps were
    // dropped and the still-unsent second message was lost. Each confirmation
    // must be consumed exactly once.
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.upsertMessage({
      id: "msg-temp-1", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "ok" } as any], isEphemeral: true, createdAt: 1000,
    })
    store.upsertMessage({
      id: "msg-temp-2", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "ok" } as any], isEphemeral: true, createdAt: 1100,
    })

    // Snapshot confirms only ONE of the two sends.
    store.hydrateMessages("session-1", [
      { id: "msg-real-1", sessionId: "session-1", role: "user", status: "complete", createdAt: 2000, parts: [{ type: "text", text: "ok" } as any] },
    ])

    const ids = store.getSessionMessageIds("session-1")
    assert.deepEqual(ids, ["msg-real-1", "msg-temp-2"], "exactly one temp superseded; the other stays pending")
    assert.equal(store.getMessage("msg-temp-1"), undefined)
    assert.equal(store.getMessage("msg-temp-2")?.status, "sending")

    // When the second confirmation arrives, the remaining temp is dropped.
    store.hydrateMessages("session-1", [
      { id: "msg-real-1", sessionId: "session-1", role: "user", status: "complete", createdAt: 2000, parts: [{ type: "text", text: "ok" } as any] },
      { id: "msg-real-2", sessionId: "session-1", role: "user", status: "complete", createdAt: 2100, parts: [{ type: "text", text: "ok" } as any] },
    ])
    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-real-1", "msg-real-2"])
  })

  it("does not collide multi-part content with a single part containing the delimiter", () => {
    // Collision-safety: a server message with parts ["A", "B"] must not match
    // an optimistic send whose single text part is "A\nT:B" (the old
    // newline-joined signature), and trailing whitespace must not be trimmed
    // into a false match.
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.upsertMessage({
      id: "msg-temp-collision", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "A\nT:B" } as any], isEphemeral: true,
    })
    store.upsertMessage({
      id: "msg-temp-trailing", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "A " } as any], isEphemeral: true,
    })

    store.hydrateMessages("session-1", [
      // Two-part message ["A", "B"] — old signature equaled "A\nT:B".
      {
        id: "msg-real-parts", sessionId: "session-1", role: "user", status: "complete",
        parts: [{ type: "text", text: "A" } as any, { type: "text", text: "B" } as any],
      },
      // "A" must not match the pending "A " (trailing space).
      { id: "msg-real-trim", sessionId: "session-1", role: "user", status: "complete", parts: [{ type: "text", text: "A" } as any] },
    ])

    const ids = store.getSessionMessageIds("session-1")
    assert.ok(ids.includes("msg-temp-collision"), "delimiter-collision temp must survive")
    assert.ok(ids.includes("msg-temp-trailing"), "trailing-whitespace temp must survive")
    assert.equal(store.getMessage("msg-temp-collision")?.status, "sending")
    assert.equal(store.getMessage("msg-temp-trailing")?.status, "sending")
  })

  it("transfers clientPromptDisplayMetadata to the confirming server record on different-id reconcile", () => {
    // The server never sees clientPromptDisplayMetadata; when a snapshot
    // confirms an optimistic send under a new id, the real record must
    // inherit the temp's metadata (same as the SSE replaceMessageId path).
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    const displayMetadata = { segments: [{ kind: "pasted" as const, length: 1200 }] }
    store.upsertMessage({
      id: "msg-temp-pasted", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "big pasted text" } as any],
      isEphemeral: true,
      createdAt: 1000,
      clientPromptDisplayMetadata: displayMetadata as any,
    })

    store.hydrateMessages("session-1", [
      { id: "msg-real-pasted", sessionId: "session-1", role: "user", status: "complete", createdAt: 2000, parts: [{ type: "text", text: "big pasted text" } as any] },
    ])

    const real = store.getMessage("msg-real-pasted")
    assert.ok(real, "real record exists")
    assert.deepEqual(real?.clientPromptDisplayMetadata, displayMetadata, "metadata transferred from the superseded temp")
    assert.equal(store.getMessage("msg-temp-pasted"), undefined, "temp dropped")
  })

  it("does not supersede a pending send with an OLDER unrelated server message of identical content", () => {
    // Gatekeeper reproduction: a local pending "deploy" created at t=5000 was
    // deleted by an unrelated server "deploy" created at t=1000. A server
    // message can only confirm a send that happened BEFORE it was created.
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.upsertMessage({
      id: "msg-temp-deploy", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "deploy" } as any], isEphemeral: true, createdAt: 5000,
    })

    store.hydrateMessages("session-1", [
      { id: "msg-real-old", sessionId: "session-1", role: "user", status: "complete", createdAt: 1000, parts: [{ type: "text", text: "deploy" } as any] },
    ])

    const ids = store.getSessionMessageIds("session-1")
    assert.deepEqual(ids, ["msg-real-old", "msg-temp-deploy"], "older identical server message must not consume the newer pending send")
    assert.equal(store.getMessage("msg-temp-deploy")?.status, "sending")
  })

  it("dedupes repeated snapshot ids so one record cannot consume multiple pending sends", () => {
    // Gatekeeper reproduction: with two pending "ok" sends and ONE server
    // record duplicated in the snapshot, both temps were deleted and the
    // session ids became [real, real]. Duplicated input ids are collapsed
    // before candidate construction.
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.upsertMessage({
      id: "msg-temp-1", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "ok" } as any], isEphemeral: true, createdAt: 1000,
    })
    store.upsertMessage({
      id: "msg-temp-2", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "ok" } as any], isEphemeral: true, createdAt: 1100,
    })

    const duplicated = { id: "msg-real-1", sessionId: "session-1", role: "user" as const, status: "complete" as const, createdAt: 2000, parts: [{ type: "text", text: "ok" } as any] }
    store.hydrateMessages("session-1", [duplicated, duplicated])

    const ids = store.getSessionMessageIds("session-1")
    assert.deepEqual(ids, ["msg-real-1", "msg-temp-2"], "one real record consumes exactly one pending send; ids never repeat")
    assert.equal(store.getMessage("msg-temp-2")?.status, "sending")
  })

  it("does not bump messageInfoVersion when the hydrated info is unchanged", () => {
    // Issue 4: an identical snapshot (common on a reconnect force-reload) must
    // not invalidate message-block render caches via messageInfoVersion.
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    const info = { id: "msg-1", sessionID: "session-1", role: "user", time: { created: 1000 } } as any
    store.hydrateMessages(
      "session-1",
      [{ id: "msg-1", sessionId: "session-1", role: "user", status: "complete", parts: [{ type: "text", text: "hi" } as any] }],
      [info],
    )
    const versionAfterFirst = store.state.messageInfoVersion["msg-1"]

    // Re-hydrate with an identical info object.
    store.hydrateMessages(
      "session-1",
      [{ id: "msg-1", sessionId: "session-1", role: "user", status: "complete", parts: [{ type: "text", text: "hi" } as any] }],
      [{ id: "msg-1", sessionID: "session-1", role: "user", time: { created: 1000 } } as any],
    )
    assert.equal(store.state.messageInfoVersion["msg-1"], versionAfterFirst, "identical info must not bump the version")

    // A changed info DOES bump the version.
    store.hydrateMessages(
      "session-1",
      [{ id: "msg-1", sessionId: "session-1", role: "user", status: "complete", parts: [{ type: "text", text: "hi" } as any] }],
      [{ id: "msg-1", sessionID: "session-1", role: "user", time: { created: 1000, end: 2000 } } as any],
    )
    assert.equal(store.state.messageInfoVersion["msg-1"], (versionAfterFirst ?? 0) + 1, "changed info must bump the version")
  })
})
