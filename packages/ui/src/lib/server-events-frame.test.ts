import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { serverApi } from "./api-client"
import { authRecovery } from "./auth-recovery"
import { serverEvents } from "./server-events"

async function setup(t: TestContext) {
  const sources: Array<{
    event: (id: string) => void; disconnect: () => void; onopen: (() => void) | null; closed: boolean
  }> = []
  t.mock.method(serverApi, "connectEvents", (receive: Parameters<typeof serverApi.connectEvents>[0], disconnect: () => void) => {
    const source = {
      event: (workspaceId: string) => receive({ type: "workspace.worktreesChanged", workspaceId }),
      disconnect,
      onopen: null, closed: false,
      close: () => { source.closed = true },
    }
    sources.push(source)
    return source
  })
  t.mock.method(authRecovery, "check", async () => {})
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const document = { hidden: false }
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  for (const [name, value] of Object.entries({
    document,
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
  serverEvents.restart()
  await Promise.resolve()
  return { sources, document, frames, paint() {
    for (const [id, callback] of [...frames]) {
      frames.delete(id)
      callback(0)
    }
  } }
}

test("separate SSE arrivals publish one Solid update per frame without losing FIFO", async t => {
  const { sources: [source], frames, paint } = await setup(t)
  const calls: string[] = [], publications: string[] = []
  createRoot(dispose => {
    t.after(dispose)
    const [current, setCurrent] = createSignal("")
    createMemo(() => { publications.push(current()) })
    t.after(serverEvents.on("*", event => {
      if (event.type === "workspace.worktreesChanged") calls.push(`any:${event.workspaceId}`)
    }))
    t.after(serverEvents.on("workspace.worktreesChanged", event => {
      if (event.type !== "workspace.worktreesChanged") return
      calls.push(`typed:${event.workspaceId}`)
      setCurrent(event.workspaceId)
    }))
  })
  source.event("a")
  await Promise.resolve()
  source.event("b")
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

test("the timer drives hidden or suspended frames and wakes only once", async t => {
  const { sources: [source], document, frames } = await setup(t)
  const delivered: string[] = []
  t.after(serverEvents.on("workspace.worktreesChanged", event => {
    if (event.type === "workspace.worktreesChanged") delivered.push(event.workspaceId)
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
  const { sources, frames, paint } = await setup(t)
  const [previous] = sources
  const order: string[] = []
  const publish = () => { order.push("published") }
  t.after(serverEvents.on("workspace.worktreesChanged", event => {
    if (event.type !== "workspace.worktreesChanged") return
    order.push(event.workspaceId)
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
