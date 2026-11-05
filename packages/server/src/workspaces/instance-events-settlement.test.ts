import assert from "node:assert/strict"
import { test } from "node:test"
import { EventBus } from "../events/bus"
import { InstanceEventBridge } from "./instance-events"
import { InstanceEventQueue } from "./instance-event-queue"

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await turn()
  assert(check(), "memory relay did not settle")
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function harness(t: any) {
  const held = deferred<any>(), bus = new EventBus(), frames: any[] = []
  bus.onEvent(frame => frames.push(JSON.parse(JSON.stringify(frame))))
  const controller = new AbortController(), items: any[] = []
  let wake: (() => void) | undefined, reads = 0, forbidden = 0
  const workspace = { id: "same-occurrence", path: "/opaque", binding: { serverId: "A", directory: "/opaque" } }
  let workspaces = [workspace]
  const connection = {
    generation: 42, signal: controller.signal, endpoint: { url: "http://memory.invalid" },
    assertCurrent() { controller.signal.throwIfAborted() },
    invalidate() { throw new Error("unexpected invalidation") },
    client: { event: { subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
      yield { type: "server.connected", data: {} }
      while (!signal.aborted) {
        if (items.length) yield items.shift()
        else await new Promise<void>(resolve => {
          const done = () => { signal.removeEventListener("abort", done); resolve() }
          wake = done
          if (signal.aborted) done()
          else signal.addEventListener("abort", done, { once: true })
        })
      }
    })() }, session: { get: () => { reads++; return held.promise } } },
  }
  const bridge = new InstanceEventBridge({ eventBus: bus, logger: { debug() {}, warn() {} } as any,
    workspaceManager: {
      list: () => workspaces,
      observeAdmittedEventSources(listener: any) { listener(["A"]); return () => {} },
      getServerConnections: () => ({ acquireForServer: async () => connection }),
      ownsLocation: async () => true,
      subscribeToSharedService() { forbidden++; throw new Error("local access forbidden") },
    } as any,
  })
  t.after(() => { bridge.shutdown(); controller.abort(); wake?.(); assert.equal(forbidden, 0) })
  return { bus, frames, held, reads: () => reads,
    emit(value: any) { items.push(value); wake?.() },
    reopen() {
      workspaces = []
      bus.publish({ type: "workspace.stopped", workspaceId: workspace.id, reason: "deleted" })
      workspaces = [workspace]
      bus.publish({ type: "workspace.started", workspace } as any)
    },
  }
}

test("connected marker prepays its exact decorated serialized delivery envelope", async t => {
  const jobs: any[] = [], original = InstanceEventQueue.prototype.enqueue
  t.mock.method(InstanceEventQueue.prototype, "enqueue", function (this: InstanceEventQueue, ...args: Parameters<typeof original>) {
    jobs.push({ bytes: args[1], deliveries: [...(args[4] ?? [])] })
    return original.apply(this, args)
  })
  const h = harness(t)
  await until(() => h.frames.some(frame => frame.type === "instance.event"))
  const marker = h.frames.find(frame => frame.type === "instance.event")
  assert.equal(marker.source.connectionGeneration, 42)
  assert.equal(typeof marker.event.data.daemon, "string")
  assert.equal(jobs[0].deliveries[0][1], Buffer.byteLength(JSON.stringify(marker)))
  assert.equal(jobs[0].bytes, Buffer.byteLength(JSON.stringify(marker.event)))
})

test("retired placement lookup cannot pulse a reopened same-ID occurrence; current lookup still pulses", async t => {
  const h = harness(t)
  await until(() => h.frames.some(frame => frame.type === "instance.event"))
  h.emit({ type: "session.deleted", data: { sessionID: "old-unresolved" } })
  await until(() => h.reads() === 1)
  h.reopen()
  h.emit({ type: "form.created", location: { directory: "/opaque" }, data: { form: { id: "new-live-request", sessionID: "global" } } })
  await until(() => h.frames.some(frame => frame.type === "instance.event" && frame.event.type === "form.created"))
  const before = h.frames.length
  h.held.reject(Object.assign(new Error("synthetic missing session"), { _tag: "SessionNotFoundError" }))
  await turn(); await turn()
  assert.equal(h.frames.slice(before).filter(frame => frame.gap === "ownership").length, 0)
  assert.equal(h.frames.length, before)
  h.emit({ type: "session.deleted", data: { sessionID: "current-unresolved" } })
  await until(() => h.frames.slice(before).some(frame => frame.gap === "ownership"))
  const pulse = h.frames.slice(before)
  assert.deepEqual(pulse.map(frame => frame.status), ["error", "connected"])
  assert.equal(pulse[0].source.generation, pulse[1].source.generation)
  assert.equal(h.reads(), 2)
})

test("delayed resolution transfers original ingestion deadline into enqueueDelivery", async t => {
  const originalNow = Date.now, receivedAt = originalNow(), held = deferred<void>()
  let now = receivedAt, failure: Error | undefined, delivered = false
  t.mock.method(Date, "now", () => now)
  const queue = new InstanceEventQueue(error => { failure = error }, { jobs: 10, bytes: 100, timeoutMs: 10 })
  t.after(() => queue.close())
  queue.enqueue("resolve", 1, async reservation => {
    await held.promise
    queue.enqueueDelivery("delivery", reservation, "A", async () => { delivered = true }, receivedAt)
  }, receivedAt, new Map([["A", 1]]))
  now += 11
  held.resolve()
  await turn()
  assert.match(failure?.message ?? "", /timed out/)
  assert.equal(delivered, false)
  assert.equal(queue.pending, 0)
})

test("invalid acquired native generations fail before subscribe", async () => {
  for (const generation of [undefined, 0, -1, 1.5, NaN, "42", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const bus = new EventBus(), frames: any[] = []
    bus.onEvent(frame => frames.push(frame))
    let subscribed = 0
    const bridge = new InstanceEventBridge({ eventBus: bus, logger: { debug() {}, warn() {} } as any,
      workspaceManager: {
        list: () => [{ id: "guard", binding: { serverId: "A", directory: "/opaque" } }],
        observeAdmittedEventSources(listener: any) { listener(["A"]); return () => {} },
        getServerConnections: () => ({ acquireForServer: async () => ({ generation,
          client: { event: { subscribe() { subscribed++; throw new Error("forbidden") } } } }) }),
      } as any,
    })
    try {
      await until(() => frames.some(frame => frame.status === "error"))
      assert.equal(subscribed, 0)
      assert.equal(frames.some(frame => frame.type === "instance.event" || frame.status === "connected"), false)
    } finally { bridge.shutdown() }
  }
})

test("bus rejects older live boundaries and same-boundary contradictions before replay and stop purge", () => {
  const bus = new EventBus(), frames: any[] = []
  const status = (liveGeneration: number, state = "connected", connectionGeneration = 42) => ({
    type: "instance.eventStatus", instanceId: "held", status: state, generation: 3,
    source: { serverId: "A", generation: 3, connectionGeneration }, liveGeneration,
  })
  for (const frame of [status(70), status(71, "error"), status(72), status(70), status(72, "error"), status(72, "connected", 43)]) bus.publish(frame as any)
  bus.onEvent(frame => frames.push(frame))()
  assert.deepEqual(frames, [status(72)])
  bus.publish({ type: "workspace.stopped", workspaceId: "held", reason: "deleted" })
  const retired: any[] = []
  bus.onEvent(frame => retired.push(frame))()
  assert.deepEqual(retired, [])
})
