import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeRuntimeEvent } from "../../../server/src/opencode/compatibility/events.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { handleNativeSessionEvent, handleSessionIdle, handleSessionStatus } from "./session-events.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { setActiveSession, setSessions } from "./session-state.ts"

test("the current native reducer preserves old event timing and newer precise start times", () => {
  for (const started of [undefined, 0, 45]) {
    const instanceId = `runtime-started-${started}`
    const original = {
      id: "evt_step", type: "session.step.started", created: 100,
      durable: { aggregateID: "s", seq: 2, version: 1 },
      data: { sessionID: "s", assistantMessageID: "m", agent: "build", model: { providerID: "fixture", id: "fixture" },
        ...(started === undefined ? {} : { started }) },
    }
    try {
      const event = normalizeRuntimeEvent(original as any)
      const data = applyOpenCodeDataEvent(instanceId, "/fixture", event)
      assert.equal(data.session.message.get("s", "m")?.time.created, started ?? 100)
      assert.ok("durable" in event)
      assert.deepEqual(event.durable, original.durable)
      assert.equal(original.data.started, started, "normalization must not mutate the input event")
    } finally { destroyOpenCodeData(instanceId) }
  }
})

for (const following of ["none", "idle", "status-idle", "new-execution"] as const) {
test(`settled tools reach the visible store with following ${following}`, async () => {
  const instanceId = `runtime-tool-settlement-${following}`, sessionId = "s"
  const statuses = sseManager.getStatuses
  sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
  let reads = 0
  const completed = {
    id: "m", type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" },
    time: { created: 1, completed: 5 }, content: [{ type: "tool", id: "tool", name: "read",
      time: { created: 2, ran: 3, completed: 4 },
      state: { status: "completed", input: { path: "fixture" }, content: [{ type: "text", text: "settled" }], metadata: {} },
    }],
  }
  let release!: (value: Record<string, unknown>) => void
  const active = new Promise<Record<string, unknown>>(resolve => { release = resolve })
  const client = {
    session: { active: () => active, get: async () => ({ id: sessionId, location: { directory: "/fixture" }, time: { created: 1, updated: 5 } }) },
    message: { list: async () => { reads++; return { data: [completed], cursor: {} } } },
  } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
    id: sessionId, instanceId, title: "Fixture", parentId: null, location: { directory: "/fixture" },
    status: "working", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
  } as any]])))
  setActiveSession(instanceId, sessionId)
  const emit = (type: string, data: Record<string, unknown>, created: number) => {
    const event = normalizeRuntimeEvent({ id: `evt_${created}`, type, created, data, location: { directory: "/fixture" } } as any)
    handleInstanceInvalidation(instanceId, event)
    handleNativeSessionEvent(instanceId, event)
  }
  const state = () => (messageStoreBus.getOrCreate(instanceId).getMessage("m")?.parts.tool?.data as any)?.state
  try {
    const base = { sessionID: sessionId, assistantMessageID: "m" }
    emit("session.step.started", { ...base, agent: "build", model: completed.model, started: 1 }, 1)
    emit("session.tool.input.started", { ...base, id: "tool", name: "read" }, 2)
    emit("session.tool.called", { ...base, id: "tool", input: { path: "fixture" } }, 3)
    assert.equal(state()?.status, "running")
    emit("session.execution.succeeded", { sessionID: sessionId }, 5)
    if (following === "idle") handleSessionIdle(instanceId, { type: "session.idle", data: { sessionID: sessionId }, created: 6 } as any)
    if (following === "status-idle") handleSessionStatus(instanceId, { type: "session.status", data: { sessionID: sessionId, status: { type: "idle" } }, created: 6 } as any)
    if (following === "new-execution") emit("session.execution.started", { sessionID: sessionId }, 6)
    release({})
    if (following === "new-execution") {
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(state()?.status, "running", "a superseded terminal check cannot replace the current transcript")
      return
    }
    for (let attempt = 0; attempt < 100 && state()?.status !== "completed"; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(reads > 0, "settlement must consult native history")
    assert.equal(state()?.status, "completed")
    assert.equal(state()?.output, "settled")
  } finally {
    release({})
    sseManager.getStatuses = statuses
    destroyOpenCodeData(instanceId)
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
    if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
  }
})
}
