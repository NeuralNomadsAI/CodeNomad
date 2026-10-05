import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { Schema } from "effect"
import { EventManifest } from "@opencode/schema/event-manifest"
import type { OpenCodeEvent } from "@opencode/client"
import { sdkManager } from "../lib/sdk-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import {
  applyOpenCodeDataEvent, destroyOpenCodeData, finishOpenCodeDataEvent,
  invalidateOpenCodeSessionContent, projectOpenCodeMessages,
  type OpenCodeDataEventAdmission,
} from "./opencode-data.ts"
import { setActiveSession, setSessions } from "./session-state.ts"

const sessionId = "ses_replay"
const model = { providerID: "fixture", id: "fixture" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
type Data = ReturnType<typeof applyOpenCodeDataEvent>
type Publication = NonNullable<OpenCodeDataEventAdmission["publication"]>

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

function fixture(instanceId: string, dispatcher = false) {
  const make = eventFactory()
  const nativeSession = {
    id: sessionId, title: "Replay", projectID: "prj_fixture", location: { directory: "/fixture" },
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
  // A tiny completed page is sufficient; no artificial multi-MiB payload.
  for (let index = 0; index < 200; index++) {
    const assistantMessageID = `msg_${String(index).padStart(3, "0")}`
    apply("session.step.started", { assistantMessageID, agent: "build", model, started: index })
    apply("session.step.ended", { assistantMessageID, finish: "stop", cost: 0, tokens })
  }
  projectOpenCodeMessages(instanceId, sessionId, data)
  if (dispatcher) {
    addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
      ...nativeSession, instanceId, parentId: null, status: "working", agent: "build",
      model: { providerId: "fixture", modelId: "fixture" },
    } as any]])))
    setActiveSession(instanceId, sessionId)
  }
  return {
    instanceId, make, apply, client, store, data: () => data,
    dispatch: (type: string, payload: Record<string, unknown> = {}) => handleInstanceInvalidation(instanceId, make(type, payload)),
    start: (publication?: Publication, callback?: (data: Data) => void) => apply("session.step.started", {
      assistantMessageID: "msg_live", agent: "build", model, started: 500,
    }, callback, publication),
    text: () => (data.session.message.get(sessionId, "msg_live") as any)?.content.find((part: any) => part.type === "text")?.text ?? "",
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

async function finish(ctx: TestContext, done: () => boolean) {
  for (let index = 0; index < 500 && !done(); index++) {
    ctx.mock.timers.tick(0)
    await microtasks()
  }
  assert.ok(done(), "replay did not converge through bounded task turns")
}

// Model a few milliseconds of synchronous native work deterministically. This
// measures cooperative admission, not a flaky host wall-clock threshold.
function costClock(ctx: TestContext, data: Data) {
  let clock = 0
  ctx.mock.method(performance, "now", () => clock)
  const list = data.session.message.list.bind(data.session.message)
  ctx.mock.method(data.session.message, "list", (...args: Parameters<typeof list>) => {
    clock += 3
    return list(...args)
  })
}

test("real dispatcher skips queued ingress hydration and publishes bounded chunks before an input timer", async ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("replay-dispatch", true)
  const hydration = ctx.mock.method(f.store, "hydrateMessages")
  costClock(ctx, f.data())
  const base = { assistantMessageID: "msg_live", ordinal: 0 }
  let inputText = ""
  try {
    setTimeout(() => { inputText = f.text() }, 0)
    f.dispatch("session.step.started", { ...base, agent: "build", model, started: 500 })
    f.dispatch("session.text.started", base)
    for (let index = 0; index < 120; index++) f.dispatch("session.text.delta", { ...base, delta: "x" })
    assert.equal(hydration.mock.callCount(), 0, "queued-but-unreduced native data must not hydrate the page")
    await microtasks()
    ctx.mock.timers.tick(0)
    assert.ok(inputText.length > 0 && inputText.length < 120, "a timer must run while native replay still has pending events")
    await microtasks()
    await finish(ctx, () => f.text().length === 120)
    assert.ok(hydration.mock.callCount() < 60, "publish chunks, not 122 whole-page projections")
    assert.equal((f.store.getMessage("msg_live")?.parts["msg_live-text-0"]?.data as any)?.text, "x".repeat(120))
  } finally { f.cleanup() }
})

test("time budget wins before the count backstop; legacy callbacks remain ordered and distinct", async ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("replay-callbacks")
  costClock(ctx, f.data())
  const base = { assistantMessageID: "msg_live", ordinal: 0 }
  const observed: string[] = []
  const publicationSizes: number[] = []
  const publication: Publication = ({ events }) => { publicationSizes.push(events.length) }
  try {
    f.start(publication)
    f.apply("session.text.started", base, undefined, publication)
    for (let index = 0; index < 20; index++) f.apply("session.text.delta", { ...base, delta: "x" }, undefined, publication)
    const callback = () => observed.push(f.text())
    f.apply("session.text.delta", { ...base, delta: "A" }, callback)
    f.apply("session.text.delta", { ...base, delta: "B" }, callback)
    f.apply("session.text.delta", { ...base, delta: "C" }, () => observed.push(`distinct:${f.text()}`))
    await microtasks()
    await finish(ctx, () => observed.length === 3)
    assert.ok(publicationSizes.length > 2)
    assert.ok(publicationSizes.every(size => size < 64), "time budget must split even a sub-64-event burst")
    assert.deepEqual(observed, ["x".repeat(20) + "A", "x".repeat(20) + "AB", "distinct:" + "x".repeat(20) + "ABC"])
  } finally { f.cleanup() }
})

test("legacy replay lets a macrotask observer run while the production queue is not empty", async ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("replay-legacy-macrotask")
  costClock(ctx, f.data())
  let applied = 0, observed = -1
  const callback = () => { applied++ }
  const base = { assistantMessageID: "msg_live", ordinal: 0 }
  try {
    setTimeout(() => { observed = applied }, 0)
    f.start(undefined, callback)
    f.apply("session.text.started", base, callback)
    for (let index = 0; index < 120; index++) f.apply("session.text.delta", { ...base, delta: "x" }, callback)
    await microtasks()
    ctx.mock.timers.tick(0)
    assert.ok(observed > 0 && observed < 122, "input observer must run before all 122 reductions/callbacks finish")
    await microtasks()
    await finish(ctx, () => applied === 122)
    assert.equal(f.text(), "x".repeat(120))
  } finally { f.cleanup() }
})

test("admission metadata keeps synchronous data consumption and buffered compaction outcomes stable", ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const instanceId = "replay-admission-contract"
  const make = eventFactory()
  let publications = 0
  const admission: OpenCodeDataEventAdmission = { deferred: false, publication: () => { publications++ } }
  try {
    const data = applyOpenCodeDataEvent(instanceId, "/fixture", make("session.compaction.started", {
      inputID: "msg_compact", reason: "manual", recent: "",
    }), undefined, undefined, false, admission)
    assert.equal(admission.deferred, false)
    assert.ok(data.session.message.get(sessionId, "msg_compact"), "ordinary calls still return their reduced data synchronously")
    applyOpenCodeDataEvent(instanceId, "/fixture", make("session.compaction.delta", { text: "summary" }), undefined, undefined, false, admission)
    assert.equal(admission.deferred, true)
    assert.equal((data.session.message.get(sessionId, "msg_compact") as any).summary, "")
    ctx.mock.timers.tick(250)
    assert.equal((data.session.message.get(sessionId, "msg_compact") as any).summary, "summary")
    assert.equal(publications, 1)
    assert.equal(admission.deferred, true, "a later flush cannot rewrite the original synchronous admission result")
  } finally { destroyOpenCodeData(instanceId); sdkManager.destroyClientsForInstance(instanceId) }
})

test("FIFO replay retains tool/text/compaction/inbox state across task turns and final idle publication", async ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("replay-mixed")
  costClock(ctx, f.data())
  const base = { assistantMessageID: "msg_live", ordinal: 0 }
  let published = 0
  const publication: Publication = ({ data }) => { published++; projectOpenCodeMessages(f.instanceId, sessionId, data) }
  try {
    f.start(publication)
    f.apply("session.text.started", base, undefined, publication)
    f.apply("session.tool.input.started", { ...base, id: "tool", name: "read" }, undefined, publication)
    f.apply("session.tool.input.delta", { ...base, id: "tool", delta: "{\"path\":\"a\"}" }, undefined, publication)
    f.apply("session.tool.called", { ...base, id: "tool", input: { path: "a" }, executed: false }, undefined, publication)
    f.apply("session.compaction.started", { inputID: "msg_compact", reason: "manual", recent: "" }, undefined, publication)
    f.apply("session.compaction.delta", { text: "summary A" }, undefined, publication)
    f.apply("session.compaction.delta", { text: " + B" }, undefined, publication)
    f.apply("session.text.delta", { ...base, delta: "first" }, undefined, publication)
    f.apply("session.retry.scheduled", { ...base, attempt: 1, at: 1000, error: { type: "fixture", message: "retry" } }, undefined, publication)
    f.apply("session.inbox.enqueued", { inboxID: "msg_pending", item: { type: "user", payload: { text: "queued" }, delivery: "queue" } }, undefined, publication)
    f.apply("session.text.delta", { ...base, delta: " second" }, undefined, publication)
    f.apply("session.tool.success", { ...base, id: "tool", content: [{ type: "text", text: "ok" }], metadata: {}, executed: false }, undefined, publication)
    f.apply("session.compaction.delta", { text: "obsolete buffered fragment" }, undefined, publication)
    f.apply("session.compaction.ended", { reason: "manual", model, text: "summary final", recent: "", cost: 0, tokens }, undefined, publication)
    f.apply("session.step.ended", { ...base, finish: "stop", cost: 0, tokens }, undefined, publication)
    const idle = f.make("session.idle")
    applyOpenCodeDataEvent(f.instanceId, "/fixture", idle, undefined, undefined, false, { deferred: false, publication })
    finishOpenCodeDataEvent(f.instanceId, idle)
    await microtasks()
    await finish(ctx, () => Boolean((f.data().session.message.get(sessionId, "msg_live") as any)?.time.completed))
    // One trailing task may contain idle itself; run it before testing retirement.
    ctx.mock.timers.tick(0); await microtasks()
    assert.equal(f.text(), "first second")
    const parts = (f.data().session.message.get(sessionId, "msg_live") as any).content
    assert.equal(parts.find((part: any) => part.type === "tool").state.status, "completed")
    assert.equal((f.data().session.message.get(sessionId, "msg_compact") as any).summary, "summary final")
    assert.equal((f.data().session.message.get(sessionId, "msg_compact") as any).status, "completed")
    assert.equal(f.data().session.pending.list(sessionId)[0]?.id, "msg_pending")
    assert.ok(published > 1)
    const old = f.data()
    f.apply("session.execution.started")
    assert.notStrictEqual(f.data(), old, "idle retires only after its final queued publication")
  } finally { f.cleanup() }
})

for (const mutation of ["cancel", "revert"] as const) {
  test(`dispatcher ${mutation} is a reduction barrier, not a delayed removal of a later same-ID row`, async ctx => {
    ctx.mock.timers.enable({ apis: ["setTimeout"] })
    const f = fixture(`replay-dispatch-${mutation}`, true)
    costClock(ctx, f.data())
    const base = { assistantMessageID: "msg_live", ordinal: 0 }
    try {
      f.dispatch("session.step.started", { ...base, agent: "build", model, started: 500 })
      f.dispatch("session.text.started", base)
      f.dispatch("session.text.delta", { ...base, delta: "old" })
      if (mutation === "cancel") f.dispatch("session.inbox.cancelled", { inboxID: "msg_live" })
      else f.dispatch("session.revert.committed", { to: "msg_live" })
      f.dispatch("session.step.started", { ...base, agent: "build", model, started: 600 })
      f.dispatch("session.text.started", base)
      f.dispatch("session.text.delta", { ...base, delta: "new" })
      await microtasks()
      await finish(ctx, () => (f.store.getMessage("msg_live")?.parts["msg_live-text-0"]?.data as any)?.text === "new")
      assert.equal(f.text(), "new")
    } finally { f.cleanup() }
  })
}

for (const boundary of ["instance-dispose", "session-dispose", "delete", "reset", "invalidate"] as const) {
  test(`no stale replay publication after ${boundary} during a task yield`, async ctx => {
    ctx.mock.timers.enable({ apis: ["setTimeout"] })
    const f = fixture(`replay-fence-${boundary}`)
    costClock(ctx, f.data())
    let publications = 0, before = -1
    const publication: Publication = () => { publications++ }
    try {
      setTimeout(() => {
        before = publications
        if (boundary === "instance-dispose") destroyOpenCodeData(f.instanceId)
        if (boundary === "session-dispose") destroyOpenCodeData(f.instanceId, sessionId)
        if (boundary === "delete") f.apply("session.deleted")
        if (boundary === "reset") f.apply("server.connected")
        if (boundary === "invalidate") invalidateOpenCodeSessionContent(f.instanceId, sessionId)
      }, 0)
      f.start(publication)
      f.apply("session.text.started", { assistantMessageID: "msg_live", ordinal: 0 }, undefined, publication)
      for (let index = 0; index < 120; index++) f.apply("session.text.delta", { assistantMessageID: "msg_live", ordinal: 0, delta: "x" }, undefined, publication)
      await microtasks()
      assert.ok(publications > 0)
      for (let index = 0; index < 5; index++) { ctx.mock.timers.tick(0); await microtasks() }
      assert.equal(publications, before)
    } finally { f.cleanup() }
  })
}

test("publication-triggered invalidation fences remaining callbacks in the same drain", async ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("replay-publication-fence")
  let first = 0, stale = 0
  try {
    f.start(undefined, () => { first++; invalidateOpenCodeSessionContent(f.instanceId, sessionId) })
    f.apply("session.text.started", { assistantMessageID: "msg_live", ordinal: 0 }, () => { stale++ })
    await microtasks()
    ctx.mock.timers.tick(0); await microtasks()
    assert.equal(first, 1)
    assert.equal(stale, 0)
  } finally { f.cleanup() }
})

test("chunk-publication invalidation fences a distinct following publication", async ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("replay-chunk-publication-fence")
  let first = 0, stale = 0
  const publication: Publication = () => { first++; destroyOpenCodeData(f.instanceId) }
  try {
    f.start(publication)
    f.apply("session.text.started", { assistantMessageID: "msg_live", ordinal: 0 }, undefined, () => { stale++ })
    await microtasks()
    ctx.mock.timers.tick(0); await microtasks()
    assert.equal(first, 1)
    assert.equal(stale, 0)
  } finally { f.cleanup() }
})

test("arrivals during yield can overflow-collapse without a stale callback or replaying the authoritative page", async ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("replay-yield-overflow")
  costClock(ctx, f.data())
  let publications = 0, before = 0, resynced: Data | undefined
  const publication: Publication = () => { publications++ }
  f.client.message.list = async () => ({ data: [{
    id: "msg_authority", type: "assistant", agent: "build", model, content: [{ type: "text", text: "native" }],
    time: { created: 9000, completed: 9001 },
  }], cursor: {} })
  try {
    setTimeout(() => {
      before = publications
      for (let index = 0; index < 4096; index++) f.apply("session.text.delta", {
        assistantMessageID: "msg_live", ordinal: 0, delta: "obsolete",
      }, undefined, publication, next => { resynced = next })
    }, 0)
    f.start(publication)
    f.apply("session.text.started", { assistantMessageID: "msg_live", ordinal: 0 }, undefined, publication)
    for (let index = 0; index < 120; index++) f.apply("session.text.delta", { assistantMessageID: "msg_live", ordinal: 0, delta: "x" }, undefined, publication)
    await microtasks()
    ctx.mock.timers.tick(0); await microtasks()
    assert.equal(publications, before)
    ctx.mock.timers.tick(25); await microtasks()
    assert.ok(resynced)
    assert.equal(publications, before)
    assert.equal((resynced.session.message.get(sessionId, "msg_authority") as any).content[0].text, "native")
  } finally { f.cleanup() }
})

test("new arrivals stay FIFO through additional bounded snapshot rotations", async ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("replay-new-arrivals")
  costClock(ctx, f.data())
  let arrived = false, lastPublished = ""
  const publication: Publication = ({ data }) => { lastPublished = data.session.message.list(sessionId).at(-1)?.id ?? "" }
  try {
    setTimeout(() => {
      arrived = true
      for (let index = 70; index < 140; index++) f.apply("session.step.started", {
        assistantMessageID: `msg_next_${String(index).padStart(3, "0")}`, agent: "build", model, started: 1000 + index,
      }, undefined, publication)
    }, 0)
    for (let index = 0; index < 70; index++) f.apply("session.step.started", {
      assistantMessageID: `msg_next_${String(index).padStart(3, "0")}`, agent: "build", model, started: 1000 + index,
    }, undefined, publication)
    await microtasks()
    await finish(ctx, () => lastPublished === "msg_next_139")
    assert.ok(arrived)
    const messages = f.data().session.message.list(sessionId)
    assert.ok(messages.length <= 200)
    assert.equal(new Set(messages.map(message => message.id)).size, messages.length)
    const retained = messages.filter(message => message.id.startsWith("msg_next_"))
    assert.deepEqual(retained.map(message => message.id), [...retained.map(message => message.id)].sort())
  } finally { f.cleanup() }
})
