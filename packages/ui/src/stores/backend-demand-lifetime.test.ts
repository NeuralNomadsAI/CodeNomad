import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test, type TestContext } from "node:test"
import type { MissionListResponse, MissionPanelMap, PluginControlsSnapshot } from "../../../server/src/api-types"
import type { MissionContentResponse } from "../../../server/src/missions/mission-content-wire"
import { backendEvents, type ServerEvents } from "../lib/server-events"
import { captureBackendOperation } from "../lib/backend-operation"
import { createEventRefreshScheduler } from "../lib/event-refresh-scheduler"
import { serverApi } from "../lib/api-client"
import { registerLocalBackendFixture } from "../../tests/contracts/local-backend-fixture"
import { receiptReads } from "../lib/background-read-queue"
import { createMissionStore } from "./mission-store"
import { createMissionPanelInventory } from "./mission-panel-inventory"
import { createMissionTaskSessions } from "./mission-task-session-reads"
import { createMissionContentStore, type MissionBodyRef } from "./mission-content-store"
import { PluginControlsCache } from "./plugin-controls"
import { PluginSourcesStore } from "./plugin-sources"
import { createShellStore } from "./shell-store"
import { acquirePermissionReceipts, cachedPermissionReceipts, permissionReceiptKey } from "./permission-receipt-cache"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function attachment(t: TestContext, id: string) {
  let open: (() => void) | undefined
  const source: Pick<ServerEvents, "on" | "onOpen" | "onDispose" | "onTransportStatus"> = {
    on: () => () => {}, onOpen: handler => { open = handler; return () => { open = undefined } },
    onDispose: () => () => {}, onTransportStatus: () => () => {},
  }
  let detach = backendEvents.attach(id, source)
  t.after(() => detach())
  return { instance: `${id}~workspace`, detach: () => detach(),
    reattach: () => { detach = backendEvents.attach(id, source); open?.() } }
}
const signal = (id: string) => captureBackendOperation(id).signal
const location = { directory: "/repo" }
const snapshot = (id: string): PluginControlsSnapshot => ({
  location, runtime: [], configured: { rules: [], sources: [] }, targets: [],
  controls: [{ id }],
} as unknown as PluginControlsSnapshot)
const missions = (time: number): MissionListResponse => ({ available: true, version: 1, projectID: "project", generatedAt: time,
  discardedEvents: 0, missions: [], activity: { generatedAt: time, missions: [] } })

test("Mission demand survives attachment replacement, without joining late IO or replaying its trailing read", async t => {
  const backend = attachment(t, "demand_mission")
  const old = deferred<MissionListResponse>(), fresh = deferred<MissionListResponse>()
  const sent: AbortSignal[] = []
  const store = createMissionStore(async (_id, _request, captured) => {
    sent.push(captured!)
    return sent.length === 1 ? old.promise : fresh.promise
  }, undefined, false, signal)
  store.setDemand(backend.instance, true)
  const first = store.refresh(backend.instance)
  void store.refresh(backend.instance)
  backend.detach()
  assert.equal(sent[0].aborted, true)
  backend.reattach()
  assert.deepEqual(store.demandedInstanceIds(), [backend.instance])
  const second = store.refresh(backend.instance)
  assert.equal(sent.length, 2, "new demand never joins the old attachment")
  fresh.resolve(missions(2)); await second
  old.resolve(missions(1)); await first; await tick()
  assert.equal(store.state(backend.instance).generatedAt, 2)
  assert.equal(sent.length, 2, "old trailing demand cannot acquire the replacement")
})

test("Mission bodies retain display and owners while late slices and old continuations lose authority", async t => {
  const backend = attachment(t, "demand_body")
  const ref: MissionBodyRef = { instanceId: backend.instance, projectID: "project", missionID: "mission", selector: { kind: "mission", field: "objective" } }
  const text = "abcdef", digest = createHash("sha256").update(text, "utf16le").digest("base64url")
  const reads: Array<{ offset: number; signal: AbortSignal; result: ReturnType<typeof deferred<MissionContentResponse>> }> = []
  const store = createMissionContentStore(async (_ref, query, captured) => {
    const result = deferred<MissionContentResponse>()
    reads.push({ offset: query.offset, signal: captured, result }); return result.promise
  }, undefined, signal)
  const answer = (offset: number, end: number): MissionContentResponse => ({ available: true, version: 1, projectID: "project", missionID: "mission", revision: 1,
    content: { ...ref.selector, digest, characters: text.length, offset, text: text.slice(offset, end), ...(end < text.length ? { next: end } : {}) } })
  const owner = store.use(ref, "same-view")
  reads[0].result.resolve(answer(0, 3)); await tick()
  assert.equal(owner.state().body?.text, "abc")
  owner.need(Infinity)
  assert.equal(reads.length, 2)
  backend.detach(); backend.reattach()
  assert.equal(reads[1].signal.aborted, true)
  store.invalidate(backend.instance)
  assert.equal(reads.length, 3)
  reads[1].result.resolve(answer(3, 6)); await tick()
  assert.equal(owner.state().body?.text, "abc", "old slice never extends retained display")
  reads[2].result.resolve(answer(0, 6)); await tick()
  assert.equal(owner.state().body?.text, text)
  assert.equal(reads.length, 3)
  owner.release()
})

test("bounded Mission inventory captures admission before its serialized windows and suppresses old followups", async t => {
  const backend = attachment(t, "demand_panel")
  const old = deferred<never>()
  const reads: Array<{ source: string; signal: AbortSignal }> = []
  const store = createMissionPanelInventory({ scope: () => "/repo", signal, tasks: async () => { throw new Error("unused") },
    read: async (_id, selector, scope) => {
      reads.push({ source: selector.source, signal: scope.signal! })
      if (reads.length === 1) return old.promise
      return { envelope: { available: true, version: 1, projectID: "project", source: selector.source,
        window: { order: "empty", offset: 0, end: 0, total: 0 }, page: { digest: "empty", total: 0, pieces: [] } }, values: [] }
    } })
  store.setDemand(backend.instance, true)
  const first = store.ensure(backend.instance)
  await tick()
  assert.equal(reads.length, 1)
  backend.detach(); backend.reattach()
  await store.refresh(backend.instance)
  await first
  old.resolve(undefined as never); await tick()
  assert.equal(reads[0].signal.aborted, true)
  assert.equal(reads.filter(read => read.source === "summaries").length, 2)
  assert.equal(reads.filter(read => read.source === "cleanups").length, 1, "cancelled list never proceeds to cleanups")
  assert.equal(store.state(backend.instance).status, "ready")
  assert.deepEqual(store.demandedInstanceIds(), [backend.instance])
  store.clear(backend.instance)
})

test("Mission task-session discovery never continues from late coordinator IO into a new attachment", async t => {
  const backend = attachment(t, "demand_tasks")
  const old = deferred<never>()
  let messages = 0, children = 0
  const root = { message: { list: async () => { messages++; return messages === 1 ? old.promise : { data: [], headers: new Headers() } } },
    session: { list: async () => { children++; return { data: [] } }, active: async () => ({}) } }
  const store = createMissionTaskSessions({ connection: () => root, generation: () => 1, signal,
    root: () => root as never, warn: () => assert.fail("unexpected warning") })
  const mission = { id: "mission", projectID: "project", coordinatorSessionId: "coordinator", revision: 1,
    tasks: [{ key: "task", status: "running" }] } as unknown as MissionPanelMap
  const first = store.demand(backend.instance, mission, 0, "preview")
  void store.demand(backend.instance, mission, 1, "preview")
  backend.detach(); backend.reattach()
  await store.demand(backend.instance, mission, 2, "preview")
  old.resolve({ data: [], headers: new Headers() } as never); await first
  assert.equal(messages, 2)
  assert.equal(children, 1)
})

test("captured Mission timers are cancelled before dispatch and fresh open reconciles retained demand", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const backend = attachment(t, "demand_timer")
  let calls = 0
  const store = createMissionStore(async () => { calls++; return missions(calls) }, undefined, false, signal)
  store.setDemand(backend.instance, true)
  const scheduler = createEventRefreshScheduler((id, captured) => store.refresh(id, captured))
  scheduler.schedule(backend.instance, "urgent", signal(backend.instance))
  t.mock.timers.runAll()
  backend.detach(); backend.reattach()
  t.mock.timers.runAll(); await tick()
  assert.equal(calls, 0)
  scheduler.schedule(backend.instance, "urgent", signal(backend.instance))
  backend.detach(); backend.reattach()
  t.mock.timers.runAll(); await tick()
  assert.equal(calls, 0, "a pending timer also loses authority")
  scheduler.schedule(backend.instance, "urgent", signal(backend.instance))
  t.mock.timers.runAll(); await tick()
  assert.equal(calls, 1)
  scheduler.cancel(backend.instance)
})

test("plugin controls fence queued writes and old reads, retaining visible demand for a new attachment", async t => {
  const backend = attachment(t, "demand_plugins")
  const old = deferred<PluginControlsSnapshot>(), fresh = deferred<PluginControlsSnapshot>()
  const write = deferred<{ snapshot: PluginControlsSnapshot }>()
  let reads = 0, writes = 0
  const cache = new PluginControlsCache({
    getPluginControls: async () => ++reads === 1 ? old.promise : fresh.promise,
    setPluginActivation: async () => { writes++; return write.promise as never },
  }, signal)
  const release = cache.acquireDemand(backend.instance, location)
  t.after(release)
  const first = cache.mutate(backend.instance, location, "plugin", "project", true)
  await tick()
  const queued = cache.mutate(backend.instance, location, "plugin", "project", false)
  const rejected = assert.rejects(queued)
  backend.detach(); backend.reattach()
  cache.invalidateInstance(backend.instance)
  assert.equal(reads, 2)
  fresh.resolve(snapshot("new")); await tick()
  write.resolve({ snapshot: snapshot("old-write") }); await first; await rejected
  old.resolve(snapshot("old-read")); await tick()
  assert.equal(writes, 1, "the already sent write settles, but its queued sibling never transmits")
  assert.equal(reads, 2, "old mutation causes no refresh on the replacement")
  assert.equal(cache.state(backend.instance, location).snapshot?.controls[0]?.id, "new")
})

test("plugin install receipts settle without old hints, timers or refreshes touching a new attachment", async t => {
  const backend = attachment(t, "demand_sources")
  const write = deferred<never>()
  const timers: Array<() => void> = []
  let invalidated = 0, now = 0
  const store = new PluginSourcesStore({ addPluginSource: async () => write.promise,
    removePluginSource: async () => { throw new Error("unused") }, installIntegration: async () => { throw new Error("unused") } },
  () => invalidated++, () => now, callback => { timers.push(callback) }, undefined, signal)
  const sent = store.add(backend.instance, location, "project", "plugin")
  backend.detach(); backend.reattach(); write.resolve(undefined as never)
  await sent
  assert.equal(invalidated, 0)
  assert.equal(timers.length, 0)
  assert.deepEqual(store.addedSpecs(backend.instance, location), [])
  const immediate = new PluginSourcesStore({ addPluginSource: async () => ({} as never), removePluginSource: async () => ({} as never), installIntegration: async () => ({} as never) },
    () => invalidated++, () => now, callback => { timers.push(callback) }, undefined, signal)
  await immediate.add(backend.instance, location, "project", "plugin")
  assert.equal(immediate.state(backend.instance, location, "plugin"), "pending")
  backend.detach(); backend.reattach(); now = 200_000; timers[0]()
  assert.deepEqual(immediate.addedSpecs(backend.instance, location), [])
  assert.equal(invalidated, 1)
})

test("shell admission, late lists and sent remove followups keep the captured attachment", async t => {
  const backend = attachment(t, "demand_shell")
  let calls = 0, removed = 0
  const old = deferred<never[]>(), removal = deferred<void>()
  const output = deferred<{ output: string; cursor: number; size: number; truncated: boolean }>()
  const store = createShellStore(() => ({ list: async () => { calls++; return { data: calls === 1 ? await old.promise : [] } },
    remove: async () => { removed++; await removal.promise }, output: async () => output.promise }), signal)
  const queued = store.load(backend.instance, "/queued")
  backend.detach(); backend.reattach(); await queued
  assert.equal(calls, 0, "cancel before microtask dispatch")
  const first = store.load(backend.instance, "/repo")
  await tick()
  void store.load(backend.instance, "/repo", undefined, true)
  const sent = store.remove(backend.instance, "/repo", "shell")
  const lateOutput = store.output(backend.instance, "/repo", "shell")
  const rejectedOutput = assert.rejects(lateOutput)
  backend.detach(); backend.reattach()
  await store.load(backend.instance, "/repo")
  removal.resolve(); assert.equal(await sent, true, "sent command settles its receipt")
  output.resolve({ output: "obsolete", cursor: 1, size: 1, truncated: false }); await rejectedOutput
  old.resolve([]); await first; await tick()
  assert.equal(calls, 2)
  assert.equal(removed, 1)
  assert.equal(store.getState(backend.instance, "/repo").loading, false)
})

test("permission receipt queue admission and late pagination never cross attachment lifetimes", async t => {
  registerLocalBackendFixture(t, "demand_receipts")
  const backend = attachment(t, "demand_receipts")
  const original = serverApi.fetchPermissionReceipts
  t.after(() => { serverApi.fetchPermissionReceipts = original })
  const blocker = deferred<void>(), controller = new AbortController()
  const busy = receiptReads.run(controller.signal, () => blocker.promise)
  let calls = 0
  const page = deferred<{ receipts: []; next?: string }>()
  serverApi.fetchPermissionReceipts = async () => { calls++; return calls === 1 ? page.promise : { receipts: [] } }
  const row = acquirePermissionReceipts(backend.instance, "session", { messageId: "message" }, 2)
  const rejected = assert.rejects(row.promise)
  backend.detach(); backend.reattach(); blocker.resolve(); await busy; await rejected
  assert.equal(calls, 0)
  const late = acquirePermissionReceipts(backend.instance, "session", { messageId: "message" }, 2)
  const lateRejected = assert.rejects(late.promise)
  await tick(); assert.equal(calls, 1)
  backend.detach(); backend.reattach()
  const fresh = acquirePermissionReceipts(backend.instance, "session", { messageId: "message" }, 2)
  assert.notEqual(fresh.promise, late.promise)
  page.resolve({ receipts: [], next: "old-cursor" }); await lateRejected; await fresh.promise
  assert.equal(calls, 2, "no old second page")
  assert.equal(cachedPermissionReceipts(permissionReceiptKey(backend.instance, "session", { messageId: "message" }))?.pages, 1)
  row.release(); late.release(); fresh.release()
})

test("a Shell view first demanded while detached is reconciled on the new open", async t => {
  const backend = attachment(t, "demand_shell_offline")
  let calls = 0
  const store = createShellStore(() => ({ list: async () => { calls++; return { data: [] } }, remove: async () => {},
    output: async () => ({ output: "", cursor: 0, size: 0, truncated: false }) }), signal)
  backend.detach()
  const release = store.watch(backend.instance, "/repo")
  t.after(release)
  await store.load(backend.instance, "/repo")
  assert.equal(calls, 0)
  backend.reattach(); store.refreshBackend("demand_shell_offline"); await tick()
  assert.equal(calls, 1)
})
