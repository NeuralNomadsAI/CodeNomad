import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createInstanceMessageStore } from "./instance-store.ts"
import { getSessionMessageRenderCache, peekSessionMessageRenderCache } from "../../lib/message-render-cache.ts"
import { buildRecordDisplayData } from "./record-display-cache.ts"
import { clearCacheForInstance, setCacheEntry } from "../../lib/global-cache.ts"

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
        source: { type: "tool", id: "call-1", messageID: "message-1" },
      },
      messageId: "message-1",
      partId: "part-1",
      enqueuedAt: 2_000,
    })

    assert.equal(store.state.permissions.queue.length, 1)
    assert.equal(store.getPermissionState(undefined, "permission-1"), null)
    assert.equal(store.getPermissionState("message-1", "part-1")?.entry.permission.source?.id, "call-1")
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

describe("message-v2 revert state", () => {
  it("prunes reverted messages and their question queue", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })
    store.hydrateMessages("session-1", [
      { id: "keep", sessionId: "session-1", role: "user", status: "complete" },
      { id: "revert", sessionId: "session-1", role: "assistant", status: "complete" },
    ])
    store.upsertQuestion({
      request: { id: "question", sessionID: "session-1", questions: [] },
      messageId: "revert", enqueuedAt: 1,
    })

    store.setSessionRevert("session-1", { messageID: "revert" })

    assert.deepEqual(store.getSessionMessageIds("session-1"), ["keep"])
    assert.equal(store.state.questions.queue.length, 0)
    assert.equal(store.state.questions.active, null)
  })

  it("accounts for added and cleared revert state without messages", async () => {
    let changes = 0
    const store = createInstanceMessageStore("instance-1", { onSessionChanged: () => { changes += 1 } })
    store.addOrUpdateSession({ id: "session-1" })
    const baselineChanges = changes

    store.setSessionRevert("session-1", { messageID: "revert", partID: "part" })
    assert.ok(await store.estimateSessionRetainedBytes("session-1") > 0)
    assert.equal(changes, baselineChanges + 1)

    store.setSessionRevert("session-1", null)
    assert.equal(await store.estimateSessionRetainedBytes("session-1"), 0)
    assert.equal(changes, baselineChanges + 2)
  })
})

describe("message-v2 hydrateMessages vs pending optimistic sends", () => {
  it("reports no retained transcript bytes for an empty session", async () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    assert.equal(await store.estimateSessionRetainedBytes("session-1"), 0)
  })

  it("accounts for render caches and clears them with session eviction", async () => {
    const store = createInstanceMessageStore("cache-accounting")
    store.addOrUpdateSession({ id: "session-1" })
    store.hydrateMessages("session-1", [{ id: "message-1", sessionId: "session-1", role: "assistant", status: "complete", parts: [{ id: "part-1", type: "text", text: "source" } as any] }])
    const baselineBytes = await store.estimateSessionRetainedBytes("session-1")
    const renderCache = getSessionMessageRenderCache("cache-accounting", "session-1")
    renderCache.recordDisplayCache.set("message-1", { revision: 1, data: { orderedParts: [{ text: "display-copy" }] } })
    const recordCachedBytes = await store.estimateSessionRetainedBytes("session-1")
    renderCache.messageBlocks.set("message-1", { text: "x".repeat(4_000) })

    const cachedBytes = await store.estimateSessionRetainedBytes("session-1")
    store.clearSession("session-1")

    assert.ok(recordCachedBytes > baselineBytes)
    assert.ok(cachedBytes > recordCachedBytes + 8_000)
    assert.equal(peekSessionMessageRenderCache("cache-accounting", "session-1"), undefined)
    assert.equal(await store.estimateSessionRetainedBytes("session-1"), 0)
  })

  it("clears derived caches with instance cleanup", () => {
    const store = createInstanceMessageStore("instance-cache-cleanup")
    store.hydrateMessages("session-1", [{ id: "message-1", sessionId: "session-1", role: "assistant", status: "complete" }])
    getSessionMessageRenderCache("instance-cache-cleanup", "session-1").messageBlocks.set("message-1", {})
    buildRecordDisplayData("instance-cache-cleanup", store.getMessage("message-1")!)

    store.clearInstance()

    assert.equal(peekSessionMessageRenderCache("instance-cache-cleanup", "session-1"), undefined)
  })

  it("accounts for the module display cache and associated orphan pending parts", async () => {
    const store = createInstanceMessageStore("cache-accounting-orphans")
    store.addOrUpdateSession({ id: "session-1" })
    store.hydrateMessages("session-1", [{ id: "message-1", sessionId: "session-1", role: "assistant", status: "complete", parts: [{ id: "part-1", type: "text", text: "source" } as any] }])
    const baseline = await store.estimateSessionRetainedBytes("session-1")
    buildRecordDisplayData("cache-accounting-orphans", store.getMessage("message-1")!)
    const displayCached = await store.estimateSessionRetainedBytes("session-1")
    store.bufferPendingPart({ messageId: "orphan", sessionId: "session-1", part: { type: "text", text: "x".repeat(4_000) } as any, receivedAt: Date.now() })
    const withPending = await store.estimateSessionRetainedBytes("session-1")

    store.clearSession("session-1")

    assert.ok(displayCached > baseline)
    assert.ok(withPending > displayCached + 8_000)
    assert.equal(store.state.pendingParts.orphan, undefined)
  })

  it("accounts session-owned global cache values without double-counting shared objects", async () => {
    const store = createInstanceMessageStore("global-cache-accounting")
    store.addOrUpdateSession({ id: "session-1" })
    const shared = { text: "x".repeat(4_000) }
    getSessionMessageRenderCache("global-cache-accounting", "session-1").messageBlocks.set("message", shared)
    const localBytes = await store.estimateSessionRetainedBytes("session-1")
    const cacheEntry = { instanceId: "global-cache-accounting", sessionId: "session-1", scope: "markdown", cacheId: "part", version: "1" }
    setCacheEntry(cacheEntry, { text: "y".repeat(4_000) })
    const uniqueBytes = await store.estimateSessionRetainedBytes("session-1")
    setCacheEntry(cacheEntry, shared)
    const sharedBytes = await store.estimateSessionRetainedBytes("session-1")

    assert.ok(uniqueBytes > localBytes + 8_000)
    assert.ok(sharedBytes > localBytes)
    assert.ok(sharedBytes < localBytes + 1_000)
    clearCacheForInstance("global-cache-accounting")
  })

  it("byte-bounds individual and aggregate pending parts while accounting session orphans", async () => {
    let changes = 0
    const invalidated: string[] = []
    const store = createInstanceMessageStore("pending-byte-cap", {
      onSessionChanged: () => { changes += 1 },
      onSessionCleared: (_instanceId, sessionId) => invalidated.push(sessionId),
    })
    store.bufferPendingPart({ messageId: "oversized", part: { type: "text", text: "x".repeat(600_000) } as any, receivedAt: 0 })
    assert.equal(store.state.pendingParts.oversized, undefined)

    store.bufferPendingPart({ messageId: "oversized-known", sessionId: "session-oversized", part: { type: "text", text: "x".repeat(600_000) } as any, receivedAt: 0 })
    assert.deepEqual(invalidated, ["session-oversized"])
    assert.equal(changes, 1)

    store.bufferPendingPart({ messageId: "session-orphan", sessionId: "session-1", part: { type: "text", text: "x".repeat(100_000) } as any, receivedAt: 1 })
    assert.ok(await store.estimateSessionRetainedBytes("session-1") > 0)
    assert.equal(changes, 2)

    for (let index = 0; index < 50; index += 1) {
      store.bufferPendingPart({ messageId: `orphan-${index}`, part: { type: "text", text: "x".repeat(100_000) } as any, receivedAt: index + 2 })
    }
    assert.ok(Object.values(store.state.pendingParts).flat().length < 51)
    store.clearInstance()
  })

  it("invalidates an unknown-owner pending drop when live ownership becomes known", () => {
    const invalidated: string[] = []
    const store = createInstanceMessageStore("pending-owner-reconciliation", {
      onSessionCleared: (_instanceId, sessionId) => invalidated.push(sessionId),
    })
    store.bufferPendingPart({ messageId: "unknown", part: { type: "text", text: "x".repeat(600_000) } as any, receivedAt: 0 })

    store.upsertMessage({ id: "unknown", sessionId: "session-1", role: "assistant", status: "streaming" })

    assert.deepEqual(invalidated, ["session-1"])
    store.clearInstance()
  })

  it("consumes an unknown-owner drop during authoritative hydration", () => {
    const invalidated: string[] = []
    const store = createInstanceMessageStore("pending-authoritative-reconciliation", {
      onSessionCleared: (_instanceId, sessionId) => invalidated.push(sessionId),
    })
    store.bufferPendingPart({ messageId: "known", part: { type: "text", text: "x".repeat(600_000) } as any, receivedAt: 0 })
    store.hydrateMessages("session-1", [{ id: "known", sessionId: "session-1", role: "assistant", status: "complete", parts: [{ id: "part", type: "text", text: "authoritative" } as any] }])

    assert.deepEqual(invalidated, [])
    assert.equal(store.getMessage("known")?.parts.part?.data.text, "authoritative")
    store.clearInstance()
  })

  it("caps pending-part bytes globally across instance stores", () => {
    const first = createInstanceMessageStore("pending-global-first")
    const second = createInstanceMessageStore("pending-global-second")
    for (let index = 0; index < 16; index += 1) {
      const store = index % 2 === 0 ? first : second
      store.bufferPendingPart({ messageId: `orphan-${index}`, part: { type: "text", text: "x".repeat(300_000) } as any, receivedAt: index })
    }
    const retained = Object.values(first.state.pendingParts).flat().length + Object.values(second.state.pendingParts).flat().length
    assert.ok(retained < 16)
    first.clearInstance()
    second.clearInstance()
  })

  it("caps pending parts that have no associated session", () => {
    const store = createInstanceMessageStore("pending-cap")
    for (let index = 0; index < 101; index += 1) {
      store.bufferPendingPart({ messageId: `unknown-${index}`, part: { type: "text", text: "late" } as any, receivedAt: Date.now() })
    }
    assert.equal(Object.keys(store.state.pendingParts).length, 100)
    assert.equal(store.state.pendingParts["unknown-0"], undefined)
  })

  it("caps pending parts per session and globally across arbitrary session ids", () => {
    const store = createInstanceMessageStore("pending-scoped-cap")
    for (let index = 0; index < 101; index += 1) {
      store.bufferPendingPart({ messageId: `same-${index}`, sessionId: "same", part: { type: "text", text: "late" } as any, receivedAt: index })
    }
    assert.equal(Object.values(store.state.pendingParts).flat().filter((entry) => entry.sessionId === "same").length, 100)
    assert.equal(store.state.pendingParts["same-0"], undefined)

    for (let index = 0; index < 501; index += 1) {
      store.bufferPendingPart({ messageId: `global-${index}`, sessionId: `arbitrary-${index}`, part: { type: "text", text: "late" } as any, receivedAt: 1_000 + index })
    }
    assert.equal(Object.values(store.state.pendingParts).flat().length, 500)
  })

  it("preserves prompt display overrides during volatile eviction but clears them explicitly", () => {
    const store = createInstanceMessageStore("volatile-eviction")
    const displayMetadata = { segments: [{ kind: "inline", length: 4 }] } as any
    store.upsertMessage({
      id: "message-1",
      sessionId: "session-1",
      role: "user",
      status: "complete",
      clientPromptDisplayMetadata: displayMetadata,
    })

    store.evictSessionTranscript("session-1")
    const restored = createInstanceMessageStore("volatile-eviction")
    restored.hydrateMessages("session-1", [{ id: "message-1", sessionId: "session-1", role: "user", status: "complete" }])
    assert.deepEqual(restored.getMessage("message-1")?.clientPromptDisplayMetadata, displayMetadata)

    store.clearSession("session-1")
    const cleared = createInstanceMessageStore("volatile-eviction")
    cleared.hydrateMessages("session-1", [{ id: "message-1", sessionId: "session-1", role: "user", status: "complete" }])
    assert.equal(cleared.getMessage("message-1")?.clientPromptDisplayMetadata, undefined)
    restored.clearInstance()
    cleared.clearInstance()
    store.clearInstance()
  })

  it("evicts the least recently used prompt display override after 512 entries", () => {
    const store = createInstanceMessageStore("prompt-display-count-cap")
    const displayMetadata = { segments: [{ kind: "inline", length: 4 }] } as any
    for (let index = 0; index < 512; index += 1) {
      store.upsertMessage({
        id: `message-${index}`,
        sessionId: "session-1",
        role: "user",
        status: "complete",
        clientPromptDisplayMetadata: displayMetadata,
      })
    }
    store.evictSessionTranscript("session-1")
    const reader = createInstanceMessageStore("prompt-display-count-cap")
    reader.hydrateMessages("session-1", [{ id: "message-0", sessionId: "session-1", role: "user", status: "complete" }])
    reader.upsertMessage({
      id: "message-512",
      sessionId: "session-1",
      role: "user",
      status: "complete",
      clientPromptDisplayMetadata: displayMetadata,
    })

    reader.evictSessionTranscript("session-1")
    const restored = createInstanceMessageStore("prompt-display-count-cap")
    restored.hydrateMessages("session-1", [
      { id: "message-0", sessionId: "session-1", role: "user", status: "complete" },
      { id: "message-1", sessionId: "session-1", role: "user", status: "complete" },
      { id: "message-512", sessionId: "session-1", role: "user", status: "complete" },
    ])

    assert.deepEqual(restored.getMessage("message-0")?.clientPromptDisplayMetadata, displayMetadata)
    assert.equal(restored.getMessage("message-1")?.clientPromptDisplayMetadata, undefined)
    assert.deepEqual(restored.getMessage("message-512")?.clientPromptDisplayMetadata, displayMetadata)
    reader.clearInstance()
    restored.clearInstance()
    store.clearInstance()
  })

  it("bounds prompt display overrides by aggregate and per-entry bytes", () => {
    const store = createInstanceMessageStore("prompt-display-byte-cap")
    const oversizedMetadata = { segments: Array.from({ length: 1_000 }, () => ({ kind: "inline", length: 1 })) } as any
    store.upsertMessage({
      id: "oversized",
      sessionId: "session-1",
      role: "user",
      status: "complete",
      clientPromptDisplayMetadata: oversizedMetadata,
    })
    for (let index = 0; index < 40; index += 1) {
      store.upsertMessage({
        id: `message-${index}`,
        sessionId: "session-1",
        role: "user",
        status: "complete",
        clientPromptDisplayMetadata: {
          segments: Array.from({ length: 300 }, () => ({ kind: "inline", length: index + 1 })),
        } as any,
      })
    }

    store.evictSessionTranscript("session-1")
    const restored = createInstanceMessageStore("prompt-display-byte-cap")
    restored.hydrateMessages("session-1", [
      { id: "oversized", sessionId: "session-1", role: "user", status: "complete" },
      { id: "message-0", sessionId: "session-1", role: "user", status: "complete" },
      { id: "message-39", sessionId: "session-1", role: "user", status: "complete" },
    ])

    assert.equal(restored.getMessage("oversized")?.clientPromptDisplayMetadata, undefined)
    assert.equal(restored.getMessage("message-0")?.clientPromptDisplayMetadata, undefined)
    assert.equal(restored.getMessage("message-39")?.clientPromptDisplayMetadata?.segments.length, 300)

    restored.clearInstance()
    const cleared = createInstanceMessageStore("prompt-display-byte-cap")
    cleared.hydrateMessages("session-1", [{ id: "message-39", sessionId: "session-1", role: "user", status: "complete" }])
    assert.equal(cleared.getMessage("message-39")?.clientPromptDisplayMetadata, undefined)
    cleared.clearInstance()
    store.clearInstance()
  })

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

  it("retains client part identity through a metadata-only same-id snapshot", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })
    store.upsertMessage({
      id: "msg-1", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ id: "client-part", type: "text", text: "hello", synthetic: true } as any], isEphemeral: true,
    })
    store.markSendPending("msg-1")
    store.hydrateMessages("session-1", [
      { id: "msg-1", sessionId: "session-1", role: "user", status: "complete", isEphemeral: false },
    ])

    store.confirmServerMessage("msg-1", { clearOptimisticParts: true })
    store.applyPartUpdate({
      messageId: "msg-1",
      part: { id: "server-part", type: "text", text: "hello" } as any,
    })

    assert.deepEqual(store.getMessage("msg-1")?.partIds, ["server-part"])
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
    // promptAsync rejection retires the in-flight marker and marks the bubble.
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
    store.failSend("msg-failed")
    assert.equal(store.getMessage("msg-failed")?.status, "error")

    // Immediately after the failure the bubble is still visible (unchanged
    // pre-existing UX); the next authoritative snapshot drops it.
    store.hydrateMessages("session-1", [
      { id: "msg-older", sessionId: "session-1", role: "assistant", status: "complete", parts: [{ type: "text", text: "hi" } as any] },
    ])
    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-older"])
    assert.equal(store.getMessage("msg-failed"), undefined, "failed send must not survive authoritative hydration")
  })

  it("settles an accepted send without waiting for an SSE echo", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })
    store.upsertMessage({
      id: "msg-accepted", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "hello", synthetic: true } as any], isEphemeral: true,
    })
    store.markSendPending("msg-accepted")

    store.acceptSend("msg-accepted")

    assert.equal(store.getMessage("msg-accepted")?.status, "sent")
    assert.equal(store.getMessage("msg-accepted")?.isEphemeral, false)
    store.reconcileEmptyAuthoritativeSnapshot("session-1")
    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-accepted"])
    store.reconcileEmptyAuthoritativeSnapshot("session-1")
    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-accepted"])

    store.confirmServerMessage("msg-accepted", { clearOptimisticParts: true })
    store.applyPartUpdate({
      messageId: "msg-accepted",
      part: { id: "server-part", type: "text", text: "hello", synthetic: false } as any,
    })
    assert.deepEqual(store.getMessage("msg-accepted")?.partIds, ["server-part"])
    assert.equal(store.getMessage("msg-accepted")?.isEphemeral, false)
  })

  it("clears only client-created parts when the server confirms a send", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })
    store.upsertMessage({
      id: "msg-1", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ id: "client-part", type: "text", text: "hello", synthetic: true } as any], isEphemeral: true,
    })
    store.markSendPending("msg-1")
    store.applyPartUpdate({
      messageId: "msg-1",
      part: { id: "server-synthetic", type: "text", text: "server", synthetic: true } as any,
    })

    store.confirmServerMessage("msg-1", { clearOptimisticParts: true })

    assert.deepEqual(store.getMessage("msg-1")?.partIds, ["server-synthetic"])
  })

  it("drops an unconfirmed accepted send once idle message authority settles", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })
    store.upsertMessage({
      id: "msg-unconfirmed", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "hello", synthetic: true } as any], isEphemeral: true,
    })
    store.markSendPending("msg-unconfirmed")
    store.acceptSend("msg-unconfirmed")

    store.retirePendingSends("session-1")
    store.reconcileEmptyAuthoritativeSnapshot("session-1")

    assert.equal(store.getMessage("msg-unconfirmed"), undefined)
  })

  it("preserves only still-pending sends across an authoritative empty snapshot", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.hydrateMessages("session-1", [
      { id: "msg-stale", sessionId: "session-1", role: "assistant", status: "complete", parts: [{ id: "todo-1", type: "tool", tool: "todowrite", state: { status: "completed", input: { todos: [] } } } as any] },
    ], [{
      id: "msg-stale", sessionID: "session-1", role: "assistant", time: { created: 1 },
      tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 1,
    } as any])
    store.bufferPendingPart({ messageId: "msg-stale", part: { type: "text", text: "late" } as any, receivedAt: Date.now() })
    store.upsertPermission({
      permission: { id: "permission-stale", sessionID: "session-1", action: "edit", resources: [] },
      messageId: "msg-stale",
      enqueuedAt: 1,
    })
    store.upsertQuestion({
      request: { id: "question-stale", sessionID: "session-1", questions: [] },
      messageId: "msg-stale",
      enqueuedAt: 1,
    })
    store.upsertMessage({
      id: "msg-inflight", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ type: "text", text: "new" } as any], isEphemeral: true,
    })
    store.markSendPending("msg-inflight")

    // Server authoritatively reports zero messages on a forced reconnect load.
    store.retirePendingSends("session-1")
    store.reconcileEmptyAuthoritativeSnapshot("session-1")

    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-inflight"], "stale records cleared, in-flight send preserved")
    assert.equal(store.getMessage("msg-stale"), undefined)
    assert.equal(store.state.pendingParts["msg-stale"], undefined)
    assert.equal(store.state.permissions.byMessage["msg-stale"], undefined)
    assert.equal(store.state.permissions.queue.length, 0)
    assert.equal(store.state.questions.byMessage["msg-stale"], undefined)
    assert.equal(store.state.questions.queue.length, 0)
    assert.equal(store.state.usage["session-1"].totalInputTokens, 0)
    assert.equal(store.getLatestTodoSnapshot("session-1"), undefined)
  })

  it("removes omitted records and derived state from a non-empty authoritative snapshot", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })
    store.hydrateMessages("session-1", [{
      id: "msg-old", sessionId: "session-1", role: "assistant", status: "complete",
      parts: [{ id: "todo-old", type: "tool", tool: "todowrite", state: { status: "completed", input: { todos: [] } } } as any],
    }], [{
      id: "msg-old", sessionID: "session-1", role: "assistant", time: { created: 1 },
      tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 1,
    } as any])
    store.bufferPendingPart({ messageId: "msg-old", part: { type: "text", text: "late" } as any, receivedAt: Date.now() })
    store.upsertPermission({
      permission: { id: "permission-old", sessionID: "session-1", action: "edit", resources: [] },
      messageId: "msg-old",
      enqueuedAt: 1,
    })
    store.upsertQuestion({
      request: { id: "question-old", sessionID: "session-1", questions: [] },
      messageId: "msg-old",
      enqueuedAt: 1,
    })

    store.hydrateMessages("session-1", [{
      id: "msg-new", sessionId: "session-1", role: "user", status: "complete",
      parts: [{ type: "text", text: "new" } as any],
    }], [{ id: "msg-new", sessionID: "session-1", role: "user", time: { created: 2 } } as any])

    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-new"])
    assert.equal(store.getMessage("msg-old"), undefined)
    assert.equal(store.state.pendingParts["msg-old"], undefined)
    assert.equal(store.state.permissions.byMessage["msg-old"], undefined)
    assert.equal(store.state.permissions.queue.length, 0)
    assert.equal(store.state.questions.byMessage["msg-old"], undefined)
    assert.equal(store.state.questions.queue.length, 0)
    assert.equal(store.state.usage["session-1"].totalInputTokens, 0)
    assert.equal(store.getLatestTodoSnapshot("session-1"), undefined)
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
