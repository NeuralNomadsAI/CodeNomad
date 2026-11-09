import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeEvent } from "@opencode/client"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { destroyOpenCodeData, applyOpenCodeDataEvent, invalidateOpenCodeSessionContent } from "./opencode-data.ts"
import { handleNativeSessionEvent } from "./session-events.ts"
import { setActiveSession, setSessions } from "./session-state.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const model = { providerID: "fixture", id: "fixture" }
const completed = {
  id: "m1", type: "assistant", agent: "build", model,
  time: { created: 1, completed: 5 }, content: [{
    type: "tool", id: "tool", name: "read", time: { created: 2, ran: 3, completed: 4 },
    state: { status: "completed", input: {}, content: [{ type: "text", text: "settled" }], metadata: {} },
  }],
}
type Page = { data: unknown[]; cursor: Record<string, string> }

function fixture(instanceId: string) {
  const sessionId = "s"
  const statuses = sseManager.getStatuses
  sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
  const active = deferred<Record<string, unknown>>()
  const reads: ReturnType<typeof deferred<Page>>[] = []
  const client = {
    session: {
      active: () => active.promise,
      get: async () => ({ id: sessionId, location: { directory: "/fixture" }, time: { created: 1, updated: 5 } }),
      inbox: { list: async () => [] },
      form: { list: async () => [] },
    },
    permission: { list: async () => [] },
    message: { list: (input: { limit?: number }) => {
      assert.equal(input.limit, 20, "this race must exercise the native reducer's history read")
      const read = deferred<Page>()
      reads.push(read)
      return read.promise
    } },
  } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
    id: sessionId, instanceId, title: "Fixture", parentId: null, location: { directory: "/fixture" },
    status: "working", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
  } as any]])))
  setActiveSession(instanceId, sessionId)
  let sequence = 0
  const emit = (type: string, data: Record<string, unknown>) => {
    const created = ++sequence
    const event = { id: `evt_${created}`, type, created, data, location: { directory: "/fixture" } } as OpenCodeEvent
    handleInstanceInvalidation(instanceId, event)
    handleNativeSessionEvent(instanceId, event)
  }
  const next = { sessionID: sessionId, assistantMessageID: "m2" }
  return {
    reads, emit, next, active,
    start() {
      const base = { sessionID: sessionId, assistantMessageID: "m1" }
      emit("session.step.started", { ...base, agent: "build", model, started: 1 })
      emit("session.tool.input.started", { ...base, id: "tool", name: "read" })
      emit("session.tool.called", { ...base, id: "tool", input: {} })
      emit("session.execution.succeeded", { sessionID: sessionId })
      assert.equal(reads.length, 1)
      emit("session.execution.started", { sessionID: sessionId })
      emit("session.step.started", { ...next, agent: "build", model, started: 6 })
      emit("session.text.started", next)
      emit("session.text.delta", { ...next, delta: "hello" })
      active.resolve({})
    },
    text() {
      const message = messageStoreBus.getOrCreate(instanceId).getMessage("m2")
      return message?.partIds.map(id => (message.parts[id].data as any).text).join("")
    },
    dispose() { destroyOpenCodeData(instanceId) },
    cleanup() {
      destroyOpenCodeData(instanceId)
      active.resolve({})
      for (const read of reads) read.resolve({ data: [], cursor: {} })
      sseManager.getStatuses = statuses
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    },
  }
}

async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve))
}

test("native terminal history settles under a newer streaming assistant in one read", async () => {
  const f = fixture("native-settlement-race")
  try {
    f.start()
    f.reads[0].resolve({ data: [completed], cursor: {} })
    await flush()
    // m1's terminal state comes from the page: the next step only stamped its
    // completion time. m2, created during the fetch, keeps its live text.
    assert.equal(f.reads.length, 1, "streaming arrivals must not restart the read")
    assert.equal(f.text(), "hello")
    f.emit("session.text.delta", { ...f.next, delta: " world" })
    f.emit("session.text.delta", { ...f.next, delta: "!" })
    assert.equal(f.text(), "hello world!", "streaming must continue over the accepted page")
    const m1 = messageStoreBus.getOrCreate("native-settlement-race").getMessage("m1")
    const tool = Object.values(m1?.parts ?? {}).map((part: any) => part.data).find((part: any) => part.type === "tool")
    assert.equal((tool as any)?.state?.status, "completed", "the page's terminal state was dropped")
    f.emit("session.text.delta", { ...f.next, delta: " More." })
    assert.equal(f.text(), "hello world! More.", "do not lose or double-apply deltas around the accepted page")
    assert.equal(f.reads.length, 1, "event bursts must not start overlapping reads")
  } finally { f.cleanup() }
})

test("a stranded running tool is reconciled when the next round begins", async () => {
  const f = fixture("native-settlement-stranded-round")
  try {
    const base = { sessionID: "s", assistantMessageID: "m1" }
    f.emit("session.step.started", { ...base, agent: "build", model, started: 1 })
    f.emit("session.tool.input.started", { ...base, id: "tool", name: "read" })
    f.emit("session.tool.called", { ...base, id: "tool", input: {} })
    // The daemon's loop fed the tool's result back and continued with a new
    // round, but the terminal tool event never arrived: the part is stranded
    // running in a finished round while the execution keeps going.
    f.emit("session.step.started", { ...f.next, agent: "build", model, started: 6 })
    assert.equal(f.reads.length, 1, "the next round's start must reconcile the stranded tool without waiting for settlement")
    f.reads[0].resolve({ data: [completed], cursor: {} })
    await flush()
    const m1 = messageStoreBus.getOrCreate("native-settlement-stranded-round").getMessage("m1")
    const tool = Object.values(m1?.parts ?? {}).map((part: any) => part.data).find((part: any) => part.type === "tool")
    assert.equal((tool as any)?.state?.status, "completed", "the stranded tool stayed running through the next round")
  } finally { f.cleanup() }
})

test("a tool running inside its own round is not reconciled", async () => {
  const f = fixture("native-settlement-active-round")
  try {
    const base = { sessionID: "s", assistantMessageID: "m1" }
    f.emit("session.step.started", { ...base, agent: "build", model, started: 1 })
    f.emit("session.tool.input.started", { ...base, id: "tool", name: "read" })
    f.emit("session.tool.called", { ...base, id: "tool", input: {} })
    f.emit("session.tool.progress", { ...base, id: "tool", metadata: {} })
    assert.equal(f.reads.length, 0, "a tool running inside the active round is normal")
  } finally { f.cleanup() }
})

test("a settlement arriving while a shared read is in flight still publishes", async () => {
  const f = fixture("native-settlement-shared-epoch")
  const running = { ...completed, content: [{ ...(completed.content[0] as any), state: { status: "running", input: { command: "pwd" }, metadata: {} } }] }
  try {
    const base = { sessionID: "s", assistantMessageID: "m1" }
    f.emit("session.step.started", { ...base, agent: "build", model, started: 1 })
    f.emit("session.tool.input.started", { ...base, id: "tool", name: "read" })
    f.emit("session.tool.called", { ...base, id: "tool", input: {} })
    // Execution N settles with the tool stranded running; its reconciliation
    // read A starts and stays in flight.
    f.emit("session.execution.succeeded", { sessionID: "s" })
    assert.ok(f.reads.length >= 1, "settlement read A started")
    // A newer execution starts and settles before A resolves; its terminal
    // event invalidates the SDK message key and queues a trailing read B.
    f.emit("session.execution.started", { sessionID: "s" })
    f.emit("session.execution.succeeded", { sessionID: "s" })
    // A resolves with the tool still running: only the trailing B carries
    // the completed truth, so the publication must follow B, not A.
    f.reads[0].resolve({ data: [running], cursor: {} })
    for (let index = 0; index < 100 && f.reads.length < 2; index++) await flush()
    assert.equal(f.reads.length, 2, "the trailing read B dispatched after A settled")
    f.reads[1].resolve({ data: [completed], cursor: {} })
    await flush()
    const m1 = messageStoreBus.getOrCreate("native-settlement-shared-epoch").getMessage("m1")
    const tool = Object.values(m1?.parts ?? {}).map((part: any) => part.data).find((part: any) => part.type === "tool")
    assert.equal((tool as any)?.state?.status, "completed", "the latest read's publication must heal the tool without another event")
  } finally { f.cleanup() }
})

test("a replaced reducer abandons its pending reconciliation read", async () => {
  const f = fixture("native-settlement-replaced-entry")
  const completedM2 = { ...completed, id: "m2", content: [{ type: "tool", id: "tool2", name: "read", time: { created: 8, ran: 9, completed: 10 }, state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }], metadata: {} } }] }
  const runningM2 = { ...completedM2, content: [{ ...(completedM2.content[0] as any), state: { status: "running", input: {}, metadata: {} } }] }
  try {
    const base = { sessionID: "s", assistantMessageID: "m1" }
    f.emit("session.step.started", { ...base, agent: "build", model, started: 1 })
    f.emit("session.tool.input.started", { ...base, id: "tool", name: "read" })
    f.emit("session.tool.called", { ...base, id: "tool", input: {} })
    // The step boundary reconciles the stranded tool; its read stays
    // unresolved against the reducer that started it.
    f.emit("session.step.started", { ...f.next, agent: "build", model, started: 6 })
    assert.equal(f.reads.length, 1)
    // A second tool runs in the active round before the reducer is replaced.
    f.emit("session.tool.input.started", { ...f.next, id: "tool2", name: "read" })
    f.emit("session.tool.called", { ...f.next, id: "tool2", input: {} })
    // Replace the reducer the way pruning does; its authoritative resync
    // answers with the daemon's persisted rows, m2's tool still running.
    invalidateOpenCodeSessionContent("native-settlement-replaced-entry", "s")
    await new Promise(resolve => setTimeout(resolve, 60))
    await flush()
    assert.ok(f.reads.length >= 2, "the replacement reducer resynced authoritatively")
    f.active.resolve({})
    for (const read of f.reads.slice(1)) read.resolve({ data: [completed, runningM2], cursor: {} })
    await flush()
    // The next round finishing strands m2's tool on the healthy replacement:
    // it must reconcile with its own read, not inherit the abandoned read's
    // pending flag.
    f.emit("session.step.started", { sessionID: "s", assistantMessageID: "m3", agent: "build", model, started: 12 })
    await flush()
    assert.equal(f.reads.length, 3, "the replacement's reconciliation must start its own read")
    f.reads[2].resolve({ data: [completedM2], cursor: {} })
    await flush()
    const m2 = messageStoreBus.getOrCreate("native-settlement-replaced-entry").getMessage("m2")
    const tool2 = Object.values(m2?.parts ?? {}).map((part: any) => part.data).find((part: any) => part.type === "tool")
    assert.equal((tool2 as any)?.state?.status, "completed", "the replacement reconciled the second stranded tool")
  } finally { f.cleanup() }
})

test("a disposed native projection does not retry a delayed terminal history read", async () => {
  const f = fixture("native-settlement-disposed")
  try {
    f.start()
    f.dispose()
    f.reads[0].resolve({ data: [completed], cursor: {} })
    await flush()
    assert.equal(f.reads.length, 1)
    assert.equal(f.text(), "hello", "disposal must preserve the separately owned visible snapshot")
  } finally { f.cleanup() }
})

test("a delivery crossing an HTTP-ahead settlement read reconciles through its own read and outlives the round's settlement", async () => {
  const f = fixture("native-delivery-http-ahead")
  const sessionId = "s"
  const order = () => messageStoreBus.getOrCreate("native-delivery-http-ahead")
    .getSessionMessageIds(sessionId)
  try {
    // Round one is interrupted with a tool still running: its settlement read
    // is owed and holds.
    const base = { sessionID: sessionId, assistantMessageID: "m1" }
    f.emit("session.step.started", { ...base, agent: "build", model, started: 1 })
    f.emit("session.tool.input.started", { ...base, id: "tool", name: "read" })
    f.emit("session.tool.called", { ...base, id: "tool", input: {} })
    f.emit("session.execution.interrupted", { sessionID: sessionId })
    assert.equal(f.reads.length, 1)

    // The prompt is parked over SSE before that read resolves.
    f.emit("session.inbox.enqueued", { sessionID: sessionId, inboxID: "msg_user", item: { type: "user", payload: { text: "crossing prompt" }, delivery: "steer" } })

    // The held read returns the daemon's page, which already carries the
    // delivered prompt above its reply: the delivery's own SSE still trails.
    // Round one's rows appear in their terminal native shapes, as the daemon
    // stored them (its idle record's id derives from the terminal event).
    const page = [
      { id: "m1", type: "assistant", agent: "build", model, time: { created: 1, completed: 2 }, content: [{
        type: "tool", id: "tool", name: "read", time: { created: 2, ran: 3, completed: 4 },
        state: { status: "completed", input: {}, content: [{ type: "text", text: "settled" }], metadata: {} },
      }] },
      { id: "msg_4", type: "idle", outcome: "interrupted", time: { created: 4 } },
      { id: "msg_user", type: "user", text: "crossing prompt", time: { created: 5 } },
      { id: "reply", type: "assistant", agent: "build", model, time: { created: 6 }, content: [{ type: "text", text: "answer" }] },
    ]
    f.reads[0].resolve({ data: [...page].reverse(), cursor: {} })
    await flush()
    assert.deepEqual(order(), ["m1", "msg_4", "msg_user", "reply"])

    // The delivery event finally arrives over SSE: the SDK relocates the
    // prompt below the reply, and the delivery owes its own authoritative
    // read, which holds.
    f.emit("session.inbox.delivered", { sessionID: sessionId, inboxID: "msg_user" })
    assert.equal(f.reads.length, 2, "the relocating delivery owed a repair read")

    // The reply's round settles while the repair is outstanding: the reducer
    // must survive as the repair's publication owner.
    f.emit("session.step.ended", { sessionID: sessionId, assistantMessageID: "reply", finish: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    f.emit("session.execution.succeeded", { sessionID: sessionId })
    assert.equal(f.reads.length, 2, "the settlement must not start a second read beneath the repair")

    // Resolving the repair publishes the page's order through the surviving
    // reducer instead of leaving the sunk prompt behind. (msg_8 is the round's
    // own idle record, inserted by its terminal event.)
    f.reads[1].resolve({ data: [...page].reverse(), cursor: {} })
    await flush()
    assert.deepEqual(order(), ["m1", "msg_4", "msg_user", "reply", "msg_8"], "the crossing prompt reconciles above its reply")

    // The settled reducer retired once the repair settled: the next event
    // lands on a fresh one, holding only its own row.
    const after = applyOpenCodeDataEvent("native-delivery-http-ahead", "/fixture", {
      id: "evt_probe", type: "session.step.started", created: 99, location: { directory: "/fixture" },
      data: { sessionID: sessionId, assistantMessageID: "m3", agent: "build", model, started: 9 },
    } as any)
    await flush()
    assert.deepEqual(
      after.session.message.list(sessionId).map((row: { id: string }) => row.id),
      ["m3"],
      "the settled reducer retired once the repair settled")
  } finally { f.cleanup() }
})

test("a delivery repair completing over a history window leaves that window's membership alone", async () => {
  const instanceId = "native-delivery-history-window"
  const f = fixture(instanceId)
  const store = messageStoreBus.getOrCreate(instanceId)
  const sessionId = "s"
  try {
    f.emit("session.inbox.enqueued", { sessionID: sessionId, inboxID: "msg_h", item: { type: "user", payload: { text: "parked" }, delivery: "steer" } })
    f.emit("session.step.started", { sessionID: sessionId, assistantMessageID: "h_reply", agent: "build", model, started: 2 })
    f.emit("session.inbox.delivered", { sessionID: sessionId, inboxID: "msg_h" })
    assert.equal(f.reads.length, 1, "the relocating delivery owed a repair read")
    await flush()
    const sunk = store.getSessionMessageIds(sessionId)
    assert.deepEqual(sunk, ["h_reply", "msg_h"], "the late delivery sinks the prompt until the repair lands")

    // The reader moves to a history window before the repair completes: the
    // repair must not rewrite that window's membership or cursors.
    store.setMessageWindow(sessionId, { kind: "history", resumeCursor: "c1", newerCursors: [null] })
    f.reads[0].resolve({
      data: [
        { id: "msg_h", type: "user", text: "parked", time: { created: 3 } },
        { id: "h_reply", type: "assistant", agent: "build", model, time: { created: 2 }, content: [] },
      ].reverse(),
      cursor: {},
    })
    await flush()
    assert.deepEqual(store.getSessionMessageIds(sessionId), sunk, "the history window keeps its membership")
    assert.equal(store.getMessageWindow(sessionId)?.kind, "history", "the window keeps its cursors")
  } finally { f.cleanup() }
})

test("a delivery repair completing for an inactive session does not project into its display", async () => {
  const instanceId = "native-delivery-inactive"
  const f = fixture(instanceId)
  const store = messageStoreBus.getOrCreate(instanceId)
  const sessionId = "s"
  try {
    f.emit("session.inbox.enqueued", { sessionID: sessionId, inboxID: "msg_i", item: { type: "user", payload: { text: "parked" }, delivery: "steer" } })
    f.emit("session.step.started", { sessionID: sessionId, assistantMessageID: "i_reply", agent: "build", model, started: 2 })
    f.emit("session.inbox.delivered", { sessionID: sessionId, inboxID: "msg_i" })
    assert.equal(f.reads.length, 1, "the relocating delivery owed a repair read")
    await flush()
    const before = store.getSessionMessageIds(sessionId)

    // The reader switches sessions before the repair completes: the inactive
    // session's display is left to its next activation read.
    setActiveSession(instanceId, "other")
    f.reads[0].resolve({
      data: [
        { id: "msg_i", type: "user", text: "parked", time: { created: 3 } },
        { id: "i_reply", type: "assistant", agent: "build", model, time: { created: 2 }, content: [] },
      ].reverse(),
      cursor: {},
    })
    await flush()
    assert.deepEqual(store.getSessionMessageIds(sessionId), before, "an inactive session's display keeps its projected page")
  } finally { f.cleanup() }
})
