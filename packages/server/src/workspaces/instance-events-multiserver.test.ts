import assert from "node:assert/strict"
import { test } from "node:test"
import type { LocationRef, OpenCodeEvent } from "@opencode/client"
import { EventBus } from "../events/bus"
import type { WorkspaceEventPayload } from "../api-types"
import type { Logger } from "../logger"
import type { WorkspaceManager } from "./manager"
import { InstanceEventBridge } from "./instance-events"
import { InstanceEventBudget, InstanceEventQueue } from "./instance-event-queue"
import { nativeEventConnections, type ServiceConnection } from "./opencode-service"

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check()) { assert.ok(Date.now() < end, "relay did not settle"); await turn() }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const event = (type: string, data: object = {}, location?: LocationRef) => ({
  id: "same-event", created: Date.now(), type, data, ...(location ? { location } : {}),
}) as OpenCodeEvent

class Feed {
  items: (OpenCodeEvent | Error)[] = []
  wake = deferred<void>()
  closed = false
  send(value: OpenCodeEvent | Error) { this.items.push(value); this.wake.resolve() }
  async *read(signal: AbortSignal) {
    const abort = () => this.wake.resolve()
    signal.addEventListener("abort", abort, { once: true })
    try {
      yield event("server.connected")
      while (!signal.aborted) {
        const item = this.items.shift()
        if (item instanceof Error) throw item
        if (item) yield item
        else { await this.wake.promise; this.wake = deferred<void>() }
      }
    } finally { this.closed = true; signal.removeEventListener("abort", abort) }
  }
}

function harness() {
  const bus = new EventBus()
  const workspaces: any[] = ["local-shared", "A", "B"].map(serverId => ({
    id: serverId, path: "/same", binding: { serverId, directory: "/same" },
  }))
  const frames: WorkspaceEventPayload[] = []
  bus.on("instance.event", value => frames.push(value))
  bus.on("instance.eventStatus", value => frames.push(value))
  const streams = new Map<string, Feed[]>()
  const controllers = new Map<string, AbortController>()
  const connections = new Map<string, ServiceConnection>()
  const sessionReads: string[] = []
  const ownershipRequests: string[] = []
  let observe!: (ids: readonly string[], credentialsChanged?: string) => void
  let admitted: string[] = []
  let localInvalidations = 0
  let nativeGeneration = 40
  let blockA: Promise<boolean> | undefined
  function connection(id: string) {
    let value = connections.get(id)
    if (value) return value
    const controller = new AbortController()
    controllers.set(id, controller)
    value = {
      generation: ++nativeGeneration,
      signal: controller.signal,
      endpoint: { url: `https://${id}.example` },
      assertCurrent: () => controller.signal.throwIfAborted(),
      invalidate() { controller.abort(); connections.delete(id) },
      client: {
        event: { subscribe({ signal }: { signal: AbortSignal }) {
          const feed = new Feed()
          streams.set(id, [...(streams.get(id) ?? []), feed])
          return feed.read(signal)
        } },
        session: { get: async ({ sessionID }: { sessionID: string }) => {
          sessionReads.push(id)
          if (sessionID === "missing") throw Object.assign(new Error("not found"), { _tag: "SessionNotFoundError" })
          return { location: { directory: "/same" } }
        } },
      },
    } as unknown as ServiceConnection
    connections.set(id, value)
    return value
  }
  const manager = {
    list: () => workspaces,
    observeAdmittedEventSources(listener: typeof observe) { observe = listener; listener(admitted); return () => { observe = () => {} } },
    getServerConnections: () => ({ acquireForServer: async (id: string) => {
      assert.ok(admitted.includes(id), "ordinary event work cannot admit a target")
      return connection(id)
    } }),
    subscribeToSharedService: async (signal: AbortSignal) => {
      const captured = connection("local-shared")
      const events = captured.client.event.subscribe({ signal })
      return (async function* () { for await (const item of events) { nativeEventConnections.set(item, captured); yield item } })()
    },
    ownsDirectory: async () => true,
    ownsLocation: async (id: string, location: LocationRef, client: unknown) => {
      ownershipRequests.push(id)
      assert.equal(client, connections.get(id === "A2" ? "A" : id)?.client)
      if (id === "A" && blockA) return blockA
      return location.directory === "/same" && location.workspaceID === undefined
    },
    invalidateWorktrees: () => { localInvalidations++ },
  } as unknown as WorkspaceManager
  const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger: { debug() {}, warn() {} } as unknown as Logger })
  const admit = (...ids: string[]) => { admitted = ids; observe(ids) }
  const business = () => frames.filter((value): value is Extract<WorkspaceEventPayload, { type: "instance.event" }> => value.type === "instance.event" && value.event.type !== "server.connected")
  return { bridge, bus, workspaces, frames, streams, controllers, connections, sessionReads, ownershipRequests, admit, business,
    rotate(id: string) { connections.get(id)?.invalidate(); observe(admitted, id) },
    blockA(value: Promise<boolean>) { blockA = value }, localInvalidations: () => localInvalidations,
  }
}

test("local/A/B identical IDs, globals, missing locations and deletions stay on their captured source", async t => {
  const h = harness(); t.after(() => h.bridge.shutdown())
  h.admit("A", "B")
  h.bus.publish({ type: "workspace.started", workspace: h.workspaces[0] })
  await until(() => h.streams.size === 3)
  for (const id of ["A", "B", "local-shared"]) {
    h.streams.get(id)![0].send(event("session.text.delta", { sessionID: "same-session", delta: id }))
    h.streams.get(id)![0].send(event("model.updated"))
    h.streams.get(id)![0].send(event("session.deleted", { sessionID: "same-session" }))
  }
  await until(() => h.business().length === 9)
  assert.deepEqual(h.sessionReads.sort(), ["A", "B", "local-shared"].sort())
  for (const frame of h.business()) {
    assert.equal(frame.instanceId, frame.source!.serverId)
    assert.ok(frame.source!.generation > 0)
    assert.ok(nativeEventConnections.get(frame.event), "native attribution survives marker copies and delivery")
  }
  h.streams.get("A")![0].send(event("worktree.updated"))
  await until(() => h.business().length === 10)
  assert.equal(h.localInvalidations(), 0)
})

test("one admitted stream serves two occurrences, late attach receives current marker; release cancels without reacquisition", async t => {
  const h = harness(); t.after(() => h.bridge.shutdown())
  h.admit("A")
  await until(() => h.streams.get("A")?.length === 1)
  await turn()
  h.workspaces.push({ id: "A2", path: "/same", binding: { serverId: "A", directory: "/same" } })
  h.bus.publish({ type: "workspace.started", workspace: h.workspaces.at(-1)! })
  await until(() => h.frames.some(value => value.type === "instance.event" && value.instanceId === "A2" && value.event.type === "server.connected"))
  assert.equal(h.streams.get("A")!.length, 1)
  const feed = h.streams.get("A")![0]
  h.admit()
  await until(() => feed.closed)
  feed.send(event("model.updated"))
  h.bus.publish({ type: "workspace.started", workspace: h.workspaces.at(-1)! })
  await turn()
  assert.equal(h.streams.get("A")!.length, 1)
  assert.equal(h.business().length, 0)
})

test("global Forms retain source-bound full Location; unknown deletion produces only that source's bounded gap", async t => {
  const h = harness(); t.after(() => h.bridge.shutdown())
  h.admit("A", "B")
  await until(() => h.streams.size === 2)
  for (const id of ["A", "B"]) {
    h.streams.get(id)![0].send(event("form.created", { form: { id: "same-form", sessionID: "global" } }, { directory: "/same" }))
    h.streams.get(id)![0].send(event("form.cancelled", { id: "same-form", sessionID: "global" }))
  }
  await until(() => h.business().length === 4)
  assert.equal(h.sessionReads.length, 0)
  for (const frame of h.business()) assert.equal(frame.instanceId, frame.source!.serverId)
  for (let i = 0; i < 30; i++) h.streams.get("A")![0].send(event("session.deleted", { sessionID: "missing" }))
  await until(() => h.frames.some(value => value.type === "instance.eventStatus" && value.gap === "ownership"))
  await turn()
  const gaps = h.frames.filter(value => value.type === "instance.eventStatus" && value.gap === "ownership")
  assert.equal(gaps.length, 1)
  assert.equal((gaps[0] as any).source.serverId, "A")
  assert.equal(h.business().some(value => value.event.type === "session.deleted"), false)
})

test("blocked and flooded A cannot starve B or local; overflow is attributed only to A", async t => {
  const h = harness(), blocked = deferred<boolean>()
  t.after(() => { h.bridge.shutdown(); blocked.resolve(false) })
  h.blockA(blocked.promise)
  h.admit("A", "B")
  h.bus.publish({ type: "workspace.started", workspace: h.workspaces[0] })
  await until(() => h.streams.size === 3)
  for (let i = 0; i < 600; i++) h.streams.get("A")![0].send(event("session.text.delta", { sessionID: "same-session", delta: "a" }, { directory: "/same" }))
  for (const id of ["B", "local-shared"]) h.streams.get(id)![0].send(event("model.updated"))
  await until(() => h.business().some(value => value.instanceId === "B") && h.business().some(value => value.instanceId === "local-shared"))
  await until(() => h.frames.some(value => value.type === "instance.eventStatus" && value.gap === "overflow"))
  assert.ok(h.frames.filter(value => value.type === "instance.eventStatus" && value.gap === "overflow").every(value => value.type === "instance.eventStatus" && value.source?.serverId === "A"))
  assert.equal(h.business().some(value => value.instanceId === "A"), false)
})

test("credential revocation cancels the iterator and stale deliveries; retry keeps the admitted slot and advances only its source", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const h = harness(), blocked = deferred<boolean>()
  t.after(() => { h.bridge.shutdown(); blocked.resolve(false) })
  h.admit("A", "B")
  await until(() => h.streams.size === 2)
  await turn()
  h.blockA(blocked.promise)
  const before = h.frames.find(value => value.type === "instance.eventStatus" && value.instanceId === "A" && value.status === "connected")!
  h.streams.get("A")![0].send(event("session.text.delta", { sessionID: "same-session", delta: "old" }, { directory: "/same" }))
  await turn()
  h.connections.get("A")!.invalidate()
  await until(() => h.streams.get("A")![0].closed)
  await turn()
  t.mock.timers.tick(2000)
  await until(() => h.streams.get("A")!.length === 2)
  blocked.resolve(true)
  await turn()
  assert.equal(h.business().length, 0)
  h.streams.get("A")![1].send(event("model.updated"))
  await until(() => h.business().length === 1)
  assert.ok(h.business()[0].source!.generation > (before as any).source.generation)
  assert.equal(h.streams.get("B")!.length, 1)
  const markers = h.frames.filter((value): value is Extract<WorkspaceEventPayload, { type: "instance.event" }> => value.type === "instance.event" && value.instanceId === "A" && value.event.type === "server.connected")
  assert.notEqual((markers[0].event.data as any).daemon, (markers.at(-1)!.event.data as any).daemon,
    "an explicit attempt cannot claim verified daemon continuity")
})

test("credential rotation interrupts an offline retry timer immediately without a new admission", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const h = harness(); t.after(() => h.bridge.shutdown())
  h.admit("A")
  await until(() => h.streams.get("A")?.length === 1)
  h.streams.get("A")![0].send(new Error("offline"))
  await until(() => h.frames.some(value => value.type === "instance.eventStatus" && value.gap === "transport"))
  h.rotate("A")
  await until(() => h.streams.get("A")!.length === 2)
})

test("fixed shares include active work, preserve admitted local work during transition and release counters exactly once", async () => {
  const budget = new InstanceEventBudget(), blocked = deferred<void>()
  let failures = 0
  const local = new InstanceEventQueue(() => { failures++ }, undefined, budget)
  for (let i = 0; i < 1800; i++) local.enqueue("same", 1, () => blocked.promise)
  assert.equal(budget.jobs, 1800)
  budget.explicitSources = 1
  const a = new InstanceEventQueue(() => { failures++ }, undefined, budget, true)
  for (let i = 0; i < 249; i++) a.enqueue("same", 1, () => blocked.promise)
  assert.equal(failures, 1)
  assert.equal(local.pending, 1800, "activation cannot cancel previously admitted local jobs")
  assert.equal(budget.jobs, 1800)
  a.close(); local.close(); local.close()
  blocked.resolve()
  await turn()
  assert.equal(budget.jobs, 0)
  assert.equal(budget.bytes, 0)
})

test("delivery deadline uses ingestion time rather than restarting after resolution", async () => {
  let error: Error | undefined, ran = false
  const queue = new InstanceEventQueue(value => { error = value }, { jobs: 10, bytes: 100, timeoutMs: 10 })
  queue.enqueue("delivery", 1, async () => { ran = true }, Date.now() - 11)
  assert.match(error?.message ?? "", /timed out/)
  assert.equal(ran, false)
  assert.equal(queue.pending, 0)
})

test("four fixed shares plus the local reserve exhaust exactly the aggregate jobs and byte ceilings", async () => {
  for (const bytes of [false, true]) {
    const budget = new InstanceEventBudget(), blocked = deferred<void>()
    budget.explicitSources = 4
    const queues = Array.from({ length: 5 }, (_, i) => new InstanceEventQueue(() => {}, undefined, budget, i !== 0))
    for (let i = 0; i < queues.length; i++) {
      const jobs = bytes ? 1 : i === 0 ? 256 : 448
      const size = bytes ? (i === 0 ? 4 : 7) * 1024 * 1024 : 1
      for (let j = 0; j < jobs; j++) queues[i].enqueue("blocked", size, () => blocked.promise)
    }
    assert.equal(bytes ? budget.bytes : budget.jobs, bytes ? 32 * 1024 * 1024 : 2048)
    queues[1].enqueue("overflow", 1, async () => {})
    assert.equal(queues[1].pending, 0)
    assert.equal(queues[2].pending, bytes ? 1 : 448)
    for (const queue of queues) queue.close()
    blocked.resolve()
    await turn()
    assert.equal(budget.bytes, 0)
    assert.equal(budget.jobs, 0)
  }
})

test("share activation refuses new local work but drains grandfathered resolution and prepaid delivery before reconnect", async () => {
  const budget = new InstanceEventBudget(), resolve = deferred<void>()
  let failed = 0, gap = 0, delivered = 0, newWork = false
  const queue = new InstanceEventQueue(() => { failed++ }, undefined, budget, false, () => { gap++ })
  const deliveries = new Map(Array.from({ length: 300 }, (_, index) => [String(index), 1]))
  queue.enqueue("resolve", 1, async reservation => {
    await resolve.promise
    for (let index = 0; index < 300; index++) queue.enqueueDelivery(String(index), reservation, String(index), async () => { delivered++ }, Date.now())
  }, Date.now(), deliveries)
  assert.equal(budget.jobs, 301)
  budget.explicitSources = 1
  queue.enqueue("new", 1, async () => { newWork = true })
  assert.equal(failed, 0)
  assert.equal(gap, 1)
  assert.equal(queue.pending, 301)
  resolve.resolve()
  await until(() => failed === 1)
  assert.equal(delivered, 300)
  assert.equal(newWork, false)
  assert.equal(budget.jobs, 0)
  assert.equal(budget.bytes, 0)
})

test("healthy long-lived ingestion does not accumulate reactions on one pending cancellation promise", async t => {
  const h = harness(); t.after(() => h.bridge.shutdown())
  const original = Promise.prototype.then
  const reactions = new WeakMap<object, number>()
  let largest = 0
  t.mock.method(Promise.prototype, "then", function (this: Promise<unknown>, yes: any, no: any) {
    const count = (reactions.get(this) ?? 0) + 1
    reactions.set(this, count)
    largest = Math.max(largest, count)
    return original.call(this, yes, no)
  })
  h.admit("A")
  await until(() => h.streams.get("A")?.length === 1)
  for (let index = 0; index < 1000; index++) h.streams.get("A")![0].send(event("model.updated"))
  await until(() => h.business().length === 1000)
  assert.ok(largest <= 16, `one promise retained ${largest} reactions`)
})

test("ownership waits retain ingestion-time live boundaries across a same-attempt gap", async t => {
  const h = harness(), held = deferred<boolean>()
  t.after(() => { held.resolve(true); h.bridge.shutdown() })
  h.blockA(held.promise); h.admit("A")
  await until(() => h.frames.some(frame => frame.type === "instance.eventStatus" && frame.status === "connected" && frame.instanceId === "A"))
  const before = h.frames.find((frame: any) => frame.type === "instance.eventStatus" && frame.status === "connected" && frame.instanceId === "A") as any
  const feed = h.streams.get("A")![0]
  feed.send(event("form.created", { form: { id: "held-before", sessionID: "global" } }, { directory: "/same" }))
  await until(() => h.ownershipRequests.includes("A"))
  feed.send(event("session.deleted", { sessionID: "missing" }))
  await until(() => h.frames.some(frame => frame.type === "instance.eventStatus" && frame.gap === "ownership"))
  const after = h.frames.filter((frame: any) => frame.type === "instance.eventStatus" && frame.status === "connected" && frame.instanceId === "A").at(-1) as any
  assert.equal(after.source.generation, before.source.generation)
  assert.equal(after.source.connectionGeneration, before.source.connectionGeneration)
  assert(after.liveGeneration > before.liveGeneration)
  feed.send(event("form.created", { form: { id: "held-after", sessionID: "global" } }, { directory: "/same" }))
  // Let ingestion capture the second event while ownership remains held.
  await turn(); await turn()
  held.resolve(true)
  await until(() => h.business().filter(frame => frame.event.type === "form.created").length === 2)
  const forms = h.business().filter(frame => frame.event.type === "form.created")
  assert.equal(forms[0].liveGeneration, before.liveGeneration)
  assert.equal(forms[1].liveGeneration, after.liveGeneration)
  assert.equal(forms[0].source!.connectionGeneration, (h.connections.get("A") as any).generation)
})
