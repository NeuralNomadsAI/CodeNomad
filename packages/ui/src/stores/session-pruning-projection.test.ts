import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { applyOpenCodeDataEvent, destroyOpenCodeData, invalidateOpenCodeSessionContent, projectOpenCodeMessages } from "./opencode-data"
import { getRootClient } from "./opencode-client"
import { messageStoreBus } from "./message-v2/bus"
import { sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { pruneMessageContent } from "./session-pruning"
import { deleteMessagePart } from "./session-actions"
import { contentRevision } from "../../../server/src/opencode/session-pruning/revision"

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
  let synced = false
  const apply = (type: string, data: object) => applyOpenCodeDataEvent(instanceId, "/work", {
    id: type, type, data, created: 1,
  } as any, undefined, data => { projectOpenCodeMessages(instanceId, sessionID, data); synced = true })
  try {
    apply("session.step.started", { sessionID, assistantMessageID: "m", agent: "build", model: { providerID: "p", id: "m" } })
    apply("session.reasoning.started", { sessionID, assistantMessageID: "m" })
    const old = apply("session.reasoning.delta", { sessionID, assistantMessageID: "m", ordinal: 0, delta: "remove" })
    assert(old.session.message.get(sessionID, "m")?.type === "assistant")
    invalidateOpenCodeSessionContent(instanceId, sessionID)
    const pending = apply("session.idle", { sessionID })
    assert.notEqual(pending, old)
    assert.deepEqual(pending.session.message.list(sessionID), [])
    for (let i = 0; i < 100 && !synced; i++) await delay(10)
    assert(synced, "authoritative resync completed")
    const next = apply("session.idle", { sessionID })
    projectOpenCodeMessages(instanceId, sessionID, next)
    const parts = Object.values(messageStoreBus.getOrCreate(instanceId).getMessage("m")!.parts)
    assert(parts.every(part => part.data.type !== "reasoning"))
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

test("reasoning built from native 2.1 events keeps the identity and revision of its HTTP projection", async () => {
  const instanceId = "pruning-native-identity"
  const sessionID = "s"
  const client = getRootClient(instanceId)
  // OpenCode 2.1 replays provider data as `native` (formerly `state`) on events and messages alike.
  const native = { reasoningField: "reasoning_content" }
  const projected = { id: "m", type: "assistant", agent: "build", model: { providerID: "p", id: "m" }, finish: "stop",
    content: [{ type: "reasoning", text: "think", native, time: { created: 2, completed: 3 } }, { type: "text", text: "keep" }],
    time: { created: 1, completed: 4 } } as any
  Object.assign(client.session, {
    get: async () => ({ id: sessionID, projectID: "p", location: { directory: "/work" }, time: { created: 1, updated: 4 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    active: async () => ({}), inbox: { list: async () => [] },
  })
  client.permission.list = async () => []
  client.session.form.list = async () => []
  client.session.message.get = async () => projected
  const saved = serverApi.pruneSessionMessage
  let sent: any
  serverApi.pruneSessionMessage = async (_instance, body) => { sent = body; return { status: "pruned", messageID: "m", revision: "a".repeat(64), removedCount: 1 } }
  const apply = (type: string, data: object, created: number) => projectOpenCodeMessages(instanceId, sessionID,
    applyOpenCodeDataEvent(instanceId, "/work", { id: `${type}-${created}`, type, data, created } as any))
  try {
    apply("session.step.started", { sessionID, assistantMessageID: "m", agent: "build", model: { providerID: "p", id: "m" }, started: 1 }, 1)
    apply("session.reasoning.started", { sessionID, assistantMessageID: "m", ordinal: 0, native }, 2)
    apply("session.reasoning.ended", { sessionID, assistantMessageID: "m", ordinal: 0, text: "think", native }, 3)
    apply("session.text.started", { sessionID, assistantMessageID: "m", ordinal: 0 }, 3)
    apply("session.text.ended", { sessionID, assistantMessageID: "m", ordinal: 0, text: "keep" }, 3)
    apply("session.step.ended", { sessionID, assistantMessageID: "m", finish: "stop" }, 4)
    const record = messageStoreBus.getOrCreate(instanceId).getMessage("m")!
    const reasoning = record.partIds.find(id => record.parts[id]?.data.type === "reasoning")!
    assert.deepEqual((record.parts[reasoning]!.data as any).native, native, "the event reducer retains native replay data")
    await deleteMessagePart(instanceId, sessionID, "m", reasoning)
    assert.deepEqual(sent.indexes, [0])
    assert.equal(sent.revision, await contentRevision(projected.content))
  } finally {
    serverApi.pruneSessionMessage = saved
    destroyOpenCodeData(instanceId)
    sdkManager.destroyClientsForInstance(instanceId)
    if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
  }
})
