import assert from "node:assert/strict"
import { test } from "node:test"
import type { LocationRef, OpenCodeEvent } from "@opencode/client"
import { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import type { WorkspaceManager } from "./manager"
import { InstanceEventBridge } from "./instance-events"
import { InstanceEventQueue } from "./instance-event-queue"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    assert.ok(Date.now() < deadline, "event routing did not settle")
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const delta = (id: string, sessionID: string, directory?: string) => ({
  id, created: Date.now(), type: "session.text.delta", data: { sessionID, delta: id },
  ...(directory ? { location: { directory } } : {}),
}) as OpenCodeEvent

class Feed {
  private items: Array<OpenCodeEvent | Error> = []
  private wake = deferred<void>()
  send(event: OpenCodeEvent | Error) { this.items.push(event); this.wake.resolve() }
  async *read(signal: AbortSignal) {
    const abort = () => this.wake.resolve()
    signal.addEventListener("abort", abort, { once: true })
    try {
      yield { type: "server.connected", data: {} } as OpenCodeEvent
      while (!signal.aborted) {
        const item = this.items.shift()
        if (item instanceof Error) throw item
        if (item) yield item
        else { await this.wake.promise; this.wake = deferred<void>() }
      }
    } finally { signal.removeEventListener("abort", abort) }
  }
}

function harness(owns: (id: string, location: LocationRef) => Promise<boolean>, get = async (_id: string, _signal?: AbortSignal): Promise<LocationRef> => ({ directory: "/repo" })) {
  const streams: Feed[] = []
  const workspaces = [{ id: "fast", path: "/repo" }, { id: "slow", path: "/other" }]
  const received: Array<{ instanceId: string; event: OpenCodeEvent }> = []
  const statuses: string[] = []
  const warnings: unknown[] = []
  const bus = new EventBus()
  const manager = {
    list: () => workspaces,
    ownsDirectory: (id: string, directory: string) => owns(id, { directory }),
    ownsLocation: owns,
    invalidateWorktrees: () => {},
    getSharedServiceClient: async () => ({ session: { get: async ({ sessionID }: { sessionID: string }, options?: { signal?: AbortSignal }) => ({ location: await get(sessionID, options?.signal) }) } }),
    subscribeToSharedService: async (signal: AbortSignal) => {
      const feed = new Feed(); streams.push(feed); return feed.read(signal)
    },
  } as unknown as WorkspaceManager
  bus.on("instance.event", value => { if (value.event.type !== "server.connected") received.push(value) })
  bus.on("instance.eventStatus", value => statuses.push(value.status))
  const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus,
    logger: { debug() {}, warn(value: unknown) { warnings.push(value) } } as unknown as Logger })
  bus.publish({ type: "workspace.started", workspace: workspaces[0] } as any)
  return { bridge, bus, streams, received, statuses, warnings, workspaces }
}

test("a slow recipient never stalls upstream consumption or ordered delivery to a fast recipient", async () => {
  const slow = deferred<boolean>()
  const checks: string[] = []
  const h = harness(async id => { checks.push(id); return id === "slow" ? slow.promise : true })
  try {
    await until(() => h.streams.length === 1)
    for (let i = 0; i < 30; i++) h.streams[0].send(delta(String(i), "s", "/repo"))
    h.streams[0].send({ type: "model.updated", data: {} } as OpenCodeEvent)
    await until(() => h.received.filter(x => x.instanceId === "fast").length === 31)
    assert.equal(h.received.filter(x => x.instanceId === "slow" && x.event.type === "session.text.delta").length, 0)
    assert.deepEqual(checks.sort(), ["fast", "slow"], "concurrent routing shares each recipient's ownership lookup")
    slow.resolve(true)
    await until(() => h.received.length === 62)
    for (const id of ["fast", "slow"]) assert.deepEqual(h.received.filter(x => x.instanceId === id && x.event.type === "session.text.delta").map(x => "id" in x.event && x.event.id), Array.from({ length: 30 }, (_, i) => String(i)))
  } finally { h.bridge.shutdown(); slow.resolve(false) }
})

test("slow ownership and locationless session resolution do not block another session in the same workspace", async () => {
  const ownership = deferred<boolean>(), location = deferred<LocationRef>()
  const h = harness(async (id, loc) => id === "fast" && (loc.directory === "/cold" ? ownership.promise : true), async id => id === "unknown" ? location.promise : { directory: "/repo" })
  try {
    await until(() => h.streams.length === 1)
    h.streams[0].send(delta("cold", "cold", "/cold"))
    h.streams[0].send(delta("unknown", "unknown"))
    h.streams[0].send(delta("fast-1", "known", "/repo"))
    h.streams[0].send(delta("fast-2", "known"))
    await until(() => h.received.length === 2)
    assert.deepEqual(h.received.map(x => "id" in x.event && x.event.id), ["fast-1", "fast-2"])
    location.resolve({ directory: "/repo" }); ownership.resolve(true)
    await until(() => h.received.length === 4)
  } finally { h.bridge.shutdown(); location.resolve({ directory: "/repo" }); ownership.resolve(false) }
})

test("session move and deletion barriers retain per-recipient order across a pending old-location lookup", async () => {
  const old = deferred<boolean>()
  let gets = 0
  const h = harness(async (_id, loc) => loc.directory === "/old" ? old.promise : true, async () => { gets++; return { directory: "/new" } })
  try {
    await until(() => h.streams.length === 1)
    h.streams[0].send(delta("before", "s", "/old"))
    h.streams[0].send({ id: "move", type: "session.moved", location: { directory: "/old" }, data: { sessionID: "s", location: { directory: "/new" } } } as OpenCodeEvent)
    h.streams[0].send(delta("after", "s"))
    h.streams[0].send({ id: "delete", type: "session.deleted", data: { sessionID: "s" } } as OpenCodeEvent)
    h.streams[0].send(delta("last", "s"))
    await until(() => gets === 2)
    assert.equal(h.received.length, 0)
    old.resolve(true)
    await until(() => h.received.length === 10)
    for (const id of ["fast", "slow"]) assert.deepEqual(h.received.filter(x => x.instanceId === id).map(x => "id" in x.event && x.event.id), ["before", "move", "after", "delete", "last"])
  } finally { h.bridge.shutdown(); old.resolve(false) }
})

test("a session move reaches its old owner, its new owner and earlier recipients only", async () => {
  const locations: Record<string, LocationRef> = { s: { directory: "/other" }, t: { directory: "/other" } }
  const h = harness(async (id, loc) => (id === "fast" && loc.directory === "/repo") || (id === "slow" && loc.directory === "/other"),
    async id => locations[id]!)
  const move = (id: string, sessionID: string, envelope?: string) => ({ id, type: "session.moved",
    ...(envelope ? { location: { directory: envelope } } : {}), data: { sessionID, location: { directory: "/other" } } }) as OpenCodeEvent
  try {
    await until(() => h.streams.length === 1)
    h.streams[0].send(delta("before", "s", "/repo"))
    h.streams[0].send(move("moved", "s", "/repo"))
    h.streams[0].send(delta("after", "s"))
    // Another client's move can arrive without the old envelope.
    h.streams[0].send(delta("u-before", "u", "/repo"))
    locations.u = { directory: "/other" }
    h.streams[0].send(move("u-moved", "u"))
    // A workspace owning neither location that never held the session learns nothing.
    h.streams[0].send(move("t-moved", "t", "/elsewhere"))
    await until(() => h.received.length === 8)
    await turn()
    const ids = (instanceId: string) => h.received.filter(x => x.instanceId === instanceId).map(x => "id" in x.event && x.event.id)
    for (const [instanceId, lanes] of [
      ["fast", [["before", "moved"], ["u-before", "u-moved"]]],
      ["slow", [["moved", "after"], ["u-moved"], ["t-moved"]]],
    ] as const) {
      const delivered = ids(instanceId)
      const expected: readonly (readonly string[])[] = lanes
      assert.deepEqual([...delivered].sort(), expected.flat().sort(), "exact recipients, with no duplicate deliveries")
      for (const lane of expected) {
        assert.deepEqual(delivered.filter(id => typeof id === "string" && lane.includes(id)), lane, "each session keeps its order")
      }
    }
  } finally { h.bridge.shutdown() }
})

test("a failed old-location lookup still delivers the move to its destination owner", async () => {
  const destinationChecks: string[] = []
  const h = harness(async (id, location) => {
    if (location.directory === "/repo") {
      if (id === "fast") return true
      throw new Error("Old checkout is temporarily unreadable")
    }
    destinationChecks.push(id)
    return id === "slow" && location.directory === "/other-alias"
  })
  h.workspaces.push({ id: "unrelated", path: "/third" })
  try {
    await until(() => h.streams.length === 1)
    h.streams[0].send({ id: "move", type: "session.moved", location: { directory: "/repo" },
      data: { sessionID: "s", location: { directory: "/other-alias" } } } as OpenCodeEvent)
    h.streams[0].send(delta("after", "s", "/other-alias"))
    await until(() => h.received.some(x => x.instanceId === "slow" && x.event.type === "session.text.delta"))
    assert.deepEqual(h.received.filter(x => x.event.type === "session.moved").map(x => x.instanceId).sort(), ["fast", "slow"])
    await until(() => h.statuses.includes("error"))
    assert.ok(destinationChecks.includes("unrelated"))
    assert.equal(h.statuses.filter(status => status === "error").length, 1, "only the unresolved recipient reconciles")
  } finally { h.bridge.shutdown() }
})

test("a move without an envelope reaches the payload destination without reading the session", async () => {
  let sessionReads = 0
  const h = harness(async (id, location) =>
    (id === "fast" && location.directory === "/repo") || (id === "slow" && location.directory === "/other-alias"),
  async () => {
    sessionReads++
    throw new Error("Session lookup unavailable")
  })
  h.workspaces.push({ id: "unrelated", path: "/third" })
  try {
    await until(() => h.streams.length === 1)
    h.streams[0].send(delta("before", "s", "/repo"))
    await until(() => h.received.length === 1)
    h.streams[0].send({ id: "move", type: "session.moved",
      data: { sessionID: "s", location: { directory: "/other-alias" } } } as OpenCodeEvent)
    h.streams[0].send(delta("after", "s", "/other-alias"))
    await until(() => h.received.some(x => x.instanceId === "slow" && x.event.type === "session.text.delta"))
    assert.deepEqual(h.received.filter(x => x.event.type === "session.moved").map(x => x.instanceId).sort(), ["fast", "slow"])
    assert.equal(sessionReads, 0)
  } finally { h.bridge.shutdown() }
})

test("the destination of a move receives the next envelope-free departure", async () => {
  const folders = new Map([["fast", "/repo"], ["slow", "/other"], ["third", "/third"]])
  const h = harness(async (id, location) => folders.get(id) === location.directory)
  h.workspaces.push({ id: "third", path: "/third" })
  try {
    await until(() => h.streams.length === 1)
    h.streams[0].send({ id: "to-second", type: "session.moved", location: { directory: "/repo" },
      data: { sessionID: "s", location: { directory: "/other" } } } as OpenCodeEvent)
    h.streams[0].send({ id: "to-third", type: "session.moved",
      data: { sessionID: "s", location: { directory: "/third" } } } as OpenCodeEvent)
    await until(() => h.received.some(x => x.instanceId === "third" && x.event.id === "to-third"))
    await turn()
    const ids = (id: string) => h.received.filter(x => x.instanceId === id).map(x => x.event.id)
    assert.deepEqual(ids("fast"), ["to-second"])
    assert.deepEqual(ids("slow"), ["to-second", "to-third"])
    assert.deepEqual(ids("third"), ["to-third"])
  } finally { h.bridge.shutdown() }
})

test("native and local inventory invalidations fence pending ownership before publication", async () => {
  for (const native of [false, true]) {
    const pending = deferred<boolean>()
    let checks = 0
    const h = harness(async id => id === "fast" && (++checks === 1 ? pending.promise : false))
    try {
      await until(() => h.streams.length === 1)
      h.streams[0].send(delta("obsolete", "s", "/repo"))
      await until(() => checks === 1)
      if (native) {
        h.streams[0].send({ type: "worktree.updated", data: {} } as OpenCodeEvent)
        await until(() => h.received.length === 2)
      } else h.bus.publish({ type: "workspace.worktreesChanged", workspaceId: "fast" })
      pending.resolve(true)
      await until(() => checks === 2)
      await turn()
      assert.equal(h.received.some(x => x.event.type === "session.text.delta"), false)
    } finally { h.bridge.shutdown(); pending.resolve(false) }
  }
})

test("disconnect, shutdown and stop/reopen fence already-running and queued deliveries", async () => {
  for (const kind of ["disconnect", "shutdown", "reopen"] as const) {
    const old = deferred<boolean>()
    let checks = 0
    const h = harness(async id => id === "fast" && (++checks === 1 ? old.promise : true))
    try {
      await until(() => h.streams.length === 1)
      h.streams[0].send(delta("old", "s", "/repo"))
      h.streams[0].send(delta("queued", "s", "/repo"))
      await until(() => checks === 1)
      if (kind === "disconnect") {
        h.streams[0].send(new Error("lost native stream"))
        await until(() => h.streams.length === 2)
      } else if (kind === "reopen") {
        h.bus.publish({ type: "workspace.stopped", workspaceId: "fast" } as any)
        h.bus.publish({ type: "workspace.started", workspace: h.workspaces[0] } as any)
      } else h.bridge.shutdown()
      old.resolve(true)
      await turn()
      assert.equal(h.received.length, 0)
      if (kind !== "shutdown") {
        h.streams.at(-1)!.send(delta("new", "s", "/repo"))
        await until(() => h.received.length === 1)
        assert.equal("id" in h.received[0].event && h.received[0].event.id, "new")
      }
    } finally { h.bridge.shutdown(); old.resolve(false) }
  }
})

test("queue count, byte and stalled-routing budgets fail once and discard pending work", async () => {
  for (const mode of ["count", "bytes", "timeout"] as const) {
    const pending = deferred<void>(), failed = deferred<Error>()
    let errors = 0, ran = 0
    const queue = new InstanceEventQueue(error => { errors++; failed.resolve(error) }, {
      jobs: mode === "count" ? 1 : 10, bytes: mode === "bytes" ? 1 : 100, timeoutMs: 10,
    })
    queue.enqueue("s", 1, () => pending.promise)
    queue.enqueue("s", 1, async () => { ran++ })
    // Keep the test alive while the production watchdog is intentionally unref'ed.
    const keepAlive = setTimeout(() => {}, 1000)
    try {
      assert.match((await failed.promise).message, /budget|timed out/)
      pending.resolve()
      await turn()
      queue.enqueue("other", 1, async () => { ran++ })
      assert.equal(errors, 1); assert.equal(ran, 0); assert.equal(queue.pending, 0)
    } finally { clearTimeout(keepAlive); queue.close(); pending.resolve() }
  }
})

test("backlog overflow reconnects for authoritative recovery rather than publishing stale deltas", async () => {
  const old = deferred<LocationRef>()
  const h = harness(async id => id === "fast", () => old.promise)
  try {
    await until(() => h.streams.length === 1)
    for (let i = 0; i < 2100; i++) h.streams[0].send(delta(String(i), "blocked"))
    await until(() => h.streams.length === 2)
    assert.ok(h.statuses.includes("error"))
    old.resolve({ directory: "/repo" })
    h.streams[1].send(delta("recovered", "fresh", "/repo"))
    await until(() => h.received.length === 1)
    assert.equal("id" in h.received[0].event && h.received[0].event.id, "recovered")
  } finally { h.bridge.shutdown(); old.resolve({ directory: "/repo" }) }
})

test("shutdown cancels a native session lookup without retrying or publishing late work", async () => {
  let calls = 0, signal: AbortSignal | undefined
  const h = harness(async () => true, async (_id, requestSignal) => {
    calls++; signal = requestSignal
    return new Promise((_resolve, reject) => requestSignal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  })
  try {
    await until(() => h.streams.length === 1)
    h.streams[0].send(delta("pending", "unknown"))
    await until(() => calls === 1)
    h.bridge.shutdown()
    await turn()
    assert.equal(signal?.aborted, true)
    assert.equal(calls, 1)
    assert.equal(h.received.length, 0)
    assert.equal(h.warnings.length, 0)
  } finally { h.bridge.shutdown() }
})

test("rate-limited lag diagnostics distinguish upstream age without logging event contents", async () => {
  const h = harness(async id => id === "fast")
  try {
    await until(() => h.streams.length === 1)
    for (let i = 0; i < 3; i++) h.streams[0].send({ ...delta(`private-content-${i}`, "s", "/repo"), created: Date.now() - 5000 } as OpenCodeEvent)
    await until(() => h.received.length === 3)
    assert.equal(h.warnings.length, 1)
    const warning = h.warnings[0] as { upstreamAgeMs: number; routingMs: number; ownershipMs: number; locationMs: number; recipientQueueMs: number }
    assert.ok(warning.upstreamAgeMs >= 5000)
    for (const key of ["routingMs", "ownershipMs", "locationMs", "recipientQueueMs"] as const) assert.equal(typeof warning[key], "number")
    assert.doesNotMatch(JSON.stringify(h.warnings), /private-content|"data"|\/repo/)
  } finally { h.bridge.shutdown() }
})

test("an unresolvable session location pulses its recipients instead of dropping the event silently", async () => {
  let failures = 2
  const pulses: string[] = []
  const h = harness(async id => id === "fast", async () => {
    if (failures > 0) { failures--; throw new Error("session lookup unavailable") }
    return { directory: "/repo" }
  })
  h.bus.on("instance.eventStatus", value => { if (value.reason === "event routing failed") pulses.push(value.instanceId) })
  try {
    await until(() => h.streams.length === 1)
    h.streams[0].send({ id: "step", created: Date.now(), type: "session.step.started", data: { sessionID: "s", assistantMessageID: "m" } } as OpenCodeEvent)
    await until(() => pulses.length === 2)
    assert.deepEqual(pulses.sort(), ["fast", "slow"], "no recipient is known yet, so every recipient reconciles")
    assert.equal(h.received.length, 0, "an unresolvable event is never broadcast")
    // The failed lookup stays cached for its short TTL, then resolves.
    await new Promise(resolve => setTimeout(resolve, 2100))
    h.streams[0].send(delta("after", "s"))
    await until(() => h.received.length === 1)
    assert.equal(h.received[0].instanceId, "fast")
  } finally { h.bridge.shutdown() }
})

test("a recipient refused a session it received reconciles; a location it never owned stays silent", async () => {
  let fastOwns = true
  const pulses: string[] = []
  const h = harness(async (id, loc) => loc.directory === "/repo" && id === "fast" && fastOwns)
  h.bus.on("instance.eventStatus", value => { if (value.reason === "event routing failed") pulses.push(value.instanceId) })
  try {
    await until(() => h.streams.length === 1)
    h.streams[0].send(delta("owned", "s", "/repo"))
    h.streams[0].send(delta("foreign", "t", "/elsewhere"))
    await until(() => h.received.length === 1)
    await turn()
    assert.deepEqual(pulses, [], "a definite foreign location never pulses")

    // An ambiguous lookup now answers `false` for the checkout that owned it.
    fastOwns = false
    h.bus.publish({ type: "workspace.worktreesChanged", workspaceId: "fast" })
    h.streams[0].send(delta("refused", "s", "/repo"))
    h.streams[0].send(delta("foreign-again", "t", "/elsewhere"))
    await until(() => pulses.length === 1)
    await turn()
    assert.deepEqual(pulses, ["fast"])
    assert.deepEqual(h.received.map(x => "id" in x.event && x.event.id), ["owned"], "a refused event is never delivered")
  } finally { h.bridge.shutdown() }
})
