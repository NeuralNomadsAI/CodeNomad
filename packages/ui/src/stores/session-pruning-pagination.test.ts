import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { SessionMessageInfo } from "@opencode-ai/client"
import type { Session } from "../types/session"
import { sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import { serverApi } from "../lib/api-client"
import { addInstance, removeInstance } from "./instances"
import { getRootClient } from "./opencode-client"
import { applyOpenCodeDataEvent, destroyOpenCodeData, getOpenCodeSessionInbox, projectOpenCodeMessages } from "./opencode-data"
import { messageStoreBus } from "./message-v2/bus"
import { loadMessages, loadMoreMessages, loadNewerMessageWindow } from "./session-api"
import { setActiveSession, setSessions } from "./session-state"
import { handlePruningEvent } from "./session-pruning-events"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function waitFor(check: () => boolean, description: string) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await delay(5)
  assert.ok(check(), description)
}

for (const ordering of ["UI-first", "SDK-first"] as const) {
  test(`pruning keeps the native 200-message page and contiguous pagination (${ordering})`, async () => {
    const instanceId = `pruning-pagination-${ordering}`, sessionId = "s"
    const client = getRootClient(instanceId)
    const session = {
      id: sessionId, instanceId, parentId: null, title: sessionId, agent: "build",
      model: { providerId: "p", modelId: "model" }, status: "idle", location: { directory: "/work" },
      time: { created: 1, updated: 1 }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as Session
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions(new Map([[instanceId, new Map([[sessionId, session]])]]))
    const savedYolo = serverApi.getYoloState
    serverApi.getYoloState = async () => ({ enabled: false }) as any
    const messages: SessionMessageInfo[] = Array.from({ length: 400 }, (_, index) => ({
      id: `m${String(index).padStart(3, "0")}`, type: "assistant", agent: "build",
      model: { providerID: "p", id: "model" }, time: { created: index + 1, completed: index + 2 },
      content: [{ type: "text", text: `answer ${index}` }, { type: "reasoning", text: "remove", state: { opaque: `state-${index}` } }],
    })) as SessionMessageInfo[]
    const latestIds = messages.slice(200).map(message => message.id)
    const olderIds = messages.slice(0, 200).map(message => message.id)
    const uiGate = deferred<void>(), sdkGate = deferred<void>()
    const requests: Array<{ limit?: number; cursor?: string }> = []
    let pruned = false, sdkReads = 0
    Object.assign(client.session, {
      get: async () => ({ ...session, projectID: "p" }), active: async () => ({}),
      list: async () => ({ data: [{ ...session, projectID: "p" }], cursor: {} }),
      // The fresh entry's inbox becomes visible only when resync swaps it in.
      inbox: { list: async () => [{ id: "resynced", sessionID: sessionId, type: "compaction", payload: { reason: "auto" }, timeCreated: 1 }] },
    })
    client.permission.list = async () => []
    client.form.list = async () => []
    client.message.list = async input => {
      requests.push({ limit: input.limit, cursor: input.cursor })
      const limit = input.limit ?? 20
      const end = input.cursor === "after200" ? 200 : 400
      const start = Math.max(0, end - limit)
      const data = structuredClone(messages.slice(start, end).reverse())
      if (pruned) {
        if (limit === 20) { sdkReads++; await sdkGate.promise }
        else await uiGate.promise
      }
      return { data, cursor: start > 0 ? { next: `after${400 - start}` } : {} }
    }
    let eventId = 0
    const native = (type: string, data: object = {}) => {
      sseManager.onInvalidation!(instanceId, {
        id: `e${++eventId}`, type, created: eventId, data: { sessionID: sessionId, ...data },
      } as any)
    }
    const store = messageStoreBus.getOrCreate(instanceId)
    const hasReasoning = (id: string) => Object.values(store.getMessage(id)?.parts ?? {}).some(part => part.data.type === "reasoning")
    try {
      setActiveSession(instanceId, sessionId)
      // Exercise the real native dispatcher to retain an obsolete SDK projection.
      native("session.step.started", { assistantMessageID: "m399", agent: "build", model: { providerID: "p", id: "model" } })
      native("session.reasoning.started", { assistantMessageID: "m399" })
      native("session.reasoning.delta", { assistantMessageID: "m399", ordinal: 0, delta: "remove" })
      const oldProjection = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "old", type: "session.idle", created: 4, data: { sessionID: sessionId },
      } as any)
      await loadMessages(instanceId, sessionId, { force: true })
      assert.deepEqual(store.getSessionMessageIds(sessionId), latestIds)
      assert.equal(store.getMessageWindow(sessionId)?.olderCursor, "after200")
      assert.ok(hasReasoning("m250"))
      for (const message of messages) {
        if (message.type === "assistant") message.content = message.content.filter(part => part.type !== "reasoning")
      }
      pruned = true
      assert.equal(handlePruningEvent(instanceId, {
        type: "rpc.codenomad.session-pruning.pruned",
        data: { sessionID: sessionId, messageID: "m399", revision: "a".repeat(64) },
      }), true)

      // A late delta during repair must not revive the disposed projection.
      native("session.reasoning.delta", { assistantMessageID: "m399", ordinal: 0, delta: "stale" })
      await waitFor(() => sdkReads > 0, "SDK reconciliation requested its small seed")
      if (ordering === "UI-first") {
        uiGate.resolve()
        await waitFor(() => !hasReasoning("m250"), "native page reload finished before SDK")
        assert.deepEqual(store.getSessionMessageIds(sessionId), latestIds)
        sdkGate.resolve()
      } else {
        sdkGate.resolve()
        await waitFor(() => getOpenCodeSessionInbox(instanceId, sessionId, "/work").length > 0, "SDK resync finished before UI")
        assert.deepEqual(store.getSessionMessageIds(sessionId), latestIds)
        uiGate.resolve()
      }
      await waitFor(() => getOpenCodeSessionInbox(instanceId, sessionId, "/work").length > 0 && !hasReasoning("m250"), "both reconstructions completed")
      assert.deepEqual(store.getSessionMessageIds(sessionId), latestIds)
      assert.equal(store.getMessageWindow(sessionId)?.olderCursor, "after200")
      assert.ok(latestIds.every(id => !hasReasoning(id)))
      assert.deepEqual(requests.slice(0, 3).map(request => request.limit), [200, 200, 20])

      // A previously captured/throttled callback cannot resurrect deleted parts.
      projectOpenCodeMessages(instanceId, sessionId, oldProjection, false)
      native("session.idle")
      assert.deepEqual(store.getSessionMessageIds(sessionId), latestIds)
      assert.ok(latestIds.every(id => !hasReasoning(id)))

      await loadMoreMessages(instanceId, sessionId)
      assert.deepEqual(requests.at(-1), { limit: 200, cursor: "after200" })
      assert.deepEqual(store.getSessionMessageIds(sessionId), olderIds)
      assert.equal(store.getMessageWindow(sessionId)?.olderCursor, undefined)
      assert.deepEqual([...olderIds, ...latestIds], messages.map(message => message.id), "no skipped 180-message gap")
      native("session.idle")
      assert.deepEqual(store.getSessionMessageIds(sessionId), olderIds, "live projection does not replace a history page")
      await loadNewerMessageWindow(instanceId, sessionId)
      assert.deepEqual(store.getSessionMessageIds(sessionId), latestIds)
      assert.equal(store.getMessageWindow(sessionId)?.olderCursor, "after200")
    } finally {
      uiGate.resolve()
      sdkGate.resolve()
      destroyOpenCodeData(instanceId)
      setSessions(new Map())
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
      serverApi.getYoloState = savedYolo
    }
  })
}
