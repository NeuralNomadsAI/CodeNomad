import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { applyOpenCodeDataEvent, destroyOpenCodeData, finishOpenCodeDataEvent, invalidateOpenCodeSessionContent, projectOpenCodeMessages } from "./opencode-data"
import { getRootClient } from "./opencode-client"
import { messageStoreBus } from "./message-v2/bus"
import { sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { pruneMessageContent } from "./session-pruning"

test("the SDK projection cannot resurrect deleted parts on the next native event", async () => {
  const instanceId = "pruning-projection"
  const sessionID = "s"
  const client = getRootClient(instanceId)
  const current = { id: "m", type: "assistant", agent: "build", model: { providerID: "p", id: "m" }, content: [{ type: "text", text: "keep" }], time: { created: 1, completed: 4 } }
  Object.assign(client.session, {
    get: async () => ({ id: sessionID, projectID: "p", location: { directory: "/work" }, time: { created: 1, updated: 4 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    active: async () => ({}), inbox: { list: async () => [] },
  })
  client.permission.list = async () => []
  client.session.form.list = async () => []
  client.message.list = async () => ({ data: [current], cursor: {} }) as any
  let synced = false, sequence = 0
  const event = (type: string, data: object) => ({ id: `evt_${type}_${++sequence}`, type, data, created: sequence } as any)
  const apply = (type: string, data: object) => applyOpenCodeDataEvent(instanceId, "/work", event(type, data),
    undefined, data => { projectOpenCodeMessages(instanceId, sessionID, data); synced = true })
  const reasoningParts = () => Object.values(messageStoreBus.getOrCreate(instanceId).getMessage("m")!.parts)
    .filter(part => part.data.type === "reasoning")
  try {
    apply("session.step.started", { sessionID, assistantMessageID: "m", agent: "build", model: { providerID: "p", id: "m" } })
    apply("session.reasoning.started", { sessionID, assistantMessageID: "m" })
    const old = apply("session.reasoning.delta", { sessionID, assistantMessageID: "m", ordinal: 0, delta: "remove" })
    assert(old.session.message.get(sessionID, "m")?.type === "assistant")
    invalidateOpenCodeSessionContent(instanceId, sessionID)
    // OpenCode V2 settles the run with a terminal execution event while repair is pending.
    const pending = apply("session.execution.succeeded", { sessionID })
    assert.notEqual(pending, old)
    assert.deepEqual(pending.session.message.list(sessionID), [])
    for (let i = 0; i < 100 && !synced; i++) await delay(10)
    assert(synced, "authoritative resync completed")
    // The production order: reduce, project the page, then let settlement retire the reducer.
    const settled = event("session.execution.succeeded", { sessionID })
    const next = applyOpenCodeDataEvent(instanceId, "/work", settled)
    projectOpenCodeMessages(instanceId, sessionID, next)
    finishOpenCodeDataEvent(instanceId, settled)
    assert.deepEqual(reasoningParts(), [])
    const fresh = apply("session.step.started", { sessionID, assistantMessageID: "m2", agent: "build", model: { providerID: "p", id: "m" } })
    assert.notEqual(fresh, next, "settlement retires the reconciled reducer")
    projectOpenCodeMessages(instanceId, sessionID, fresh)
    assert.deepEqual(reasoningParts(), [], "the next run's reducer cannot resurrect pruned parts")
  } finally {
    destroyOpenCodeData(instanceId)
    sdkManager.destroyClientsForInstance(instanceId)
    if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
  }
})

test("a late post-prune read cannot overtake another client's invalidation", async () => {
  const instanceId = "pruning-late-read"
  const client = getRootClient(instanceId)
  const saved = serverApi.pruneSessionMessage
  let resolve!: (value: any) => void
  let reads = 0
  let applied: any
  const original = { id: "m", type: "assistant", content: [{ type: "reasoning", text: "remove" }], time: { created: 1, completed: 2 } } as any
  client.session.message.get = async () => ++reads === 1 ? new Promise(done => { resolve = done }) : { ...original, content: [] }
  serverApi.pruneSessionMessage = async () => ({ status: "pruned", messageID: "m", revision: "a".repeat(64), removedCount: 1 })
  try {
    const pruning = pruneMessageContent(instanceId, "s", original, [0], message => { applied = message })
    for (let i = 0; i < 100 && !resolve; i++) await delay(5)
    assert(resolve)
    invalidateOpenCodeSessionContent(instanceId, "s")
    resolve(original)
    await pruning
    assert.equal(reads, 2)
    assert.deepEqual(applied.content, [])
  } finally {
    serverApi.pruneSessionMessage = saved
    destroyOpenCodeData(instanceId)
    sdkManager.destroyClientsForInstance(instanceId)
  }
})
