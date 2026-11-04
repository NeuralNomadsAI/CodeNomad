import assert from "node:assert/strict"
import { test } from "node:test"
import { Schema } from "effect"
import { EventManifest } from "@opencode/schema/event-manifest"
import type { OpenCodeEvent } from "@opencode/client"
import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData, projectOpenCodeMessages } from "./opencode-data.ts"
import { setActiveSession, setSessions } from "./session-state.ts"

const sessionId = "ses_frame"
const model = { providerID: "fixture", id: "fixture" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
type Data = ReturnType<typeof applyOpenCodeDataEvent>

// Validate the actual installed native wire schema, including durable envelopes.
function eventFactory() {
  let sequence = 0
  return (type: string, payload: Record<string, unknown> = {}): OpenCodeEvent => {
    const definition = EventManifest.Latest.get(type as any) as any
    assert.ok(definition, type)
    const seq = ++sequence
    return Schema.decodeUnknownSync(definition)({
      id: `evt_${seq}`, type, created: seq, location: { directory: "/fixture" },
      ...(definition.durable ? { durable: { aggregateID: sessionId, seq, version: definition.durable.version } } : {}),
      data: { sessionID: sessionId, ...payload },
    }) as OpenCodeEvent
  }
}

/** A manual animation-frame clock: the renderer coalesces projections onto it. */
function frameClock() {
  const queue: (() => void)[] = []
  ;(globalThis as any).requestAnimationFrame = (callback: () => void) => {
    queue.push(callback)
    return queue.length
  }
  ;(globalThis as any).cancelAnimationFrame = () => {}
  return {
    fire() {
      const pending = queue.splice(0)
      for (const callback of pending) callback()
    },
    restore() {
      delete (globalThis as any).requestAnimationFrame
      delete (globalThis as any).cancelAnimationFrame
    },
  }
}

function fixture(instanceId: string) {
  const make = eventFactory()
  const nativeSession = {
    id: sessionId, title: "Frame", projectID: "prj_fixture", location: { directory: "/fixture" },
    time: { created: 1, updated: 1 }, cost: 0, tokens,
  }
  const client: any = {
    session: { active: async () => ({}), get: async () => nativeSession,
      inbox: { list: async () => [] }, form: { list: async () => [] } },
    permission: { list: async () => [] },
    message: { list: async () => ({ data: [], cursor: {} }) },
  }
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  const store = messageStoreBus.getOrCreate(instanceId)
  let data!: Data
  const apply = (type: string, payload: Record<string, unknown> = {}) => {
    data = applyOpenCodeDataEvent(instanceId, "/fixture", make(type, payload))
  }
  // A short resident history establishes the session's latest display window.
  for (let index = 0; index < 2; index++) {
    const assistantMessageID = `msg_${String(index).padStart(3, "0")}`
    apply("session.step.started", { assistantMessageID, agent: "build", model, started: index })
    apply("session.step.ended", { assistantMessageID, finish: "stop", cost: 0, tokens })
  }
  projectOpenCodeMessages(instanceId, sessionId, data)
  addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
    ...nativeSession, instanceId, parentId: null, status: "working", agent: "build",
    model: { providerId: "fixture", modelId: "fixture" },
  } as any]])))
  setActiveSession(instanceId, sessionId)
  return {
    instanceId, make, store,
    dispatch: (type: string, payload: Record<string, unknown> = {}) => handleInstanceInvalidation(instanceId, make(type, payload)),
    stream: (count: number) => {
      const streamId = "msg_live"
      handleInstanceInvalidation(instanceId, make("session.step.started", { assistantMessageID: streamId, agent: "build", model, started: 500 }))
      handleInstanceInvalidation(instanceId, make("session.text.started", { assistantMessageID: streamId, ordinal: 0 }))
      for (let index = 0; index < count; index++) {
        handleInstanceInvalidation(instanceId, make("session.text.delta", { assistantMessageID: streamId, ordinal: 0, delta: `[${index}]` }))
      }
      return { streamId, joined: Array.from({ length: count }, (_, index) => `[${index}]`).join("") }
    },
    storeText: (messageId: string) => Object.values(store.getMessage(messageId)?.parts ?? {})
      .filter(part => part.data.type === "text").map(part => (part.data as any).text).join(""),
    cleanup() {
      destroyOpenCodeData(instanceId)
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    },
  }
}

test("a same-task delta burst projects once at the next frame", ctx => {
  const clock = frameClock()
  const f = fixture("frame-burst")
  try {
    const hydration = ctx.mock.method(f.store, "hydrateMessages")
    const { streamId, joined } = f.stream(40)
    assert.equal(hydration.mock.callCount(), 0,
      "deltas admitted in one task must not project before the frame; store readers lag at most one frame")
    assert.equal(f.store.getMessage(streamId), undefined, "the streaming row is not yet resident")
    clock.fire()
    assert.equal(hydration.mock.callCount(), 1, "one frame projects the whole burst once")
    assert.equal(f.storeText(streamId), joined, "the projected page carries every admitted delta")
  } finally {
    clock.restore()
    f.cleanup()
  }
})

test("switching the active session flushes unprojected deltas", ctx => {
  const clock = frameClock()
  const f = fixture("frame-switch-flush")
  try {
    const hydration = ctx.mock.method(f.store, "hydrateMessages")
    const { streamId, joined } = f.stream(10)
    assert.equal(hydration.mock.callCount(), 0)
    setActiveSession(f.instanceId, "ses_other")
    assert.equal(hydration.mock.callCount(), 1, "a selection change flushes the pending projection")
    assert.equal(f.storeText(streamId), joined)
  } finally {
    clock.restore()
    f.cleanup()
  }
})

test("instance teardown drops pending projections instead of resurrecting stores", ctx => {
  const clock = frameClock()
  const f = fixture("frame-teardown")
  try {
    const hydration = ctx.mock.method(f.store, "hydrateMessages")
    f.stream(5)
    assert.equal(hydration.mock.callCount(), 0)
    removeInstance(f.instanceId, { authoritative: false })
    clock.fire()
    assert.equal(hydration.mock.callCount(), 0, "a destroyed instance projects nothing")
    assert.equal(messageStoreBus.getInstance(f.instanceId), undefined,
      "no later frame may resurrect the destroyed instance's store")
  } finally {
    clock.restore()
    f.cleanup()
  }
})

test("a destructive event projects synchronously and subsumes the pending frame", ctx => {
  const clock = frameClock()
  const f = fixture("frame-destructive")
  try {
    const hydration = ctx.mock.method(f.store, "hydrateMessages")
    f.stream(5)
    assert.equal(hydration.mock.callCount(), 0)
    f.dispatch("session.inbox.cancelled", { inboxID: "msg_inbox_1" })
    assert.equal(hydration.mock.callCount(), 1, "the destructive event projects its page synchronously")
    clock.fire()
    assert.equal(hydration.mock.callCount(), 1, "the subsumed frame projects nothing more")
    // Teardown of a deleted session drops its pending frame the same way.
    f.stream(5)
    f.dispatch("session.deleted")
    clock.fire()
    assert.equal(hydration.mock.callCount(), 1, "a deleted session never projects a later frame")
  } finally {
    clock.restore()
    f.cleanup()
  }
})
