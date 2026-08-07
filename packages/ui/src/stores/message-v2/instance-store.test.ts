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
  it("keeps an in-flight pending 'sending' message visible when a force reload snapshot doesn't include it yet", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    // Simulate the optimistic bubble created when the user hits send, before
    // the server has echoed the message back in any REST snapshot. The send
    // path registers it as in-flight right after the optimistic insert.
    store.upsertMessage({
      id: "msg-temp-1",
      sessionId: "session-1",
      role: "user",
      status: "sending",
      parts: [{ type: "text", text: "hello" } as any],
      isEphemeral: true,
    })
    store.markSendPending("msg-temp-1")
    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-temp-1"])

    // A force reload (e.g. triggered by an SSE reconnect after backgrounding)
    // resolves with a server snapshot that doesn't include the pending send
    // yet -- it hasn't been echoed back by the server at snapshot time.
    store.hydrateMessages("session-1", [
      { id: "msg-older", sessionId: "session-1", role: "assistant", status: "complete", parts: [{ type: "text", text: "hi" } as any] },
    ])

    // The optimistic bubble must still be visible -- not silently dropped --
    // so the eventual same-id confirmation can update it in place.
    const idsAfterHydrate = store.getSessionMessageIds("session-1")
    assert.deepEqual(idsAfterHydrate, ["msg-older", "msg-temp-1"])
    const pending = store.getMessage("msg-temp-1")
    assert.equal(pending?.status, "sending")
    assert.equal(pending?.isEphemeral, true)
  })

  it("reconciles a same-id confirmation in place, retiring the pending marker and keeping metadata", () => {
    // Identity reconciliation: the client sends its optimistic id as
    // messageID, so the server confirms the send under the SAME id. The
    // record is updated in place (no duplicate, no replaceMessageId needed),
    // and the client-only prompt-display metadata carries over via `previous`.
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    const displayMetadata = { segments: [{ kind: "pasted" as const, length: 1200 }] }
    store.upsertMessage({
      id: "msg-1", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "hello" } as any], isEphemeral: true,
      clientPromptDisplayMetadata: displayMetadata as any,
    })
    store.markSendPending("msg-1")

    store.hydrateMessages("session-1", [
      // The REST bridge always sets isEphemeral explicitly (false for a
      // confirmed non-streaming message), so mirror that here.
      { id: "msg-1", sessionId: "session-1", role: "user", status: "complete", isEphemeral: false, parts: [{ type: "text", text: "hello" } as any] },
    ])

    const record = store.getMessage("msg-1")
    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-1"])
    assert.equal(record?.status, "complete")
    assert.equal(record?.isEphemeral, false)
    assert.deepEqual(record?.clientPromptDisplayMetadata, displayMetadata, "metadata survives the same-id confirmation")
  })

  it("dedupes repeated snapshot ids so messageIds never repeat", () => {
    // Gatekeeper reproduction: a duplicated server record made the id appear
    // twice in session.messageIds ([real, real]).
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    const duplicated = { id: "msg-real-1", sessionId: "session-1", role: "user" as const, status: "complete" as const, createdAt: 2000, parts: [{ type: "text", text: "ok" } as any] }
    store.hydrateMessages("session-1", [duplicated, duplicated])

    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-real-1"])
  })

  it("drops a definitively failed send on the next authoritative snapshot", () => {
    // promptAsync rejection retires the in-flight marker (clearSendPending).
    // The failed bubble stays visible until the next authoritative snapshot,
    // which must then drop it instead of preserving it forever as "sending".
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.upsertMessage({
      id: "msg-failed", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "do the thing" } as any], isEphemeral: true,
    })
    store.markSendPending("msg-failed")

    // The request fails terminally.
    store.clearSendPending("msg-failed")

    // Immediately after the failure the bubble is still visible (unchanged
    // pre-existing UX); the next authoritative snapshot drops it.
    store.hydrateMessages("session-1", [
      { id: "msg-older", sessionId: "session-1", role: "assistant", status: "complete", parts: [{ type: "text", text: "hi" } as any] },
    ])
    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-older"])
    assert.equal(store.getMessage("msg-failed"), undefined, "failed send must not survive authoritative hydration")
  })

  it("preserves only still-pending sends across an authoritative empty snapshot", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.hydrateMessages("session-1", [
      { id: "msg-stale", sessionId: "session-1", role: "user", status: "complete", parts: [{ type: "text", text: "old" } as any] },
    ])
    store.upsertMessage({
      id: "msg-inflight", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "new" } as any], isEphemeral: true,
    })
    store.markSendPending("msg-inflight")

    // Server authoritatively reports zero messages on a forced reconnect load.
    store.reconcileEmptyAuthoritativeSnapshot("session-1")

    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-inflight"], "stale records cleared, in-flight send preserved")
    assert.equal(store.getMessage("msg-stale"), undefined)
  })

  it("does not bump messageInfoVersion when the hydrated info is unchanged", () => {
    // An identical snapshot (common on a reconnect force-reload) must not
    // invalidate message-block render caches via messageInfoVersion.
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
