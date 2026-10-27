import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeEvent } from "@opencode/client"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { destroyOpenCodeData } from "./opencode-data.ts"
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
    },
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
    reads, emit, next,
    store: () => messageStoreBus.getOrCreate(instanceId),
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

test("native terminal history reconciles over a newer streaming assistant in one read", async () => {
  const f = fixture("native-settlement-race")
  try {
    f.start()
    f.reads[0].resolve({ data: [completed], cursor: {} })
    await flush()
    // The settled page answers in one read: m1's terminal state comes from
    // the page (its events predate the fetch), while m2 — streamed inside the
    // fetch window — rides along with its live text instead of being culled
    // or restarting the read.
    assert.equal(f.reads.length, 1, "streaming arrivals must not restart the settled read")
    assert.equal(f.text(), "hello", "the streamed assistant rode along with the page")

    f.emit("session.text.delta", { ...f.next, delta: " world" })
    f.emit("session.text.delta", { ...f.next, delta: "!" })
    assert.equal(f.text(), "hello world!", "streaming must continue over the accepted page")
    assert.equal(f.reads.length, 1, "event bursts must not start overlapping reads")

    // The same projection carries the page's terminal state to the display.
    const m1 = f.store().getMessage("m1")
    const tool = Object.values(m1?.parts ?? {}).map((part: any) => part.data).find((part: any) => part.type === "tool")
    assert.equal((tool as any)?.state?.status, "completed", "the page's terminal state was dropped")

    f.emit("session.text.delta", { ...f.next, delta: " More." })
    assert.equal(f.text(), "hello world! More.", "do not lose or double-apply deltas around the accepted page")
    assert.equal(f.reads.length, 1)
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
