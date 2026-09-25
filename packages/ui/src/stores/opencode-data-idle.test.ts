import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeEvent } from "@opencode/client"
import { sdkManager } from "../lib/sdk-manager.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { getRootClient } from "./opencode-client.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData, finishOpenCodeDataEvent, getOpenCodeMessageRevision, getOpenCodeMutationRevision, projectOpenCodeMessages } from "./opencode-data.ts"

const model = { providerID: "fixture", id: "fixture" }
const sessionId = "session"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture(instanceId: string) {
  let sequence = 0
  let resynced: ReturnType<typeof applyOpenCodeDataEvent> | undefined
  const projected = deferred<void>()
  const project = (data: ReturnType<typeof applyOpenCodeDataEvent>) => projectOpenCodeMessages(instanceId, sessionId, data)
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    const created = ++sequence
    const event = { id: `event-${created}`, type, created, data: { sessionID: sessionId, ...data } } as OpenCodeEvent
    const result = applyOpenCodeDataEvent(instanceId, "/work", event, project, next => {
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

test("idle drains the queued final step before retiring a rotating reducer", async () => {
  const f = fixture("idle-rotation-drain")
  try {
    f.fill()
    f.finalStep()
    const retiring = f.emit("session.idle")
    assert.equal(f.store.getMessage("final"), undefined, "the final step is still queued")
    await new Promise<void>(resolve => setImmediate(resolve))
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
    const retained = f.emit("session.idle")
    f.emit("session.execution.started")
    f.emit("session.step.started", { assistantMessageID: "resumed", agent: "build", model })
    await new Promise<void>(resolve => setImmediate(resolve))
    f.emit("session.text.started", { assistantMessageID: "resumed" })
    const current = f.emit("session.text.delta", { assistantMessageID: "resumed", delta: "still running" })
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
      f.emit("session.idle")
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
      f.emit("session.idle")
      assert.equal(getOpenCodeMutationRevision(instanceId, sessionId), revision)
      assert.equal(getOpenCodeMessageRevision(instanceId, sessionId), revision)
      assert.notEqual(f.emit("permission.replied", { requestID: "missing" }), reducer)
    }
  } finally { f.cleanup() }
})
