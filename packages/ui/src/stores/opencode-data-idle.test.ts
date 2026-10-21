import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeEvent } from "@opencode/client"
import { sdkManager } from "../lib/sdk-manager.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { getRootClient } from "./opencode-client.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData, finishOpenCodeDataEvent, getOpenCodeMessageRevision, getOpenCodeMutationRevision, projectOpenCodeMessages } from "./opencode-data.ts"

const model = { providerID: "fixture", id: "fixture" }
const sessionId = "session"
// OpenCode V2 settles every busy period with one session.execution.* event.
const SETTLED = "session.execution.succeeded"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture(instanceId: string) {
  let sequence = 0
  let idleApplied = false
  let resynced: ReturnType<typeof applyOpenCodeDataEvent> | undefined
  const projected = deferred<void>()
  const project = (data: ReturnType<typeof applyOpenCodeDataEvent>) => projectOpenCodeMessages(instanceId, sessionId, data)
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    const created = ++sequence
    const event = { id: `event-${created}`, type, created, data: { sessionID: sessionId, ...data } } as OpenCodeEvent
    const result = applyOpenCodeDataEvent(instanceId, "/work", event, next => {
      project(next)
      if (type === SETTLED) idleApplied = true
    }, next => {
      resynced = next
      projectOpenCodeMessages(instanceId, sessionId, next, false)
      projected.resolve()
    })
    project(result)
    finishOpenCodeDataEvent(instanceId, event)
    return result
  }
  return {
    emit, projected,
    get idleApplied() { return idleApplied },
    get resynced() { return resynced },
    store: messageStoreBus.getOrCreate(instanceId),
    fill() {
      for (let index = 0; index < 200; index += 1) {
        emit("session.step.started", { assistantMessageID: `m${index}`, agent: "build", model })
        emit("session.step.ended", { assistantMessageID: `m${index}`, finish: "stop" })
      }
    },
    finalStep() {
      const base = { assistantMessageID: "final" }
      emit("session.step.started", { ...base, agent: "build", model })
      emit("session.text.started", base)
      emit("session.text.delta", { ...base, ordinal: 0, delta: "final answer" })
      emit("session.step.ended", { ...base, finish: "stop" })
    },
    cleanup() {
      destroyOpenCodeData(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    },
  }
}

function assertFinal(store: ReturnType<typeof messageStoreBus.getOrCreate>) {
  assert.ok(store.getSessionMessageIds(sessionId).includes("final"))
  const message = store.getMessage("final")
  assert.equal((message?.parts["final-text-0"]?.data as any)?.text, "final answer")
  assert.equal(message?.status, "complete")
  assert.ok(store.getMessageInfo("final")?.time?.completed)
  assert.ok(store.getSessionMessageIds(sessionId).length <= 200)
}

async function waitForReplay(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500 && !done(); turn++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  assert.ok(done(), "cooperative replay did not publish its final event")
}

test("idle drains the queued final step before retiring a rotating reducer", async () => {
  const f = fixture("idle-rotation-drain")
  try {
    f.fill()
    f.finalStep()
    const retiring = f.emit(SETTLED)
    assert.equal(f.store.getMessage("final"), undefined, "the final step is still queued")
    await waitForReplay(() => f.idleApplied)
    assertFinal(f.store)
    const replacement = f.emit("permission.replied", { requestID: "missing" })
    assert.notEqual(replacement, retiring, "release the idle reducer after the final projection")
    assert.deepEqual(replacement.session.message.list(sessionId), [])
    assertFinal(f.store)
  } finally { f.cleanup() }
})

test("a new execution cancels deferred idle retirement while rotation drains", async () => {
  const f = fixture("idle-rotation-resumed")
  try {
    f.fill()
    f.finalStep()
    const retained = f.emit(SETTLED)
    f.emit("session.execution.started")
    f.emit("session.step.started", { assistantMessageID: "resumed", agent: "build", model })
    f.emit("session.text.started", { assistantMessageID: "resumed" })
    const current = f.emit("session.text.delta", { assistantMessageID: "resumed", delta: "still running" })
    await waitForReplay(() => (f.store.getMessage("resumed")?.parts["resumed-text-0"]?.data as any)?.text === "still running")
    assert.equal(current, retained)
    assert.equal((f.store.getMessage("resumed")?.parts["resumed-text-0"]?.data as any)?.text, "still running")
  } finally { f.cleanup() }
})

for (const phase of ["scheduled", "inflight", "retry"] as const) {
  test(`idle preserves the final authoritative page during ${phase} overflow recovery`, { timeout: 5000 }, async () => {
    const instanceId = `idle-resync-${phase}`
    const f = fixture(instanceId)
    const first = deferred<any>()
    const started = deferred<void>()
    const page = { data: [{
      id: "final", type: "assistant", agent: "build", model,
      content: [{ type: "text", text: "final answer" }], time: { created: 5000, completed: 5001 },
    }], cursor: {} }
    const client = getRootClient(instanceId) as any
    let reads = 0
    client.session.get = async () => ({ id: sessionId, location: { directory: "/work" }, time: { created: 1, updated: 5001 } })
    client.session.active = async () => ({})
    client.session.inbox = { list: async () => [] }
    client.permission.list = async () => []
    client.session.form.list = async () => []
    client.message.list = () => {
      reads += 1
      started.resolve()
      return reads === 1 && phase !== "scheduled" ? first.promise : Promise.resolve(page)
    }
    try {
      f.fill()
      for (let index = 0; index < 4096; index += 1) {
        // Fill the queue without repeatedly normalizing the unchanged old page.
        // Terminal delivery below uses the production apply/project/finish order.
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `overflow-${index}`, type: "session.step.started", created: 500 + index,
          data: { sessionID: sessionId, assistantMessageID: `overflow-${index}`, agent: "build", model },
        } as OpenCodeEvent)
      }
      if (phase !== "scheduled") await started.promise
      f.emit("session.step.ended", { assistantMessageID: "final", finish: "stop" })
      f.emit(SETTLED)
      assert.equal(f.store.getMessage("final"), undefined)
      if (phase === "inflight") first.resolve({ data: [], cursor: {} })
      if (phase === "retry") first.reject(new Error("temporary recovery failure"))
      await f.projected.promise
      assert.equal(reads, phase === "scheduled" ? 1 : 2)
      assertFinal(f.store)
      const replacement = f.emit("permission.replied", { requestID: "missing" })
      assert.notEqual(replacement, f.resynced, "free the reconciled idle payload")
      assert.deepEqual(replacement.session.message.list(sessionId), [])
      assertFinal(f.store)
    } finally { first.resolve(page); f.cleanup() }
  })
}

test("idle payload disposal preserves monotonic message and mutation revisions", () => {
  const instanceId = "idle-request-revisions"
  const f = fixture(instanceId)
  try {
    for (let revision = 1; revision <= 3; revision += 1) {
      const reducer = f.emit("session.inbox.cancelled", { inboxID: "removed" })
      f.emit(SETTLED)
      assert.equal(getOpenCodeMutationRevision(instanceId, sessionId), revision)
      // The cancellation and the settlement (its native idle record) each change messages.
      assert.equal(getOpenCodeMessageRevision(instanceId, sessionId), revision * 2)
      assert.notEqual(f.emit("permission.replied", { requestID: "missing" }), reducer)
    }
  } finally { f.cleanup() }
})

for (const [terminal, data] of [
  ["session.execution.failed", { error: { type: "fixture", message: "failed" } }],
  ["session.execution.interrupted", { reason: "user" }],
] as const) {
  test(`${terminal} also releases the settled reducer`, () => {
    const f = fixture(`settled-${terminal}`)
    try {
      f.finalStep()
      const settled = f.emit(terminal, data)
      assert.notEqual(f.emit("permission.replied", { requestID: "missing" }), settled)
      assertFinal(f.store)
    } finally { f.cleanup() }
  })
}

test("a settled session keeps its reducer while prompts stay parked in its inbox", () => {
  const f = fixture("settled-parked-prompt")
  try {
    f.emit("session.inbox.enqueued", { inboxID: "parked", item: { type: "user", payload: { text: "later" }, delivery: "queue" } })
    f.finalStep()
    // Interruption keeps queued next-turn prompts parked; the composer queue reads them from this reducer.
    const settled = f.emit("session.execution.interrupted", { reason: "user" })
    assert.deepEqual(settled.session.pending.list(sessionId).map((item) => item.id), ["parked"])
    assert.equal(f.emit("permission.replied", { requestID: "missing" }), settled)
    f.emit("session.inbox.cancelled", { inboxID: "parked" })
    assert.notEqual(f.emit("permission.replied", { requestID: "missing" }), settled, "released once nothing is parked")
  } finally { f.cleanup() }
})

test("a settled session keeps its reducer until a user shell started before settlement ends", () => {
  const f = fixture("settled-running-shell")
  try {
    const shell = { id: "shell-1", command: "sleep 5", status: "running", metadata: {} }
    f.emit("session.shell.started", { shell })
    f.finalStep()
    const settled = f.emit(SETTLED)
    assert.equal(f.emit("permission.replied", { requestID: "missing" }), settled)
    // A fresh reducer ignores session.shell.ended for a shell it never saw.
    const ended = f.emit("session.shell.ended", { shell: { ...shell, status: "exited", exit: 0 }, output: { output: "done" } })
    assert.equal(ended, settled, "the shell settles in the reducer that created its message")
    const row = ended.session.message.list(sessionId).find((message) => message.type === "shell")
    assert.equal(row?.type === "shell" ? row.status : undefined, "exited")
    assert.equal(f.store.getMessage(row!.id)?.status, "complete", "the projected row leaves the running state")
    assert.notEqual(f.emit("permission.replied", { requestID: "missing" }), settled, "released once the shell ended")
  } finally { f.cleanup() }
})

test("a same-source reconnect keeps deferred retirement for a still-running shell", async () => {
  const instanceId = "settled-shell-reconnect"
  const f = fixture(instanceId)
  const client = getRootClient(instanceId) as any
  client.session.get = async () => ({ id: sessionId, location: { directory: "/work" }, time: { created: 1, updated: 6001 } })
  client.session.active = async () => ({})
  client.session.inbox = { list: async () => [] }
  client.permission.list = async () => []
  client.session.form.list = async () => []
  client.message.list = async () => ({
    data: [{
      id: "final", type: "assistant", agent: "build", model,
      content: [{ type: "text", text: "final answer" }], time: { created: 5000, completed: 5001 },
    }], cursor: {},
  })
  try {
    // Record the daemon identity the later reconnect is verified against.
    f.emit("server.connected", { daemon: "source-a" })
    const shell = { id: "shell-1", command: "sleep 5", status: "running", metadata: {} }
    f.emit("session.shell.started", { shell })
    f.finalStep()
    const settled = f.emit(SETTLED)
    assert.equal(f.emit("permission.replied", { requestID: "missing" }), settled)

    // Transport reconnect from the same daemon: the recreated reducer keeps
    // the deferred retirement, so the shell still settles in it.
    f.emit("server.connected", { daemon: "source-a" })
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    await waitForReplay(() => f.emit("session.usage.updated", { cost: 0, tokens })
      .session.message.list(sessionId).some((message) => message.type === "shell"))
    const ended = f.emit("session.shell.ended", { shell: { ...shell, status: "exited", exit: 0 }, output: { output: "done" } })
    assert.notEqual(ended, settled, "the shell settles in the recreated reducer")
    const row = ended.session.message.list(sessionId).find((message) => message.type === "shell")
    assert.equal(row?.type === "shell" ? row.status : undefined, "exited")

    // The reconciliation armed at the reconnect trails the last arrival by its
    // quiet delay; once it settles, the deferred retirement completes.
    await new Promise(resolve => setTimeout(resolve, 2600))
    const replacement = f.emit("permission.replied", { requestID: "missing" })
    assert.notEqual(replacement, ended, "released once the shell ended after the reconnect")
    assert.deepEqual(replacement.session.message.list(sessionId), [], "no resident rows outlive the settlement")
  } finally { f.cleanup() }
})
