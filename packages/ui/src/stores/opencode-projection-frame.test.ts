import assert from "node:assert/strict"
import { test } from "node:test"
import { Schema } from "effect"
import { EventManifest } from "@opencode/schema/event-manifest"
import type { OpenCodeEvent } from "@opencode/client"
import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData, projectOpenCodeMessages } from "./opencode-data.ts"
import { setActiveSession, setSessions, getSessionInfo } from "./session-state.ts"

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

function fixture(instanceId: string, options: { seed?: number } = {}) {
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
  // A resident history establishes the session's latest display window; a full
  // 200-message window additionally forces later replies through rotation replay.
  for (let index = 0; index < (options.seed ?? 2); index++) {
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

test("an idle compositor that never frames still projects through the fallback", async ctx => {
  // Headless/hidden pages can stop producing frames entirely; every visible
  // schedule arms a short fallback so a pending page can never hang.
  ;(globalThis as any).requestAnimationFrame = () => 1
  ;(globalThis as any).cancelAnimationFrame = () => {}
  const f = fixture("frame-fallback")
  try {
    const hydration = ctx.mock.method(f.store, "hydrateMessages")
    const { streamId, joined } = f.stream(20)
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(hydration.mock.callCount(), 1, "the frame fallback projects without a compositor frame")
    assert.equal(f.storeText(streamId), joined)
  } finally {
    delete (globalThis as any).requestAnimationFrame
    delete (globalThis as any).cancelAnimationFrame
    f.cleanup()
  }
})

test("an execution settlement projects its final status in the same task", ctx => {
  const clock = frameClock()
  const f = fixture("frame-settlement")
  try {
    const hydration = ctx.mock.method(f.store, "hydrateMessages")
    const { streamId } = f.stream(5)
    assert.equal(hydration.mock.callCount(), 0)
    assert.equal(f.store.getMessage(streamId), undefined, "the streaming row is not resident before a frame")
    f.dispatch("session.step.ended", { assistantMessageID: "msg_live", finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
    f.dispatch("session.execution.succeeded", {})
    const settled = f.store.getMessage("msg_live")
    assert.ok(settled, "the settlement projected synchronously")
    assert.equal(settled.status, "complete", "interactive reads never see a settled row lag a frame behind")
    clock.fire()
    assert.equal(hydration.mock.callCount(), 1, "the settlement subsumed the pending frame")
  } finally {
    clock.restore()
    f.cleanup()
  }
})

test("a synchronous settlement adopts the pending frame's usage obligation", ctx => {
  const clock = frameClock()
  const f = fixture("frame-usage-adoption")
  try {
    const hydration = ctx.mock.method(f.store, "hydrateMessages")
    f.dispatch("session.step.started", { assistantMessageID: "msg_live", agent: "build", model, started: 500 })
    f.dispatch("session.text.started", { assistantMessageID: "msg_live", ordinal: 0 })
    f.dispatch("session.text.delta", { assistantMessageID: "msg_live", ordinal: 0, delta: "done" })
    // A usage-carrying step end schedules the totals update; the settlement
    // that follows in the same task publishes synchronously and must adopt it.
    f.dispatch("session.step.ended", { assistantMessageID: "msg_live", finish: "stop", cost: 1, tokens: { input: 60, output: 58, reasoning: 0, cache: { read: 0, write: 0 } } })
    assert.equal(hydration.mock.callCount(), 0, "the delta stream only scheduled")
    assert.equal(getSessionInfo(f.instanceId, sessionId), undefined, "no totals published before the barrier")
    f.dispatch("session.execution.succeeded", {})
    assert.equal(hydration.mock.callCount(), 1, "the settlement published its page synchronously")
    assert.notEqual(getSessionInfo(f.instanceId, sessionId), undefined,
      "the settlement adopted the pending frame's usage update")
    clock.fire()
    assert.equal(hydration.mock.callCount(), 1)
  } finally {
    clock.restore()
    f.cleanup()
  }
})

test("destroying the reducer cancels its pending frame at the shared boundary", ctx => {
  const clock = frameClock()
  const f = fixture("frame-destroy-boundary")
  try {
    const hydration = ctx.mock.method(f.store, "hydrateMessages")
    f.stream(5)
    assert.equal(hydration.mock.callCount(), 0)
    destroyOpenCodeData(f.instanceId, sessionId)
    clock.fire()
    assert.equal(hydration.mock.callCount(), 0, "a destroyed reducer never publishes a later frame")
    assert.equal(f.store.getMessage("msg_live"), undefined, "no frame resurrects the destroyed reducer's rows")
  } finally {
    clock.restore()
    f.cleanup()
  }
})

test("a replayed settlement chunk publishes before the drained reducer retires", async ctx => {
  const clock = frameClock()
  const f = fixture("frame-replay-settlement", { seed: 200 })
  try {
    const hydration = ctx.mock.method(f.store, "hydrateMessages")
    const overflow = (type: string, payload: Record<string, unknown> = {}) => f.dispatch(type, {
      assistantMessageID: "msg_over", ...payload,
    })
    // The full window queues the reply; the replayed chunk carrying the
    // settlement must publish in the replay task, not on a later frame.
    overflow("session.step.started", { agent: "build", model, started: 900 })
    overflow("session.text.started", { ordinal: 0 })
    overflow("session.text.delta", { ordinal: 0, delta: "completed reply" })
    overflow("session.text.ended", { ordinal: 0, text: "completed reply" })
    overflow("session.step.ended", { finish: "stop", cost: 0, tokens })
    overflow("session.execution.succeeded", {})
    const deadline = Date.now() + 5_000
    while (f.store.getMessage("msg_over")?.status !== "complete" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(f.store.getMessage("msg_over")?.status, "complete",
      "the queued reply's settlement page reached the store without any frame")
    assert.ok(f.storeText("msg_over").includes("completed reply"))
  } finally {
    clock.restore()
    f.cleanup()
  }
})

test("a pending frame respects the latest-window gate", ctx => {
  const clock = frameClock()
  const f = fixture("frame-window-gate")
  try {
    const hydration = ctx.mock.method(f.store, "hydrateMessages")
    f.stream(3)
    f.store.setMessageWindow(sessionId, { kind: "history", resumeCursor: "cursor", newerCursors: [] })
    clock.fire()
    assert.equal(hydration.mock.callCount(), 0, "a history window must not take streaming projections")
    assert.equal(f.store.getMessage("msg_live"), undefined)
  } finally {
    clock.restore()
    f.cleanup()
  }
})

test("a hidden window projects on its bounded timer instead of animation frames", async ctx => {
  ;(globalThis as any).document = { hidden: true }
  const f = fixture("frame-hidden-timer")
  try {
    const hydration = ctx.mock.method(f.store, "hydrateMessages")
    const { streamId, joined } = f.stream(5)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(hydration.mock.callCount(), 0, "the hidden interval has not elapsed yet")
    await new Promise(resolve => setTimeout(resolve, 320))
    assert.equal(hydration.mock.callCount(), 1, "the hidden timer projects the coalesced page")
    assert.equal(f.storeText(streamId), joined)
  } finally {
    delete (globalThis as any).document
    f.cleanup()
  }
})

test("a merged frame keeps the last event's confirmation and accumulates usage", ctx => {
  const clock = frameClock()
  try {
    const confirming = fixture("frame-confirm-true")
    const confirmHydration = ctx.mock.method(confirming.store, "hydrateMessages")
    confirming.dispatch("session.text.delta", { assistantMessageID: "msg_live", ordinal: 0, delta: "a" })
    confirming.dispatch("session.inbox.enqueued", { inboxID: "msg_queued", item: { type: "user", payload: { text: "next" }, delivery: "queue" } })
    clock.fire()
    assert.equal(confirmHydration.mock.callCount(), 1)
    assert.equal(confirmHydration.mock.calls[0].arguments[3]?.confirmPending, false,
      "an inbox.enqueued tail keeps the parked prompt's row pending")

    const settling = fixture("frame-confirm-false")
    const settleHydration = ctx.mock.method(settling.store, "hydrateMessages")
    settling.dispatch("session.inbox.enqueued", { inboxID: "msg_queued2", item: { type: "user", payload: { text: "next" }, delivery: "queue" } })
    settling.dispatch("session.text.delta", { assistantMessageID: "msg_live", ordinal: 0, delta: "b" })
    clock.fire()
    assert.equal(settleHydration.mock.callCount(), 1)
    assert.equal(settleHydration.mock.calls[0].arguments[3]?.confirmPending, true,
      "an ordinary tail confirms pending sends again")
    settling.cleanup()
    confirming.cleanup()
  } finally {
    clock.restore()
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
