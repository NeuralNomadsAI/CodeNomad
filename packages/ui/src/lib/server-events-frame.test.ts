import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { BackendEvents } from "./backend-events"
import { ServerEvents } from "./server-events"
import type { ServerApi } from "./api-client"
import type { WorkspaceEventPayload } from "../../../server/src/api-types"

function native(id: string, type = "session.text.delta"): WorkspaceEventPayload {
  return { type: "instance.event", instanceId: "fixture", event: {
    id, type, created: 1, location: { directory: "/work" }, data: { sessionID: "session" },
  } } as WorkspaceEventPayload
}

async function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const document = { hidden: false }
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  for (const [name, value] of Object.entries({
    window: new EventTarget(), document,
    requestAnimationFrame: (callback: FrameRequestCallback) => (frames.set(++frameId, callback), frameId),
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
  async function open() {
    const sources: Array<{
      event: (id: string, type?: string) => void; receive: (event: WorkspaceEventPayload) => void
      disconnect: () => void; onopen: (() => void) | null; closed: boolean
    }> = []
    const serverEvents = new ServerEvents({
      api: {
        connectEvents(receive, disconnect) {
          const source = {
            event: (id: string, type?: string) => receive(native(id, type)),
            receive,
            disconnect: disconnect!,
            onopen: null, closed: false,
            close: () => { source.closed = true },
          }
          sources.push(source)
          return source as unknown as ReturnType<ServerApi["connectEvents"]>
        },
        sendClientConnectionPong: async () => {},
      },
      auth: { check: async () => {}, onRestored: () => () => false },
    })
    t.after(() => serverEvents.dispose())
    await serverEvents.start()
    return { serverEvents, sources }
  }
  return { ...await open(), open, document, frames, paint() {
    for (const [id, callback] of [...frames]) {
      frames.delete(id)
      callback(0)
    }
  } }
}

test("separate SSE arrivals publish one Solid update per frame without losing FIFO", async t => {
  const { serverEvents, sources: [source], frames, paint } = await setup(t)
  const calls: string[] = [], publications: string[] = []
  createRoot(dispose => {
    t.after(dispose)
    const [current, setCurrent] = createSignal("")
    createMemo(() => { publications.push(current()) })
    t.after(serverEvents.on("*", event => {
      if (event.type === "instance.event") calls.push(`any:${event.event.id}`)
    }))
    t.after(serverEvents.on("instance.event", event => {
      if (event.type !== "instance.event") return
      calls.push(`typed:${event.event.id}`)
      setCurrent(event.event.id)
    }))
  })
  source.event("a")
  await Promise.resolve()
  source.event("b", "session.reasoning.delta")
  assert.deepEqual(calls, [], "SSE arrivals wait for their frame")
  assert.equal(frames.size, 1)
  paint()
  assert.deepEqual(calls, ["any:a", "typed:a", "any:b", "typed:b"])
  assert.deepEqual(publications, ["", "b"], "both events share a single Solid batch")
  source.event("c")
  paint()
  t.mock.timers.tick(1000)
  assert.deepEqual(publications, ["", "b", "c"], "the next frame publishes separately; its fallback does not replay")
  assert.equal(calls.length, 6)
})

test("structural events deliver immediately with their earlier deltas in one Solid batch", async t => {
  const { serverEvents, sources: [source], frames, paint } = await setup(t)
  const calls: string[] = [], publications: string[] = []
  createRoot(dispose => {
    t.after(dispose)
    const [current, setCurrent] = createSignal("")
    createMemo(() => { publications.push(current()) })
    t.after(serverEvents.on("*", event => {
      const label = event.type === "instance.event" ? event.event.id : event.type
      calls.push(label)
      setCurrent(label)
    }))
  })
  source.event("text")
  source.event("reasoning", "session.reasoning.delta")
  const retiredFrame = [...frames.values()][0]!
  assert.deepEqual(calls, [])
  source.event("execution", "session.execution.started")
  assert.deepEqual(calls, ["text", "reasoning", "execution"])
  assert.deepEqual(publications, ["", "execution"], "the deltas and the boundary share a single Solid update")
  assert.equal(frames.size, 0)

  source.event("tail")
  retiredFrame(0)
  assert.equal(calls.at(-1), "execution", "the retired frame cannot deliver the new tail")
  source.receive({ type: "workspace.worktreesChanged", workspaceId: "fixture" })
  source.event("tool-input", "session.tool.input.delta")
  source.event("compaction", "session.compaction.delta")
  source.event("deletion", "session.deleted")
  source.event("form", "form.replied")
  source.event("permission", "permission.replied")
  assert.deepEqual(calls, ["text", "reasoning", "execution", "tail", "workspace.worktreesChanged",
    "tool-input", "compaction", "deletion", "form", "permission"])
  assert.deepEqual(publications, ["", "execution", "workspace.worktreesChanged", "tool-input", "compaction",
    "deletion", "form", "permission"])
  paint()
  t.mock.timers.tick(1000)
  assert.equal(calls.length, 10, "cancelled wakes never replay the deltas")
})

test("the timer drives hidden or suspended frames and wakes only once", async t => {
  const { serverEvents, sources: [source], document, frames } = await setup(t)
  const delivered: string[] = []
  t.after(serverEvents.on("instance.event", event => {
    if (event.type === "instance.event") delivered.push(event.event.id)
  }))
  document.hidden = true
  source.event("hidden-a")
  source.event("hidden-b")
  assert.deepEqual(delivered, [])
  assert.equal(frames.size, 0, "hidden pages do not depend on a paint")
  t.mock.timers.tick(1000)
  assert.deepEqual(delivered, ["hidden-a", "hidden-b"])

  document.hidden = false
  source.event("stalled")
  const staleFrame = [...frames.values()][0]
  assert.ok(staleFrame)
  t.mock.timers.tick(1000)
  assert.equal(frames.size, 0)
  source.event("next")
  staleFrame(0)
  assert.deepEqual(delivered, ["hidden-a", "hidden-b", "stalled"], "a retired frame cannot drain a newer batch")
  t.mock.timers.tick(1000)
  assert.deepEqual(delivered, ["hidden-a", "hidden-b", "stalled", "next"])
})

test("a transport error drains accepted events before disconnect and fences callbacks from the old stream", async t => {
  const { serverEvents, sources, frames, paint } = await setup(t)
  const [previous] = sources
  const order: string[] = []
  const publish = () => { order.push("published") }
  t.after(serverEvents.on("instance.event", event => {
    if (event.type !== "instance.event") return
    order.push(event.event.id)
    assert.ok(serverEvents.deferUntilBatchEnd(publish))
  }))
  t.after(serverEvents.onOpen(() => { order.push("open") }))
  t.after(serverEvents.onTransportStatus(status => { order.push(status) }))

  previous.event("before-a")
  previous.event("before-b")
  assert.deepEqual(order, [])
  previous.disconnect()
  assert.ok(previous.closed)
  assert.equal(frames.size, 0)
  t.mock.timers.tick(1000)
  await Promise.resolve()
  previous.event("obsolete")
  sources[1].onopen!()
  sources[1].event("after")
  assert.deepEqual(order, ["before-a", "before-b", "published", "disconnected", "disconnected", "connected", "open"])
  paint()
  t.mock.timers.tick(1000)
  assert.deepEqual(order, ["before-a", "before-b", "published", "disconnected", "disconnected", "connected", "open", "after", "published"])
})

test("a scoped read, authority event, restart and disposal leave other backends' deltas buffered", async t => {
  const { serverEvents: local, sources: [localStream], open, frames, paint } = await setup(t)
  const { serverEvents: remote, sources: [remoteStream] } = await open()
  const bus = new BackendEvents(), seen: string[] = []
  t.after(bus.attach("local", local))
  t.after(bus.attach("remote", remote))
  const publish = () => { seen.push("publish") }
  bus.on("instance.event", event => {
    assert.equal(event.type, "instance.event")
    seen.push(`${event.instanceId}:${event.event.id}`)
    assert.ok(bus.deferUntilBatchEnd(event.instanceId, publish))
  })
  localStream.event("local-1")
  remoteStream.event("remote-1")
  assert.equal(frames.size, 2)
  bus.flushPendingBatch("remote~fixture")
  assert.deepEqual(seen, ["remote~fixture:remote-1", "publish"])
  remoteStream.event("remote-2")
  remoteStream.event("remote-authority", "session.execution.started")
  assert.deepEqual(seen.slice(2), ["remote~fixture:remote-2", "remote~fixture:remote-authority"])
  remoteStream.event("before-restart")
  remote.restart()
  assert.deepEqual(seen.slice(4), ["remote~fixture:before-restart", "publish"])
  await Promise.resolve()
  remoteStream.event("stale-generation")
  const replacement = await open()
  const oldWake = [...frames.values()][0]!
  localStream.event("discard-on-dispose")
  local.dispose()
  t.after(bus.attach("local", replacement.serverEvents))
  localStream.event("stale-after-dispose")
  replacement.sources[0].event("fresh-local")
  oldWake(0)
  assert.equal(frames.size, 1)
  paint()
  t.mock.timers.tick(1000)
  assert.deepEqual(seen.slice(6), ["fixture:fresh-local", "publish"])
})

test("reattaching a stream during a drain cannot deliver the rest of that batch to its replacement", async t => {
  const { serverEvents, sources: [source], paint } = await setup(t)
  const bus = new BackendEvents(), seen: string[] = []
  const detach = bus.attach("remote", serverEvents)
  let first = true
  bus.on("instance.event", event => {
    assert.equal(event.type, "instance.event")
    seen.push(event.event.id)
    if (!first) return
    first = false
    detach()
    t.after(bus.attach("remote", serverEvents))
  })
  source.event("first")
  source.event("old-attachment")
  paint()
  source.event("new-attachment")
  paint()
  assert.deepEqual(seen, ["first", "new-attachment"])
})
