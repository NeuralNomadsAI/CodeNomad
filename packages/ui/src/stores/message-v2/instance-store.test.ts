import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { createInstanceMessageStore } from "./instance-store.ts"
import type { MessageUpsertInput } from "./types.ts"
import {
  buildRecordDisplayData,
  clearRecordDisplayCacheForInstance,
  clearRecordDisplayCacheForMessages,
  getRecordDisplayPartIds,
  getRevealedRecordText,
  MESSAGE_PART_DISPLAY_LIMIT,
  MESSAGE_PART_REVEAL_STEP,
  revealHiddenRecordParts,
  revealHiddenRecordText,
} from "./record-display-cache.ts"
import { getSessionMessageRenderCache, purgeMessageRenderCache, REASONING_RENDER_CHARACTER_LIMIT } from "../../lib/message-render-cache.ts"
import type { MessageInfo, ClientPart } from "../../types/message"
import { emptyLatestWindow, toWindowSnapshot, windowFromSnapshot } from "./message-window"

it("keeps the beginning and final response when bounding message parts", () => {
  const partIds = Array.from({ length: MESSAGE_PART_DISPLAY_LIMIT + 2 }, (_, index) => `part-${index}`)
  const data = buildRecordDisplayData("bounded-parts", {
    id: "message", sessionId: "session", role: "assistant", status: "complete",
    createdAt: 1, updatedAt: 1, revision: 1, partIds,
    parts: Object.fromEntries(partIds.map((id) => [id, { id, revision: 1, data: { id, type: "text", text: id } }])),
  })

  assert.equal(data.orderedParts.length, MESSAGE_PART_DISPLAY_LIMIT)
  assert.equal(data.orderedParts[0]?.id, "part-0")
  assert.equal(data.orderedParts.at(-1)?.id, `part-${MESSAGE_PART_DISPLAY_LIMIT + 1}`)
  assert.equal(data.hiddenCount, 2)
  assert.equal(data.gapIndex, MESSAGE_PART_DISPLAY_LIMIT / 2)
  assert.equal(data.orderedParts[data.gapIndex]?.id, `part-${MESSAGE_PART_DISPLAY_LIMIT / 2 + 2}`)

  const displayPartIds = getRecordDisplayPartIds("bounded-parts", {
    id: "message", sessionId: "session", role: "assistant", status: "complete",
    createdAt: 1, updatedAt: 1, revision: 1, partIds,
    parts: {},
  })
  assert.equal(displayPartIds.length, MESSAGE_PART_DISPLAY_LIMIT)
  assert.equal(displayPartIds[0], "part-0")
  assert.equal(displayPartIds.at(-1), `part-${MESSAGE_PART_DISPLAY_LIMIT + 1}`)
})

it("reveals omitted parts in place and resets with the instance", () => {
  const total = MESSAGE_PART_DISPLAY_LIMIT + MESSAGE_PART_REVEAL_STEP + 5
  const partIds = Array.from({ length: total }, (_, index) => `part-${index}`)
  const record = {
    id: "message", sessionId: "session", role: "assistant" as const, status: "complete" as const,
    createdAt: 1, updatedAt: 1, revision: 1, partIds,
    parts: Object.fromEntries(partIds.map((id) => [id, { id, revision: 1, data: { id, type: "text" as const, text: id } }])),
  }
  const initial = buildRecordDisplayData("revealed-parts", record)
  assert.equal(initial.hiddenCount, MESSAGE_PART_REVEAL_STEP + 5)
  assert.equal(initial.hiddenStart, MESSAGE_PART_DISPLAY_LIMIT / 2)

  revealHiddenRecordParts("revealed-parts", "message")
  const partial = buildRecordDisplayData("revealed-parts", record)
  assert.notEqual(partial, initial, "revealing must invalidate the cached projection")
  assert.equal(partial.hiddenCount, 5)
  assert.equal(partial.orderedParts.length, total - 5)
  assert.equal(partial.orderedParts[partial.gapIndex - 1]?.id, `part-${MESSAGE_PART_DISPLAY_LIMIT / 2 + MESSAGE_PART_REVEAL_STEP - 1}`)
  assert.equal(partial.orderedParts[partial.gapIndex]?.id, `part-${MESSAGE_PART_DISPLAY_LIMIT / 2 + MESSAGE_PART_REVEAL_STEP + 5}`)

  revealHiddenRecordParts("revealed-parts", "message")
  const complete = buildRecordDisplayData("revealed-parts", record)
  assert.equal(complete.hiddenCount, 0)
  assert.deepEqual(complete.orderedParts.map((part) => part.id), partIds)
  assert.deepEqual(getRecordDisplayPartIds("revealed-parts", record), partIds)

  clearRecordDisplayCacheForInstance("revealed-parts")
  assert.equal(buildRecordDisplayData("revealed-parts", record).hiddenCount, MESSAGE_PART_REVEAL_STEP + 5)
})

it("keys text reveals by instance, message, part and section, and resets them with the instance", () => {
  const output = { instanceId: "revealed-text", messageId: "message", partId: "tool", section: "output" }
  const prompt = { ...output, section: "task:prompt" }
  const otherInstance = { ...output, instanceId: "other-instance" }
  assert.equal(getRevealedRecordText(output), 0)

  revealHiddenRecordText(output)
  revealHiddenRecordText(output)
  revealHiddenRecordText(otherInstance)
  assert.equal(getRevealedRecordText(output), 2)
  assert.equal(getRevealedRecordText({ ...output }), 2, "a structurally equal target reads the same reveal after a remount")
  assert.equal(getRevealedRecordText(prompt), 0, "sections of one tool part reveal independently")
  assert.equal(getRevealedRecordText({ ...output, messageId: "other-message" }), 0)

  clearRecordDisplayCacheForMessages("revealed-text", ["message"])
  assert.equal(getRevealedRecordText(output), 2, "evicting derived caches keeps what the user revealed")

  clearRecordDisplayCacheForInstance("revealed-text")
  assert.equal(getRevealedRecordText(output), 0)
  assert.equal(getRevealedRecordText(otherInstance), 1, "another instance keeps its reveals")
  clearRecordDisplayCacheForInstance("other-instance")
})

describe("message window replacement authority", () => {
  it("retires an older resume cursor when returning to latest before cold restoration", () => {
    const store = createInstanceMessageStore("window-replacement")
    store.setMessageWindow("session", { kind: "history", resumeCursor: "older-200", olderCursor: "older-400", newerCursors: [null] })
    const previous = store.getMessageWindow("session")
    store.setMessageWindow("session", emptyLatestWindow())
    const window = store.getMessageWindow("session")!
    assert.notEqual(window, previous, "Window identity fences in-flight page requests")
    assert.equal(window.resumeCursor, undefined)
    assert.equal(window.olderCursor, undefined)
    const snapshot = JSON.parse(JSON.stringify(toWindowSnapshot(window)))
    assert.deepEqual(windowFromSnapshot(snapshot), emptyLatestWindow())
    assert.deepEqual(windowFromSnapshot({ windowIsLatest: true, windowCursor: "stale-older" }), emptyLatestWindow())
  })
})

describe("staged undo usage authority", () => {
  for (const preserveOmitted of [false, true]) {
    it(`keeps visible usage stable on hydration (preserveOmitted=${preserveOmitted})`, () => {
      const store = createInstanceMessageStore("undo-usage")
      const records = ["msg_01", "msg_02", "msg_03"].map(id => ({ id, sessionId: "session", role: "assistant" as const, status: "complete" as const }))
      const infos = records.map((record, i) => ({ id: record.id, sessionID: "session", role: "assistant", time: { created: i + 1, completed: i + 1 }, cost: 1,
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })) as MessageInfo[]
      store.hydrateMessages("session", records, infos)
      store.setSessionRevert("session", { messageID: "msg_02" })
      const usage = JSON.parse(JSON.stringify(store.getSessionUsage("session")))
      assert.equal(usage.totalCost, 1)
      store.hydrateMessages("session", records, infos, { preserveOmitted })
      assert.deepEqual(store.getSessionMessageIds("session"), ["msg_01"])
      assert.deepEqual(store.getSessionUsage("session"), usage)
      // A native page can consist entirely of the staged tail; it must not
      // contribute usage even when the visible boundary is outside that page.
      store.hydrateMessages("session", records.slice(1), infos.slice(1), { preserveOmitted: true })
      assert.deepEqual(store.getSessionUsage("session"), usage)
      const cold = createInstanceMessageStore("undo-usage-cold")
      cold.setSessionRevert("session", { messageID: "msg_02" })
      cold.hydrateMessages("session", records, infos, { preserveOmitted })
      assert.deepEqual(cold.getSessionUsage("session"), usage)
      // Clearing the marker must allow the native tail and its usage back.
      store.setSessionRevert("session", null)
      store.hydrateMessages("session", records, infos, { preserveOmitted })
      assert.equal(store.getSessionUsage("session")?.totalCost, 3)
    })
  }
})

describe("message display cache authority", () => {
  it("changes display identity after eviction even when numeric revisions repeat", () => {
    const store = createInstanceMessageStore("display-identity")
    const base = { id: "assistant", sessionId: "session", role: "assistant" as const, status: "streaming" as const }
    store.hydrateMessages("session", [base])
    const original = store.getMessage(base.id)!
    const empty = buildRecordDisplayData("display-identity", original)
    assert.equal(empty.orderedParts.length, 0)

    store.reconcileEmptyAuthoritativeSnapshot("session")
    const completed = { ...base, parts: [{ id: "text", type: "text", text: "restored response" } as any] }
    store.hydrateMessages("session", [completed])
    const restored = store.getMessage(base.id)!
    const display = buildRecordDisplayData("display-identity", restored)
    assert.equal(restored.revision, original.revision)
    assert.notEqual(display, empty)
    assert.equal((display.orderedParts[0] as any).text, "restored response")

    store.hydrateMessages("session", [completed])
    assert.equal(buildRecordDisplayData("display-identity", store.getMessage(base.id)!), display,
      "an unchanged resident snapshot must still reuse display data")
  })

  it("binds the derived message block cache to the invalidatable display identity", () => {
    const source = readFileSync(new URL("../../components/message-block.tsx", import.meta.url), "utf8")
    assert.match(source, /cachedBlock\.signature === cacheSignature && cachedBlock\.displayData === displayData/)
    assert.match(source, /messageBlocks\.set\(current\.id, \{\s*signature: cacheSignature,\s*displayData,/)
  })

  it("projects whole reasoning text, streaming or completed, for the card's display window", () => {
    const longText = `${"t".repeat(REASONING_RENDER_CHARACTER_LIMIT)}ail beyond the bound`
    const reasoning = (completed?: number): { id: string; revision: number; data: ClientPart } => ({
      id: "reasoning", revision: 1,
      data: {
        id: "reasoning", type: "reasoning", text: longText,
        time: { created: 1, ...(completed !== undefined ? { completed } : {}) },
      } as ClientPart,
    })
    const recordFor = (part: { id: string; revision: number; data: ClientPart }, status: "streaming" | "complete") => ({
      id: "message", sessionId: "session", role: "assistant" as const, status,
      createdAt: 1, updatedAt: 1, revision: 1, partIds: ["reasoning"], parts: { reasoning: part },
    })

    const streaming = buildRecordDisplayData("reasoning-stream", recordFor(reasoning(), "streaming"))
    assert.equal((streaming.orderedParts[0] as any).text, longText, "a live stream reaches the card whole")

    clearRecordDisplayCacheForInstance("reasoning-stream")
    const completed = buildRecordDisplayData("reasoning-stream", recordFor(reasoning(2), "complete"))
    assert.equal((completed.orderedParts[0] as any).text, longText, "completion keeps what the reader could reveal")
  })
})

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

describe("message-v2 todo state", () => {
  it("does not expose a plan from before the latest compaction", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })
    store.hydrateMessages("session-1", [
      {
        id: "msg-todo", sessionId: "session-1", role: "assistant", status: "complete",
        parts: [{ id: "todo", type: "tool", tool: "todowrite", state: { status: "completed", input: { todos: [{ content: "Old task", status: "in_progress" }] } } } as any],
      },
      {
        id: "msg-compaction", sessionId: "session-1", role: "assistant", status: "complete",
        parts: [{ id: "compaction", type: "compaction" } as any],
      },
    ], [
      { id: "msg-todo", sessionID: "session-1", role: "assistant", time: { created: 1 } } as any,
      { id: "msg-compaction", sessionID: "session-1", role: "assistant", time: { created: 2 } } as any,
    ])

    assert.equal(store.getLatestTodoSnapshot("session-1"), undefined)
  })
})

describe("message-v2 hydrateMessages vs pending optimistic sends", () => {
  for (const { incoming, expected } of [
    { incoming: ["user", "first"], expected: ["older", "user", "first", "middle", "later"] },
    { incoming: ["first", "later", "new"], expected: ["older", "user", "first", "middle", "later", "new"] },
    { incoming: ["user", "first", "new"], expected: ["older", "user", "first", "middle", "later", "new"] },
    { incoming: ["new"], expected: ["older", "user", "first", "middle", "later", "new"] },
    // Shared rows retain the incoming order, including native inbox delivery.
    { incoming: ["first", "user", "later"], expected: ["older", "first", "middle", "user", "later"] },
  ]) {
    it(`preserves omitted residents in place for [${incoming}]`, () => {
      const store = createInstanceMessageStore("partial-order")
      const row = (id: string) => ({ id, sessionId: "session", role: "assistant" as const, status: "complete" as const })
      store.hydrateMessages("session", ["older", "user", "first", "middle", "later"].map(row))
      store.upsertMessage({ ...row("pending"), role: "user", status: "sending", isEphemeral: true })
      store.markSendPending("pending")
      store.hydrateMessages("session", incoming.map(row), undefined, { preserveOmitted: true })
      assert.deepEqual(store.getSessionMessageIds("session"), [...expected, "pending"])
      store.hydrateMessages("session", incoming.map(row), undefined, { preserveOmitted: true })
      assert.deepEqual(store.getSessionMessageIds("session"), [...expected, "pending"], "repeated projections keep order")
      store.hydrateMessages("session", incoming.map(row))
      assert.deepEqual(store.getSessionMessageIds("session"), [...incoming, "pending"], "authoritative pages still replace membership")
      store.clearInstance()
    })
  }

  it("trims to 200 messages and purges removed render-cache entries", () => {
    const instanceId = "window-trim", sessionId = "session"
    const cache = getSessionMessageRenderCache(instanceId, sessionId)
    const store = createInstanceMessageStore(instanceId, {
      onMessagesRemoved: (_instanceId, _sessionId, messageIds) => purgeMessageRenderCache(cache, messageIds),
    })
    store.hydrateMessages(sessionId, Array.from({ length: 201 }, (_, index) => ({
      id: `message-${index}`, sessionId, role: "assistant" as const, status: "complete" as const,
    })))
    cache.messageBlocks.set("message-0", {})
    cache.messageBlocks.set("message-200", {})

    store.trimSessionMessages(sessionId, 200)

    assert.equal(store.getSessionMessageIds(sessionId).length, 200)
    assert.equal(store.getSessionMessageIds(sessionId).includes("message-0"), false)
    assert.deepEqual([...cache.messageBlocks.keys()], ["message-200"])
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

  it("carries pending-send identity and display metadata through message ID replacement", () => {
    const store = createInstanceMessageStore("replacement")
    const metadata = { segments: [{ kind: "pasted" as const, length: 5 }] }
    store.upsertMessage({
      id: "temporary", sessionId: "session", role: "user", status: "sending", isEphemeral: true,
      parts: [{ id: "client-part", type: "text", text: "hello" } as any], clientPromptDisplayMetadata: metadata,
    })
    store.markSendPending("temporary")
    store.replaceMessageId({ oldId: "temporary", newId: "confirmed" })
    store.reconcileEmptyAuthoritativeSnapshot("session")

    assert.equal(store.getMessage("temporary"), undefined)
    assert.deepEqual(store.getSessionMessageIds("session"), ["confirmed"])
    assert.equal(store.hasPendingSends("session"), true)
    assert.deepEqual(store.getMessage("confirmed")?.clientPromptDisplayMetadata, metadata)

    store.hydrateMessages("session", [{
      id: "confirmed", sessionId: "session", role: "user", status: "complete", isEphemeral: false,
      parts: [{ id: "server-part", type: "text", text: "hello" } as any],
    }])
    assert.equal(store.hasPendingSends("session"), false)
    assert.deepEqual(store.getMessage("confirmed")?.partIds, ["server-part"])
    assert.deepEqual(store.getMessage("confirmed")?.clientPromptDisplayMetadata, metadata)
    store.clearInstance()
  })

  it("retains client parts through a metadata-only snapshot until authoritative parts replace them", () => {
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

    assert.deepEqual(store.getMessage("msg-1")?.partIds, ["client-part"])
    store.hydrateMessages("session-1", [{
      id: "msg-1", sessionId: "session-1", role: "user", status: "complete", isEphemeral: false,
      parts: [{ id: "server-part", type: "text", text: "hello" } as any],
    }])

    assert.deepEqual(store.getMessage("msg-1")?.partIds, ["server-part"])
    assert.equal(store.hasPendingSends("session-1"), false)
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

  it("dedupes repeated part ids while keeping the newest part payload", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })

    store.upsertMessage({
      id: "msg-1",
      sessionId: "session-1",
      role: "assistant",
      status: "complete",
      parts: [
        { id: "part-1", type: "text", text: "stale" } as any,
        { id: "part-1", type: "text", text: "current" } as any,
      ],
    })

    const message = store.getMessage("msg-1")
    assert.deepEqual(message?.partIds, ["part-1"])
    assert.equal((message?.parts["part-1"]?.data as any)?.text, "current")
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

    store.hydrateMessages("session-1", [{
      id: "msg-accepted", sessionId: "session-1", role: "user", status: "complete", isEphemeral: false,
      parts: [{ id: "server-part", type: "text", text: "hello", synthetic: false } as any],
    }])
    assert.deepEqual(store.getMessage("msg-accepted")?.partIds, ["server-part"])
    assert.equal(store.getMessage("msg-accepted")?.isEphemeral, false)
    assert.equal(store.hasPendingSends("session-1"), false)
  })

  it("replaces client parts with the authoritative snapshot without discarding server synthetic parts", () => {
    const store = createInstanceMessageStore("instance-1")
    store.addOrUpdateSession({ id: "session-1" })
    store.upsertMessage({
      id: "msg-1", sessionId: "session-1", role: "user", status: "sending",
      parts: [{ id: "client-part", type: "text", text: "hello", synthetic: true } as any], isEphemeral: true,
    })
    store.markSendPending("msg-1")
    store.hydrateMessages("session-1", [{
      id: "msg-1", sessionId: "session-1", role: "user", status: "complete", isEphemeral: false,
      parts: [{ id: "server-synthetic", type: "text", text: "server", synthetic: true } as any],
    }])

    assert.deepEqual(store.getMessage("msg-1")?.partIds, ["server-synthetic"])
    assert.equal((store.getMessage("msg-1")?.parts["server-synthetic"]?.data as any).synthetic, true)
    assert.equal(store.hasPendingSends("session-1"), false)
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
    store.upsertPermission({
      permission: { id: "permission-stale", sessionID: "session-1", action: "edit", resources: [] },
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
    assert.equal(store.state.permissions.byMessage["msg-stale"], undefined)
    assert.equal(store.state.permissions.queue.length, 0)
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
    store.upsertPermission({
      permission: { id: "permission-old", sessionID: "session-1", action: "edit", resources: [] },
      messageId: "msg-old",
      enqueuedAt: 1,
    })

    store.hydrateMessages("session-1", [{
      id: "msg-new", sessionId: "session-1", role: "user", status: "complete",
      parts: [{ type: "text", text: "new" } as any],
    }], [{ id: "msg-new", sessionID: "session-1", role: "user", time: { created: 2 } } as any])

    assert.deepEqual(store.getSessionMessageIds("session-1"), ["msg-new"])
    assert.equal(store.getMessage("msg-old"), undefined)
    assert.equal(store.state.permissions.byMessage["msg-old"], undefined)
    assert.equal(store.state.permissions.queue.length, 0)
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

describe("identical re-hydration stability", () => {
  const part = (text: string) => ({ id: "p1", type: "text", text } as any)

  it("reuses the previous record object when a re-hydrated message is unchanged", () => {
    const store = createInstanceMessageStore("stable-identity")
    store.hydrateMessages("session", [
      { id: "msg_1", sessionId: "session", role: "assistant" as const, status: "streaming" as const, parts: [part("hello")], updatedAt: 1000 },
    ])
    const first = store.getMessage("msg_1")!
    const firstParts = first.parts
    const sessionRevision = store.getSessionRevision("session")

    // The SDK projection rebuilds input objects on every event; identical
    // content must not invalidate the resident record.
    store.hydrateMessages("session", [
      { id: "msg_1", sessionId: "session", role: "assistant" as const, status: "streaming" as const, parts: [part("hello")], updatedAt: 1000 },
    ])
    const second = store.getMessage("msg_1")!
    assert.equal(second, first, "an unchanged message must keep its record identity")
    assert.equal(second.parts, firstParts, "unchanged parts must keep their identity")
    assert.equal(second.revision, first.revision)
    assert.equal(store.getSessionRevision("session"), sessionRevision, "an unchanged snapshot must not bump the session revision")
  })

  it("keeps record identity when input parts are the same object references", () => {
    const store = createInstanceMessageStore("stable-refs")
    const parts = [part("streamed")]
    store.hydrateMessages("session", [
      { id: "msg_1", sessionId: "session", role: "assistant" as const, status: "streaming" as const, parts, updatedAt: 1000 },
    ])
    const first = store.getMessage("msg_1")!
    store.hydrateMessages("session", [
      { id: "msg_1", sessionId: "session", role: "assistant" as const, status: "streaming" as const, parts, updatedAt: 1000 },
    ])
    assert.equal(store.getMessage("msg_1"), first, "reference-stable parts must skip content comparison")
  })

  it("replaces the record and bumps revisions when a streamed part changes", () => {
    const store = createInstanceMessageStore("stable-change")
    store.hydrateMessages("session", [
      { id: "msg_1", sessionId: "session", role: "assistant" as const, status: "streaming" as const, parts: [part("hello")], updatedAt: 1000 },
    ])
    const first = store.getMessage("msg_1")!
    const sessionRevision = store.getSessionRevision("session")

    store.hydrateMessages("session", [
      { id: "msg_1", sessionId: "session", role: "assistant" as const, status: "streaming" as const, parts: [part("hello world")], updatedAt: 1000 },
    ])
    const second = store.getMessage("msg_1")!
    assert.notEqual(second, first, "a changed message must receive a new record object")
    assert.equal(second.revision, first.revision + 1)
    assert.equal(store.getSessionRevision("session"), sessionRevision + 1)
  })

  it("replaces the record when only the status or an explicit updatedAt changes", () => {
    const store = createInstanceMessageStore("stable-status")
    store.hydrateMessages("session", [
      { id: "msg_1", sessionId: "session", role: "assistant" as const, status: "streaming" as const, parts: [part("hello")], updatedAt: 1000 },
    ])
    const first = store.getMessage("msg_1")!

    store.hydrateMessages("session", [
      { id: "msg_1", sessionId: "session", role: "assistant" as const, status: "complete" as const, parts: [part("hello")], updatedAt: 1000 },
    ])
    assert.notEqual(store.getMessage("msg_1"), first, "a status change must replace the record")

    const completed = store.getMessage("msg_1")!
    store.hydrateMessages("session", [
      { id: "msg_1", sessionId: "session", role: "assistant" as const, status: "complete" as const, parts: [part("hello")], updatedAt: 2000 },
    ])
    assert.notEqual(store.getMessage("msg_1"), completed, "an explicit updatedAt change must replace the record")
    assert.equal(store.getMessage("msg_1")!.updatedAt, 2000)
  })
})

describe("chunked hydration", () => {
  const CHUNK_SIZE = 50
  const makeInputs = (count: number): MessageUpsertInput[] => Array.from({ length: count }, (_, index) => ({
    id: `msg_${String(index).padStart(3, "0")}`,
    sessionId: "session",
    role: "assistant" as const,
    status: "complete" as const,
    createdAt: index + 1,
    updatedAt: index + 1,
    parts: [{ type: "text" as const, text: `body-${index}` }],
  }))
  const makeInfos = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `msg_${String(index).padStart(3, "0")}`,
    sessionID: "session",
    role: "assistant" as const,
    time: { created: index + 1, completed: index + 1 },
    cost: 1,
    tokens: { input: 1, output: 1 },
  }))

  it("keeps partial hydration out of the visible store until the finalize pass", async () => {
    const store = createInstanceMessageStore("chunked-progressive")
    const result = store.hydrateMessages("session", makeInputs(CHUNK_SIZE * 2 + CHUNK_SIZE / 2), undefined, { chunked: true })

    assert.ok(result instanceof Promise, "a large chunked hydration returns a promise")
    assert.equal(store.getSessionMessageIds("session").length, 0, "no membership before the finalize pass")
    assert.equal(store.getMessage("msg_049"), undefined, "no records before the finalize pass")
    assert.equal(store.getSessionRevision("session"), 0, "nothing visible while chunks compute")

    const committed = await result
    assert.equal(committed, true)
    assert.equal(store.getSessionMessageIds("session").length, CHUNK_SIZE * 2 + CHUNK_SIZE / 2)
    assert.equal((store.getMessage("msg_124")?.parts["msg_124-part-0"]?.data as { text?: string })?.text, "body-124")
  })

  it("publishes nothing when the native revision guard rejects the finalize pass", async () => {
    const store = createInstanceMessageStore("chunked-guard")
    let guarded = false
    const result = store.hydrateMessages("session", makeInputs(CHUNK_SIZE * 2), undefined, {
      chunked: true,
      guard: () => !guarded,
    })
    assert.ok(result instanceof Promise)
    guarded = true

    assert.equal(await result, false, "a load whose native state moved while chunks computed must not publish")
    assert.equal(store.getSessionMessageIds("session").length, 0, "no membership was installed")
    assert.equal(store.getMessage("msg_010"), undefined, "no records were installed")
    assert.equal(store.getSessionRevision("session"), 0)
  })

  it("keeps rows streamed between chunks and their usage, and never regresses a replaced record", async () => {
    const store = createInstanceMessageStore("chunked-live-writer")
    const inputs = makeInputs(CHUNK_SIZE * 2)
    const result = store.hydrateMessages("session", inputs, undefined, { chunked: true, keepStreamedArrivals: true })

    // Rows streamed between the chunk yields: one appended row the snapshot
    // never knew (with usage), and one replacement of a chunk-0 record.
    const appended = {
      id: "msg_zzz_live", sessionId: "session", role: "assistant" as const, status: "streaming" as const,
      createdAt: 900, updatedAt: 900, parts: [{ type: "text" as const, text: "streamed reply" }],
    }
    const projected = inputs.map((input, index) =>
      index === 10
        ? { ...input, status: "streaming" as const, updatedAt: 999, parts: [{ type: "text" as const, text: "live SSE text", native: { phase: "done" } }] }
        : input,
    )
    projected.push(appended)
    projected.push({ ...appended, id: "msg_zzz_two", parts: [{ type: "text" as const, text: "second streamed row" }] })
    store.hydrateMessages("session", projected, [{ id: "msg_zzz_live", sessionID: "session", role: "assistant", time: { created: 900 }, cost: 2, tokens: { input: 3, output: 4 } }], { preserveOmitted: true })

    assert.equal(await result, true)
    const ids = store.getSessionMessageIds("session")
    assert.ok(ids.includes("msg_zzz_live"), "a row streamed between chunks survives a latest-window snapshot commit")
    assert.ok(ids.includes("msg_zzz_two"), "the whole arrival run stays anchored after the last shared id")
    assert.equal((store.getMessage("msg_zzz_live")?.parts["msg_zzz_live-part-0"]?.data as { text?: string })?.text, "streamed reply")
    assert.equal((store.getMessage("msg_010")?.parts["msg_010-part-0"]?.data as { text?: string })?.text, "live SSE text", "committed live content newer than the snapshot is never regressed")
    assert.equal(store.getSessionUsage("session")?.totalCost, 2, "streamed usage survives the snapshot's usage rebuild")
  })

  it("drops rows streamed between chunks of a history replacement", async () => {
    const store = createInstanceMessageStore("chunked-history-drop")
    const inputs = makeInputs(CHUNK_SIZE * 2)
    const result = store.hydrateMessages("session", inputs, undefined, { chunked: true })

    const appended = {
      id: "msg_zzz_live", sessionId: "session", role: "assistant" as const, status: "streaming" as const,
      createdAt: 900, updatedAt: 900, parts: [{ type: "text" as const, text: "streamed reply" }],
    }
    store.hydrateMessages("session", [appended], undefined, { preserveOmitted: true })

    assert.equal(await result, true)
    assert.equal(store.getSessionMessageIds("session").includes("msg_zzz_live"), false, "a history replacement omits rows its page does not hold")
  })

  it("arbitrates queued partials and running tools per part", async () => {
    const store = createInstanceMessageStore("chunked-arbitration")
    const base = makeInputs(CHUNK_SIZE + 5)
    // A queued older projection: divergent corrected text on one row and a
    // running tool with partial output on another.
    const queued = base.map((input, index) => {
      if (index === 10) return { ...input, status: "streaming" as const, parts: [{ type: "text" as const, text: "stale partial" }] }
      if (index === 11) {
        return { ...input, status: "streaming" as const, parts: [{ id: "tool_1", type: "tool" as const, tool: "bash", state: { status: "running" as const, input: {} } }] }
      }
      return input
    })
    const corrected = base.map((input, index) => {
      if (index === 10) return { ...input, parts: [{ type: "text" as const, text: "corrected final" }] }
      if (index === 11) {
        return { ...input, parts: [{ id: "tool_1", type: "tool" as const, tool: "bash", state: { status: "completed" as const, input: {}, output: "done", content: [] } }] }
      }
      return input
    })
    const result = store.hydrateMessages("session", corrected, undefined, { chunked: true })
    store.hydrateMessages("session", queued, undefined, { preserveOmitted: true })

    assert.equal(await result, true)
    assert.equal((store.getMessage("msg_010")?.parts["msg_010-part-0"]?.data as { text?: string })?.text, "corrected final", "divergent corrected snapshot text supersedes an open queued partial")
    const tool = store.getMessage("msg_011")?.parts["tool_1"]?.data as { state?: { status?: string } } | undefined
    assert.equal(tool?.state?.status, "completed", "a completed tool result supersedes a running partial")
  })

  it("keeps an open streamed fragment the fetched page only prefixes", async () => {
    const store = createInstanceMessageStore("chunked-stream-continues")
    const base = makeInputs(CHUNK_SIZE + 5)
    // The fetched page holds the message still open (status streaming), so
    // neither side carries completion evidence and the longer open stream
    // keeps its text.
    const fetched = base.map((input, index) =>
      index === 10
        ? { ...input, status: "streaming" as const, parts: [{ type: "text" as const, text: "body-10" }] }
        : input,
    )
    const streamed = fetched.map((input, index) =>
      index === 10
        ? { ...input, parts: [{ type: "text" as const, text: "body-10 continues" }] }
        : input,
    )
    const result = store.hydrateMessages("session", fetched, undefined, { chunked: true })
    store.hydrateMessages("session", streamed, undefined, { preserveOmitted: true })

    assert.equal(await result, true)
    assert.equal((store.getMessage("msg_010")?.parts["msg_010-part-0"]?.data as { text?: string })?.text, "body-10 continues", "an open fragment the page only prefixes keeps its streamed text")
  })

  it("pairs anonymous prose fragments by kind and ordinal", async () => {
    const store = createInstanceMessageStore("chunked-ordinal-pairing")
    const base = makeInputs(CHUNK_SIZE + 5)
    // The live stream recovered a reasoning fragment ahead of its text; the
    // fetched page holds the final text first. Anonymous fragments carry no
    // ids, so only kind-and-ordinal pairing keeps the old partial from
    // showing beside the final text.
    const streamed = base.map((input, index) =>
      index === 10
        ? { ...input, status: "streaming" as const, parts: [{ type: "reasoning" as const, text: "thought" }, { type: "text" as const, text: "old partial text" }] }
        : input,
    )
    const fetched = base.map((input, index) =>
      index === 10
        ? { ...input, parts: [{ type: "text" as const, text: "final text", native: { phase: "done" } }] }
        : input,
    )
    const result = store.hydrateMessages("session", fetched, undefined, { chunked: true })
    store.hydrateMessages("session", streamed, undefined, { preserveOmitted: true })

    assert.equal(await result, true)
    const record = store.getMessage("msg_010")!
    const texts = record.partIds.map((id) => record.parts[id]?.data).filter((part) => part?.type === "text") as Array<{ type: "text"; text: string }>
    assert.equal(texts.length, 1, "the recovered reasoning and final text replace the old partial, not sit beside it")
    assert.equal(texts[0]?.text, "final text")
  })

  it("lets a committed shorter final supersede an open longer stream", async () => {
    const store = createInstanceMessageStore("chunked-shorter-final")
    const base = makeInputs(CHUNK_SIZE + 5)
    const streamed = base.map((input, index) =>
      index === 10
        ? { ...input, status: "streaming" as const, parts: [{ type: "text" as const, text: "body-10 continues streaming" }] }
        : input,
    )
    const fetched = base.map((input, index) =>
      index === 10
        ? { ...input, parts: [{ type: "text" as const, text: "body-1", native: { phase: "done" } }] }
        : input,
    )
    const result = store.hydrateMessages("session", fetched, undefined, { chunked: true })
    store.hydrateMessages("session", streamed, undefined, { preserveOmitted: true })

    assert.equal(await result, true)
    const record = store.getMessage("msg_010")!
    assert.equal((record.parts[record.partIds.find((id) => record.parts[id]?.data.type === "text")!]?.data as { text?: string })?.text, "body-1", "a committed shorter final beats the open stream regardless of prefix shape")
  })

  it("carries the fetched end metadata onto a winning resident fragment", async () => {
    const store = createInstanceMessageStore("chunked-end-metadata")
    const base = makeInputs(CHUNK_SIZE + 5)
    const streamed = base.map((input, index) =>
      index === 10
        ? { ...input, status: "streaming" as const, updatedAt: 999, parts: [{ type: "text" as const, text: "final text", native: { phase: "done" } }] }
        : input,
    )
    const fetched = base.map((input, index) =>
      index === 10
        ? { ...input, parts: [{ type: "reasoning" as const, text: "thought", time: { created: 5, completed: 6 } }] }
        : input,
    )
    const result = store.hydrateMessages("session", fetched, undefined, { chunked: true })
    store.hydrateMessages("session", streamed, undefined, { preserveOmitted: true })

    assert.equal(await result, true)
    const record = store.getMessage("msg_010")!
    const reasoning = record.parts[record.partIds.find((id) => record.parts[id]?.data.type === "reasoning")!]?.data as { time?: { completed?: number } }
    assert.equal(reasoning?.time?.completed, 6, "the fetched fragment's end time survives on the winning merged part")
  })

  it("places arrivals sharing no id with the page after it", async () => {
    const store = createInstanceMessageStore("chunked-trailing-arrivals")
    const base = makeInputs(CHUNK_SIZE + 5)
    const result = store.hydrateMessages("session", base, undefined, { chunked: true, keepStreamedArrivals: true })
    const live = {
      id: "msg_aaa_live", sessionId: "session", role: "user" as const, status: "sent" as const,
      createdAt: 1, updatedAt: 1, parts: [{ type: "text" as const, text: "visible reply" }],
    }
    store.hydrateMessages("session", [live], undefined, { preserveOmitted: true })

    assert.equal(await result, true)
    const ids = store.getSessionMessageIds("session")
    assert.equal(ids.at(-1), "msg_aaa_live", "an arrival sharing no id with the page lands at the end, not ahead of older messages")
  })

  it("lets an interrupted step's final text supersede its open stream", async () => {
    const store = createInstanceMessageStore("chunked-interrupted-step")
    const base = makeInputs(CHUNK_SIZE + 5)
    // The message ended through an interruption: it carries time.completed
    // and an interruption error, so its display status is `error` and its
    // text is final even though it is shorter than the open stream showed.
    const fetched = base.map((input, index) =>
      index === 10
        ? { ...input, status: "error" as const, parts: [{ type: "text" as const, text: "BASE" }] }
        : input,
    )
    const streamed = base.map((input, index) =>
      index === 10
        ? { ...input, status: "streaming" as const, parts: [{ type: "text" as const, text: "BASE partial" }] }
        : input,
    )
    const result = store.hydrateMessages("session", fetched, undefined, { chunked: true })
    store.hydrateMessages("session", streamed, undefined, { preserveOmitted: true })

    assert.equal(await result, true)
    const record = store.getMessage("msg_010")!
    assert.equal((record.parts[record.partIds[0]]?.data as { text?: string })?.text, "BASE", "an ended message's text is final whatever its display status")
    assert.equal(record.status, "error")
  })

  it("empties a stale partial when the authoritative page holds no content", async () => {
    const store = createInstanceMessageStore("chunked-empty-content")
    const base = makeInputs(CHUNK_SIZE + 5)
    const fetched = base.map((input, index) =>
      index === 10 ? { ...input, parts: [] } : input,
    )
    const streamed = base.map((input, index) =>
      index === 10
        ? { ...input, status: "streaming" as const, parts: [{ type: "text" as const, text: "stale partial text" }] }
        : input,
    )
    const result = store.hydrateMessages("session", fetched, undefined, { chunked: true })
    store.hydrateMessages("session", streamed, undefined, { preserveOmitted: true })

    assert.equal(await result, true)
    const record = store.getMessage("msg_010")!
    assert.equal(record.partIds.length, 0, "an authoritative step with no content drops the stale partial")
    assert.equal(record.status, "complete")
  })

  it("reuses the resident record when the merge changes nothing", async () => {
    const store = createInstanceMessageStore("chunked-merge-reuse")
    const base = makeInputs(CHUNK_SIZE + 5)
    const result = store.hydrateMessages("session", base, undefined, { chunked: true })
    // A projection lands the very same content and metadata for one row.
    store.hydrateMessages("session", base, undefined, { preserveOmitted: true })
    const revision = store.getMessage("msg_010")!.revision

    assert.equal(await result, true)
    // Store setters merge into the resident object, so identity cannot tell
    // reuse from a redundant write; the record revision can.
    assert.equal(store.getMessage("msg_010")?.revision, revision, "a merge that changes nothing publishes nothing")
  })

  const reply = (text: string, status: "streaming" | "complete", committed: boolean) => ({
    status, isEphemeral: status === "streaming",
    parts: [{ type: "text" as const, text: committed ? `${text} final` : text, ...(committed ? { native: { phase: "done" } } : {}) }],
  })

  it("takes status and isEphemeral from the resident version when its end wins", async () => {
    const store = createInstanceMessageStore("chunked-status-resident")
    const base = makeInputs(CHUNK_SIZE + 5)
    // SSE completes the reply between chunks while the fetched page still
    // holds it open: the completed stream is the later version of the row.
    const fetched = base.map((input, index) => index === 10 ? { ...input, ...reply("BASE par", "streaming", false) } : input)
    const streamed = base.map((input, index) => index === 10 ? { ...input, ...reply("BASE par", "complete", true) } : input)
    const result = store.hydrateMessages("session", fetched, undefined, { chunked: true })
    store.hydrateMessages("session", streamed, undefined, { preserveOmitted: true })

    assert.equal(await result, true)
    const record = store.getMessage("msg_010")!
    assert.equal((record.parts[record.partIds[0]]?.data as { text?: string })?.text, "BASE par final")
    assert.equal(record.status, "complete", "the status comes from the same version as the winning end")
    assert.equal(record.isEphemeral, false, "so does isEphemeral")
  })

  it("takes status and isEphemeral from the fetched version when its end wins", async () => {
    const store = createInstanceMessageStore("chunked-status-snapshot")
    const base = makeInputs(CHUNK_SIZE + 5)
    const fetched = base.map((input, index) => index === 10 ? { ...input, ...reply("BASE par", "complete", true) } : input)
    const streamed = base.map((input, index) => index === 10 ? { ...input, ...reply("BASE par", "streaming", false) } : input)
    const result = store.hydrateMessages("session", fetched, undefined, { chunked: true })
    store.hydrateMessages("session", streamed, undefined, { preserveOmitted: true })

    assert.equal(await result, true)
    const record = store.getMessage("msg_010")!
    assert.equal((record.parts[record.partIds[0]]?.data as { text?: string })?.text, "BASE par final")
    assert.equal(record.status, "complete")
    assert.equal(record.isEphemeral, false)
  })

  it("keeps tokens published after the fetch through a same-window reload", async () => {
    const store = createInstanceMessageStore("chunked-usage-reload")
    const inputs = makeInputs(CHUNK_SIZE + 5)
    const infos = makeInfos(CHUNK_SIZE + 5)
    store.hydrateMessages("session", inputs, infos)

    const reloaded = store.hydrateMessages("session", inputs, infos, { chunked: true })

    // SSE published usage for one row while the reload's chunks compute,
    // after its page was fetched.
    store.setMessageInfo("msg_010", { id: "msg_010", sessionID: "session", role: "assistant", time: { created: 11, completed: 11 }, cost: 5, tokens: { input: 100, output: 23 } })

    assert.equal(await reloaded, true)
    const usage = store.getSessionUsage("session")!
    assert.equal(usage.entries["msg_010"]?.cost, 5, "the published info survives the reload")
    assert.equal(usage.entries["msg_010"]?.combinedTokens, 123, "123 published tokens are not reset")
  })

  it("reaches exactly the state of a single-pass hydrate", async () => {
    const inputs = makeInputs(CHUNK_SIZE * 2 + 10)
    const infos = makeInfos(CHUNK_SIZE * 2 + 10)
    const control = createInstanceMessageStore("chunked-parity-control")
    const chunked = createInstanceMessageStore("chunked-parity")

    control.hydrateMessages("session", inputs, infos)
    assert.equal(await chunked.hydrateMessages("session", inputs, infos, { chunked: true }), true)

    assert.deepEqual(chunked.getSessionMessageIds("session"), control.getSessionMessageIds("session"))
    for (const id of control.getSessionMessageIds("session")) {
      const fromChunked = chunked.getMessage(id)!
      const fromControl = control.getMessage(id)!
      assert.equal(fromChunked.revision, fromControl.revision)
      assert.equal(fromChunked.status, fromControl.status)
      assert.deepEqual(fromChunked.partIds, fromControl.partIds)
      assert.equal(
        (fromChunked.parts[fromChunked.partIds[0]]?.data as { text?: string })?.text,
        (fromControl.parts[fromControl.partIds[0]]?.data as { text?: string })?.text,
      )
    }
    assert.equal(chunked.getSessionRevision("session"), control.getSessionRevision("session"))
    assert.deepEqual(chunked.state.messageInfoVersion, control.state.messageInfoVersion)
    assert.deepEqual(chunked.getSessionUsage("session"), control.getSessionUsage("session"))
  })

  it("keeps small chunked batches fully synchronous", () => {
    const store = createInstanceMessageStore("chunked-small")
    const result = store.hydrateMessages("session", makeInputs(CHUNK_SIZE - 5), undefined, { chunked: true })

    assert.equal(result, undefined, "a batch within one chunk never defers")
    assert.equal(store.getSessionMessageIds("session").length, CHUNK_SIZE - 5)
    assert.equal(store.getMessage(`msg_${String(CHUNK_SIZE - 6).padStart(3, "0")}`) !== undefined, true)
  })

  it("bumps the session revision once for the whole batch", async () => {
    let changes = 0
    const store = createInstanceMessageStore("chunked-revision", {
      onSessionChanged: (_instanceId, sessionId) => {
        if (sessionId === "session") changes += 1
      },
    })
    await store.hydrateMessages("session", makeInputs(CHUNK_SIZE * 3), undefined, { chunked: true })

    assert.equal(changes, 1, "per-chunk commits must not each invalidate downstream caches")
    assert.equal(store.getSessionRevision("session"), 1)
  })

  it("aborts remaining chunks when a concurrent mutation fences the batch", async () => {
    const store = createInstanceMessageStore("chunked-fence")
    const result = store.hydrateMessages("session", makeInputs(CHUNK_SIZE * 3), undefined, { chunked: true })
    assert.ok(result instanceof Promise)

    store.upsertMessage({
      id: "live_update",
      sessionId: "session",
      role: "user",
      status: "sending",
      parts: [{ type: "text", text: "interrupting" }],
    })

    assert.equal(await result, false, "a fenced hydration reports that it did not complete")
    const ids = store.getSessionMessageIds("session")
    assert.equal(ids.length, 1, "no membership from the fenced snapshot; the newer writer owns the session")
    assert.equal(ids.includes("msg_050"), false)
    assert.equal(ids.includes("live_update"), true, "the newer writer owns the session")
  })

  it("rebuilds the latest todo snapshot from unchanged records too", async () => {
    const inputs = makeInputs(CHUNK_SIZE * 2 + 5)
    inputs[10] = {
      ...inputs[10],
      parts: [{ id: "todo", type: "tool" as const, tool: "todowrite", state: { status: "completed", input: {}, metadata: {}, output: "", content: [] } }],
    }
    const store = createInstanceMessageStore("chunked-todos")
    store.hydrateMessages("session", inputs)
    assert.ok(store.getLatestTodoSnapshot("session"), "the initial hydrate records the completed todo")

    assert.equal(await store.hydrateMessages("session", inputs, undefined, { chunked: true }), true)
    const snapshot = store.getLatestTodoSnapshot("session")
    assert.ok(snapshot, "an all-unchanged re-hydration rebuilds the todo snapshot in its final pass")
    assert.equal(snapshot?.messageId, inputs[10].id)
    assert.equal(snapshot?.partId, "todo")
  })
})
