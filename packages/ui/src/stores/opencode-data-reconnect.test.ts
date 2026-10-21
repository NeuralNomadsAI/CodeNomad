import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { Schema } from "effect"
import { EventManifest } from "@opencode/schema/event-manifest"
import type { OpenCodeEvent } from "@opencode/client"
import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import {
  applyOpenCodeDataEvent, destroyOpenCodeData, invalidateOpenCodeSessionContent,
  type OpenCodeDataEventAdmission,
} from "./opencode-data.ts"
import { setActiveSession, setSessions } from "./session-state.ts"

// Streaming continuity across a shared-stream reconnect (server.connected):
// the resident live page keeps serving deltas while one quiet, revision-stable
// snapshot reconciles what the disconnect window may have missed.

const sessionId = "ses_reconnect"
const model = { providerID: "fixture", id: "fixture" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
type Data = ReturnType<typeof applyOpenCodeDataEvent>
type Publication = NonNullable<OpenCodeDataEventAdmission["publication"]>
/** Reasoning events carry the part ordinal next to the assistant message id. */
const live = { assistantMessageID: "msg_live", ordinal: 0 }

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

interface ControlledList {
  calls: number
  /** Resolve the in-flight list read, if any. */
  settle(): void
  pending(): boolean
}

function fixture(instanceId: string, dispatcher = false) {
  const make = eventFactory()
  const nativeSession = {
    id: sessionId, title: "Reconnect", projectID: "prj_fixture", location: { directory: "/fixture" },
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
  const apply = (type: string, payload: Record<string, unknown> = {}, callback?: (data: Data) => void,
    publication?: Publication, resynced?: (data: Data) => void) => {
    const admission: OpenCodeDataEventAdmission = { deferred: false, publication }
    data = applyOpenCodeDataEvent(instanceId, "/fixture", make(type, payload), callback, resynced, false, admission)
    return admission
  }
  for (let index = 0; index < 200; index++) {
    const assistantMessageID = `msg_${String(index).padStart(3, "0")}`
    apply("session.step.started", { assistantMessageID, agent: "build", model, started: index })
    apply("session.step.ended", { assistantMessageID, finish: "stop", cost: 0, tokens })
  }
  if (dispatcher) {
    addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
      ...nativeSession, instanceId, parentId: null, status: "working", agent: "build",
      model: { providerId: "fixture", modelId: "fixture" },
    } as any]])))
    setActiveSession(instanceId, sessionId)
  }
  const authoritativeText = () => "authoritative-final-reasoning"
  const controlledList = (page: () => unknown[]): ControlledList => {
    let settleRead: (() => void) | undefined
    const control: ControlledList = {
      calls: 0,
      pending: () => settleRead !== undefined,
      settle() { const settle = settleRead; settleRead = undefined; settle?.() },
    }
    client.message.list = async () => {
      control.calls += 1
      await new Promise<void>(resolve => { settleRead = resolve })
      return { data: page(), cursor: {} }
    }
    return control
  }
  const authoritativePage = () => [{
    id: "msg_live", type: "assistant", agent: "build", model,
    content: [{ type: "reasoning", text: authoritativeText() }],
    time: { created: 500, completed: 501 },
  }]
  return {
    instanceId, make, apply, client, store, data: () => data,
    controlledList, authoritativePage, authoritativeText,
    dispatch: (type: string, payload: Record<string, unknown> = {}) => handleInstanceInvalidation(instanceId, make(type, payload)),
    start: (publication?: Publication) => apply("session.step.started", {
      assistantMessageID: "msg_live", agent: "build", model, started: 500,
    }, undefined, publication),
    /** Live reasoning text as projected into the display store. */
    storeText: () => {
      const record = store.getMessage("msg_live")
      const part = record?.parts["msg_live-reasoning-0"]
      return part ? String((part.data as any).text ?? "") : undefined
    },
    sdkText: () => (data.session.message.get(sessionId, "msg_live") as any)?.content?.[0]?.text as string | undefined,
    delta: (text: string) => apply("session.reasoning.delta", { ...live, delta: text }),
    cleanup() {
      destroyOpenCodeData(instanceId)
      if (dispatcher) removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    },
  }
}

async function microtasks() {
  for (let index = 0; index < 40; index++) await Promise.resolve()
}

async function converge(ctx: TestContext, done: () => boolean) {
  for (let index = 0; index < 500 && !done(); index++) {
    ctx.mock.timers.tick(0)
    await microtasks()
  }
}

test("a message.list read cannot complete while stream events keep arriving", async ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("reconnect-race")
  try {
    f.start()
    f.apply("session.reasoning.started", live)
    f.delta("seed ")
    await converge(ctx, () => f.storeText() === "seed ")
    ctx.mock.timers.tick(0)
    await microtasks()

    // Rotation has drained: fast-path deltas apply synchronously now.
    f.delta("probe ")
    assert.equal(f.sdkText(), "seed probe ", "deltas emit synchronously on the fast path")

    const control = f.controlledList(f.authoritativePage)
    f.data().session.message.invalidate(sessionId)
    let syncSettled = false
    f.data().session.message.sync(sessionId).then(() => { syncSettled = true }).catch(() => undefined)
    await converge(ctx, () => control.calls === 1 && control.pending())

    // Ten arrivals, each landing before the in-flight read returns: every one
    // restarts the read; it can never publish an obsolete page mid-stream.
    for (let round = 0; round < 10; round++) {
      f.delta(`x${round} `)
      control.settle()
      await converge(ctx, () => control.calls === round + 2 && control.pending())
      assert.ok(control.pending(), "the read restarted and is always in flight")
    }

    // Arrivals stop: the current read can finally return.
    control.settle()
    await converge(ctx, () => syncSettled)
    assert.equal(f.sdkText(), f.authoritativeText())
  } finally { f.cleanup() }
})

test("a pending dropping resync keeps live deltas out until the stream pauses", async ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("reconnect-dropping", true)
  try {
    f.start()
    f.dispatch("session.reasoning.started", live)
    await converge(ctx, () => f.storeText() === "")
    for (const chunk of ["alpha ", "beta "]) {
      f.dispatch("session.reasoning.delta", { ...live, delta: chunk })
    }
    await converge(ctx, () => f.storeText() === "alpha beta ")

    invalidateOpenCodeSessionContent(f.instanceId, sessionId)
    const control = f.controlledList(f.authoritativePage)

    // Continuous arrivals: each resync attempt loses the revision-stability race.
    for (let round = 0; round < 10; round++) {
      f.dispatch("session.reasoning.delta", { ...live, delta: `drop${round} ` })
      control.settle()
      // Retry backoff doubles per failure up to 1s; advance past any schedule.
      ctx.mock.timers.tick(1000)
      await microtasks()
      assert.equal(f.storeText(), "alpha beta ", "store stays frozen while deltas keep arriving")
    }
    assert.ok(control.calls >= 5, `resync kept re-reading (${control.calls} attempts) without ever settling`)

    // Stream pauses: the pending resync settles and republishes the page.
    control.settle()
    for (let index = 0; index < 200 && f.storeText() !== f.authoritativeText(); index++) {
      ctx.mock.timers.tick(1000)
      await microtasks()
      control.settle()
    }
    assert.equal(f.storeText(), f.authoritativeText(), "display catches up only after arrivals stop")
  } finally { f.cleanup() }
})

test("a mid-stream reconnect keeps live deltas displaying and reconciles once quiet", async ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("reconnect-live", true)
  try {
    f.start()
    f.dispatch("session.reasoning.started", live)
    await converge(ctx, () => typeof f.storeText() === "string")
    f.dispatch("session.reasoning.delta", { ...live, delta: "before " })
    await converge(ctx, () => f.storeText() === "before ")

    // A shared-stream reconnect announces itself as server.connected.
    f.dispatch("server.connected")
    // The seeded page lands within the reconnect event's own task; the next
    // native event always arrives in a later task.
    await microtasks()
    const control = f.controlledList(f.authoritativePage)

    // Live deltas after the reconnect must keep updating the display: the last
    // live page seeds the fresh reducer instead of restarting from empty.
    f.dispatch("session.reasoning.delta", { ...live, delta: "after0 " })
    f.dispatch("session.reasoning.delta", { ...live, delta: "after1 " })
    await microtasks()
    ctx.mock.timers.tick(0)
    await microtasks()
    assert.equal(f.storeText(), "before after0 after1 ", "live text keeps streaming across the reconnect")

    // Once the stream stays quiet, one authoritative snapshot reconciles the
    // disconnect window and replaces the seeded page.
    for (let index = 0; index < 200 && f.storeText() !== f.authoritativeText(); index++) {
      ctx.mock.timers.tick(1000)
      await microtasks()
      control.settle()
    }
    assert.equal(f.storeText(), f.authoritativeText(), "the quiet reconnect resync republishes the authoritative page")
  } finally { f.cleanup() }
})
