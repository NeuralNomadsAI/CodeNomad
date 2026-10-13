import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient, OpenCodeEvent, SessionActiveOutput } from "@opencode/client"
import { OpenCodeSharedService, type ServiceConnection } from "./opencode-service"
import { observePendingDiscovery, deferPendingDiscovery, markLoadedPendingSupported, grantPendingReconciliation, carryPendingCompactions } from "./pending-discovery"
import { InstanceEventBridge } from "./instance-events"
import { EventBus } from "../events/bus"
import type { WorkspaceManager } from "./manager"
import type { Logger } from "../logger"

const compact = (phase: "started" | "delta" | "ended" | "failed", sessionID = "unloaded", seq = 1): OpenCodeEvent => ({
  id: `event-${seq}`, created: seq, type: `session.compaction.${phase}`,
  ...(phase === "delta" ? {} : { durable: { aggregateID: sessionID, seq, version: 1 } }),
  location: { directory: "/other-project" }, data: { sessionID, reason: "auto", recent: "recent", text: "summary" },
} as OpenCodeEvent)
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise<void>((done) => setImmediate(done))
  assert.ok(check(), "fixture did not settle")
}
function connection(active: () => Promise<SessionActiveOutput> = async () => ({})) {
  let current = true
  const value = { client: { session: { active } }, assertCurrent: () => { assert.ok(current) } } as unknown as ServiceConnection
  return { value, invalidate() { current = false } }
}

test("the authenticated native consumer records compactions before blocked ownership routing, without publishing foreign data", async () => {
  const finish = deferred<void>(), ownership = deferred<boolean>()
  let checks = 0
  const client = { event: { subscribe: (options: { signal: AbortSignal }) => (async function* () {
    yield { type: "server.connected", data: {} } as OpenCodeEvent
    yield compact("started")
    yield compact("delta", "unloaded", 2)
    await finish.promise
    yield compact("ended", "unloaded", 3)
    await new Promise<void>((done) => options.signal.addEventListener("abort", () => done(), { once: true }))
  })() } } as unknown as OpenCodeClient
  const service = new OpenCodeSharedService({ headers: () => ({ authorization: "isolated-fixture" }), makeClient: () => client })
  const endpoint = { url: "http://127.0.0.1:4321" }
  await service.client({ kind: "lifecycle", identity: "fixture", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
  const bound = await service.acquire()
  const workspace = { id: "fixture", path: "/owned" }
  const manager = {
    list: () => [workspace], subscribeToSharedService: (signal: AbortSignal) => service.subscribe({ signal }),
    ownsDirectory: async () => { checks++; return ownership.promise },
  } as unknown as WorkspaceManager
  const eventBus = new EventBus(), published: OpenCodeEvent[] = []
  eventBus.on("instance.event", ({ event }) => { if (event.type.startsWith("session.compaction")) published.push(event) })
  const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus, logger: { debug() {}, warn() {} } as unknown as Logger })
  try {
    eventBus.publish({ type: "workspace.started", workspace: workspace as never })
    await until(() => checks > 0 && deferPendingDiscovery(bound))
    assert.deepEqual(published, [])
    finish.resolve()
    await until(() => !deferPendingDiscovery(bound))
    assert.deepEqual(published, [], "ownership was not bypassed to deliver the early signal")
    ownership.resolve(false)
  } finally { finish.resolve(); ownership.resolve(false); bridge.shutdown(); await service.shutdown() }
})

test("overlaps, duplicate starts and late deltas cannot drift the hold; supported loaded-only reads are separately admitted", () => {
  const { value } = connection()
  observePendingDiscovery(value, compact("started", "one", 1))
  observePendingDiscovery(value, compact("started", "one", 1))
  observePendingDiscovery(value, compact("delta", "two", 2))
  assert.equal(deferPendingDiscovery(value), true)
  markLoadedPendingSupported(value, true)
  assert.equal(deferPendingDiscovery(value, { loadedOnly: true }), false)
  assert.equal(deferPendingDiscovery(value), true)
  observePendingDiscovery(value, compact("ended", "one", 3))
  observePendingDiscovery(value, compact("delta", "one", 2))
  assert.equal(deferPendingDiscovery(value), true)
  observePendingDiscovery(value, compact("failed", "two", 4))
  assert.equal(deferPendingDiscovery(value), false)
})

test("missed-end status probes are bounded/coalesced, retain errors and active sessions, and fence newer events and replacements", async () => {
  let reads = 0, response = deferred<SessionActiveOutput>()
  const h = connection(async () => { reads++; return response.promise })
  observePendingDiscovery(h.value, compact("started"))
  const now = Date.now() + 30_001
  for (let i = 0; i < 10; i++) assert.equal(deferPendingDiscovery(h.value, {}, now), true)
  await until(() => reads === 1)
  observePendingDiscovery(h.value, compact("delta", "unloaded", 2))
  response.resolve({})
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(deferPendingDiscovery(h.value, {}, now), true)
  response = deferred()
  deferPendingDiscovery(h.value, {}, now + 30_001)
  await until(() => reads === 2)
  response.resolve({ unloaded: { type: "running" } })
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(deferPendingDiscovery(h.value, {}, now + 30_001), true)
  h.value.client.session.active = async () => { throw new Error("offline") }
  deferPendingDiscovery(h.value, {}, now + 60_002)
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(deferPendingDiscovery(h.value, {}, now + 60_002), true)
  const next = connection()
  carryPendingCompactions(h.value, next.value)
  h.invalidate()
  assert.throws(() => deferPendingDiscovery(h.value))
  assert.equal(deferPendingDiscovery(next.value), true)
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(deferPendingDiscovery(next.value), false)
})

test("reconciliation grants are exact, scoped, bounded and expire; connection replacement drops grants and capability", () => {
  const h = connection(), next = connection()
  observePendingDiscovery(h.value, compact("started"))
  markLoadedPendingSupported(h.value, true)
  grantPendingReconciliation(h.value, "one", "C:\\Native\\Root")
  assert.equal(deferPendingDiscovery(h.value, { workspaceId: "one", reconciliationDirectory: "C:\\Native\\Root" }), false)
  assert.equal(deferPendingDiscovery(h.value, { workspaceId: "two", reconciliationDirectory: "C:\\Native\\Root" }), true)
  assert.equal(deferPendingDiscovery(h.value, { workspaceId: "one", reconciliationDirectory: "c:/native/root" }), true)
  assert.equal(deferPendingDiscovery(h.value, { workspaceId: "one", reconciliationDirectory: "C:\\Native\\Root" }, Date.now() + 300_001), true)
  for (let i = 0; i < 65; i++) grantPendingReconciliation(h.value, "one", `/grant-${i}`)
  assert.equal(deferPendingDiscovery(h.value, { workspaceId: "one", reconciliationDirectory: "/grant-0" }), true)
  assert.equal(deferPendingDiscovery(h.value, { workspaceId: "one", reconciliationDirectory: "/grant-64" }), false)
  carryPendingCompactions(h.value, next.value)
  assert.equal(deferPendingDiscovery(next.value, { loadedOnly: true, workspaceId: "one", reconciliationDirectory: "C:\\Native\\Root" }), true)
})

test("a timed-out status probe retains compaction admission and permits a later liveness retry", async () => {
  let timedOut = false
  const h = connection()
  h.value.client.session.active = (options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => { timedOut = true; reject(options!.signal!.reason) }, { once: true })
  })
  observePendingDiscovery(h.value, compact("started"))
  const now = Date.now() + 30_001
  assert.equal(deferPendingDiscovery(h.value, {}, now), true)
  // Keep the fixture alive while the platform's unref'd timeout expires.
  await new Promise<void>((done) => setTimeout(done, 2050))
  assert.equal(timedOut, true)
  assert.equal(deferPendingDiscovery(h.value, {}, now), true)
  h.value.client.session.active = async () => ({})
  deferPendingDiscovery(h.value, {}, now + 30_001)
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(deferPendingDiscovery(h.value, {}, now + 30_001), false)
})
