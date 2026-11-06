import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot, createSignal } from "solid-js"
import { backendEvents } from "../lib/backend-events"
import { captureBackendOperation } from "../lib/backend-operation"
import { serverApi } from "../lib/api-client"
import { PluginControlsCache } from "./plugin-controls"
import { createShellStore } from "./shell-store"
import { createSessionGoalStore } from "./session-goal-store"
import { createIntegrationBindingsStore } from "./integration-bindings-store"
import { createMissionStore } from "./mission-store"
import { createSessionOutline } from "./session-outline"
import { setSessions } from "./session-state"
import type { MissionListResponse, PluginControlsSnapshot } from "../../../server/src/api-types"

// Audited ownership families (source / flag / owner / terminal cleanup):
// plugin-controls / loading,refreshing,inFlight / record + promise / finally or attachment rebind
// shell-store / loading,requests.dirty / request object / identity-checked finally
// session-goal-store, integration-bindings-store / busy / admitted command / exclusive finally
// integrations-store, session-goal-store, integration-bindings-store / reading / reading object / cancel + finally
// mission-store / status,taskReads.loading / refresh generation + counted task lifetime / finally + clear
// mission-panel-inventory / lanes.loading,pending,headerReads / operation or job / identity-checked finally
// mission-content-store, mission-recurrence / controller / controller identity / cancel + finally
// mission-schedules / loading,controller / effect epoch + controller / effect reset + finally
// mission-task-session-reads / inFlight / flight object / identity-checked finally
// session-actions / pendingNewSessions,technicalPartUpdates / attempt promise / identity-checked finally
// session-actions / modelSelectionPending / optimistic model object / releasePending on aborted settlement
// session-action-queue, session-instructions, session-model-reconciliation / admissions,running,pending / promise or state / finally
// instances / volatile refresh,pending sync,liveness / state,promise,token / identity-checked abort + finally
// worktrees / requests,reads,readyRefreshes,pendingFamilyMoveSlugs / task promise / identity-checked abort + finally
// session-events, session-pruning-events / pendingSessionFetches,refreshing / state object / identity-checked finally
// session-state / automaticCleanupRequests / request object / identity-checked finally
// session-cleanup-progress / jobs(controller,phase,count) / exclusive job / caller's unconditional finally
// session-outline / pending / reactive effect + controller / inactive effect reset; current-only finally
// history-search-sessions / running,queue,requested / owner object / owner-checked finally + restart
// permission-receipt-cache / reads / read object / release + identity-checked finally
// plugin-sources, plugin-package-actions / removing,pending / exclusive admitted mutation / unconditional finally
// opencode-data / transcript read,settlement,replay / transcript epoch / owner cleanup + projection disposal
// opencode-setup / checking,busy / pending identity,exclusive action / finally (local setup, not attachment-scoped)
// instance-config, preferences, session-previews / loadPromises,pending preferences,restorePromises / local storage lane / finally
// speech,conversation-speech,desktop-updates / loading,runner,installing / local host/playback lane / finally or host event
// sidecars / sidecarsLoading,loadPromise / exclusive local list / success + rejection handlers
// Durable exclusions: session working/compaction, generation admission after dispatch, inbox/permission/form receipts,
// plugin install-confirmation hints, mission holds/intents, uncertain family moves, restore/UI demand and frame queues.
// session-api owns fetching/creating/deleting/loadingMessages/search; its regression coverage is separate.

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const location = { directory: "/repo" }
const snapshot = (id: string) => ({ location, runtime: [], configured: { rules: [], sources: [] }, targets: [],
  controls: [{ id }] }) as unknown as PluginControlsSnapshot
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const source = { on: () => () => {}, onOpen: () => () => {}, onDispose: () => () => {}, onTransportStatus: () => () => {} }
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(check(), true, "expected production request to dispatch")
}

for (const populated of [false, true]) for (const failure of [false, true]) for (const replacement of [false, true]) {
  test(`plugin flags: ${populated ? "refreshing" : "loading"}, ${failure ? "failure" : "success"}, B=${replacement}`, async t => {
    const backendId = `indicator_plugin_${populated}_${failure}_${replacement}`, instanceId = `${backendId}~ws`
    let detach = backendEvents.attach(backendId, source)
    t.after(() => detach())
    const requests: ReturnType<typeof deferred<PluginControlsSnapshot>>[] = []
    const api = { getPluginControls: () => { const gate = deferred<PluginControlsSnapshot>(); requests.push(gate); return gate.promise },
      setPluginActivation: async () => { throw new Error("unused mutation") } }
    const cache = new PluginControlsCache(api, id => captureBackendOperation(id).signal)
    t.after(() => { for (const gate of requests) gate.resolve(snapshot("cleanup")) })
    if (populated) {
      const seed = cache.load(instanceId, location)
      requests[0].resolve(snapshot("retained")); await seed
    }
    const first = cache.load(instanceId, location, { force: true }), old = requests.at(-1)!
    assert.equal(cache.state(instanceId, location)[populated ? "refreshing" : "loading"], true)
    detach(); detach = backendEvents.attach(backendId, source)
    // A payload-free invalidation rebinds a retained cache even without visible demand.
    cache.invalidateInstance(instanceId)
    const second = replacement ? cache.load(instanceId, location) : undefined
    if (failure) old.reject(new Error("late A failure")); else old.resolve(snapshot("obsolete"))
    await first
    const state = cache.state(instanceId, location)
    assert.equal(state.loading, !populated && replacement, "A cannot leave loading stuck or clear B")
    assert.equal(state.refreshing, populated && replacement, "A cannot leave refreshing stuck or clear B")
    assert.equal(state.snapshot?.controls[0].id, populated ? "retained" : undefined)
    assert.equal(state.error, undefined, "revoked failure is not a current error")
    assert.equal(requests.length, Number(populated) + 1 + Number(replacement), "no replay")
    if (second) {
      requests.at(-1)!.resolve(snapshot("fresh")); await second
      assert.equal(cache.state(instanceId, location).loading, false)
      assert.equal(cache.state(instanceId, location).refreshing, false)
    }
  })
}

test("plugin rebind preserves B admitted synchronously by A's abort listener", async t => {
  const instanceId = "indicator_reentrant~ws"
  let attachment = new AbortController().signal
  const old = deferred<PluginControlsSnapshot>(), fresh = deferred<PluginControlsSnapshot>()
  let reads = 0, first!: Promise<void>, second: Promise<void> | undefined
  const cache = new PluginControlsCache({
    getPluginControls: (_id, _location, signal) => {
      if (++reads === 1) {
        signal!.addEventListener("abort", () => { second = cache.load(instanceId, location) }, { once: true })
        return old.promise
      }
      return fresh.promise
    },
    setPluginActivation: async () => { throw new Error("mutation failure") },
  }, () => attachment)
  const release = cache.acquireDemand(instanceId, location)
  t.after(() => { release(); old.resolve(snapshot("cleanup")); fresh.resolve(snapshot("cleanup")) })
  first = cache.load(instanceId, location)
  attachment = new AbortController().signal
  await assert.rejects(cache.mutate(instanceId, location, "plugin", "global", true), /mutation failure/)
  assert.ok(second, "rebinding aborts A and its listener explicitly admits B")
  assert.equal(reads, 2, "retained visible demand adds no implicit IO")
  assert.equal(cache.state(instanceId, location).loading, true, "outer rebind must not erase B")
  old.resolve(snapshot("obsolete")); await first
  assert.equal(cache.state(instanceId, location).snapshot, undefined, "A cannot publish")
  assert.equal(cache.state(instanceId, location).loading, true, "A's finally cannot release B")
  await tick()
  assert.equal(reads, 2)
  assert.equal(cache.state(instanceId, location).loading, true)
  fresh.resolve(snapshot("fresh")); await second
  assert.equal(cache.state(instanceId, location).loading, false)
  assert.equal(cache.state(instanceId, location).snapshot?.controls[0].id, "fresh")
  assert.equal(reads, 2)
})

for (const populated of [false, true]) {
  test(`plugin rebind publishes released ${populated ? "refreshing" : "loading"} even when a mutation fails`, async t => {
    const backendId = `indicator_rebind_${populated}`, instanceId = `${backendId}~ws`
    let detach = backendEvents.attach(backendId, source)
    t.after(() => detach())
    const gate = deferred<PluginControlsSnapshot>()
    let reads = 0
    const cache = new PluginControlsCache({
      getPluginControls: async () => { reads++; return populated && reads === 1 ? snapshot("retained") : gate.promise },
      setPluginActivation: async () => { throw new Error("mutation failure") },
    }, id => captureBackendOperation(id).signal)
    if (populated) await cache.load(instanceId, location)
    const first = cache.load(instanceId, location, { force: true })
    detach(); detach = backendEvents.attach(backendId, source)
    await assert.rejects(cache.mutate(instanceId, location, "plugin", "global", true), /mutation failure/)
    assert.equal(cache.state(instanceId, location).loading, false, "rebinding publishes ownership release itself")
    assert.equal(cache.state(instanceId, location).refreshing, false)
    assert.equal(cache.state(instanceId, location).stale, true)
    assert.equal(reads, Number(populated) + 1, "rebinding alone never starts a read")
    gate.resolve(snapshot("obsolete")); await first
    assert.equal(cache.state(instanceId, location).snapshot?.controls[0].id, populated ? "retained" : undefined)
  })
}

for (const failure of [false, true]) for (const replacement of [false, true]) {
  test(`shell loading: revoked ${failure ? "failure" : "success"}, B=${replacement}`, async t => {
    const backendId = `indicator_shell_${failure}_${replacement}`, instanceId = `${backendId}~ws`
    let detach = backendEvents.attach(backendId, source)
    t.after(() => detach())
    const requests: ReturnType<typeof deferred<any[]>>[] = []
    const api = { list: () => { const gate = deferred<any[]>(); requests.push(gate); return gate.promise },
      remove: async () => {}, output: async () => ({ output: "", cursor: 0, size: 0, truncated: false }) }
    const store = createShellStore(() => api, id => captureBackendOperation(id).signal)
    const first = store.load(instanceId, "/repo"); await tick()
    assert.equal(store.getState(instanceId, "/repo").loading, true)
    detach(); detach = backendEvents.attach(backendId, source)
    const second = replacement ? store.load(instanceId, "/repo") : undefined
    await tick()
    if (failure) requests[0].reject(new Error("late failure")); else requests[0].resolve([{ id: "obsolete" }])
    await first
    assert.equal(store.getState(instanceId, "/repo").loading, replacement)
    assert.deepEqual(store.getState(instanceId, "/repo").items, [])
    assert.equal(store.getState(instanceId, "/repo").failed, false)
    if (second) { requests[1].resolve([]); await second }
    assert.equal(store.getState(instanceId, "/repo").loading, false)
  })
}

for (const kind of ["goal", "binding"] as const) for (const failure of [false, true]) {
  test(`${kind} command busy: revoked ${failure ? "failure" : "success"} releases exclusive admission`, async t => {
    const backendId = `indicator_${kind}_${failure}`, instanceId = `${backendId}~ws`
    let detach = backendEvents.attach(backendId, source)
    t.after(() => detach())
    const goal = createSessionGoalStore(async () => ({ status: "unavailable" }), { signal: id => captureBackendOperation(id).signal })
    const binding = createIntegrationBindingsStore(async () => ({ state: "unknown" }), { signal: target => captureBackendOperation(target.instanceId).signal })
    const target = { instanceId, directory: "/repo", sessionID: "session", integrationId: "integration" }
    const busy = () => kind === "goal" ? goal.busy(instanceId, "session") : binding.busy(target)
    const run = (command: () => Promise<void>) => kind === "goal" ? goal.run(instanceId, "session", command) : binding.run(target, command)
    const gate = deferred<void>()
    const first = run(() => gate.promise)
    const observed = failure ? assert.rejects(first, /late failure/) : first
    assert.equal(busy(), true)
    detach(); detach = backendEvents.attach(backendId, source)
    let secondCalls = 0
    await run(async () => { secondCalls++ })
    assert.equal(secondCalls, 0, "admitted command keeps exclusivity until settlement; B cannot own its flag")
    if (failure) gate.reject(new Error("late failure")); else gate.resolve()
    await observed
    assert.equal(busy(), false)
    const secondGate = deferred<void>(), second = run(() => secondGate.promise)
    assert.equal(busy(), true)
    await tick(); assert.equal(busy(), true, "settled A cannot clear newly admitted B")
    secondGate.resolve(); await second
    assert.equal(busy(), false)
  })
}

for (const failure of [false, true]) for (const replacement of [false, true]) {
  test(`Mission list status: revoked ${failure ? "failure" : "success"}, B=${replacement}`, async t => {
    const backendId = `indicator_mission_${failure}_${replacement}`, instanceId = `${backendId}~ws`
    let detach = backendEvents.attach(backendId, source)
    t.after(() => detach())
    const requests: ReturnType<typeof deferred<MissionListResponse>>[] = []
    const store = createMissionStore(async () => {
      const gate = deferred<MissionListResponse>(); requests.push(gate); return gate.promise
    }, undefined, false, id => captureBackendOperation(id).signal)
    const answer: MissionListResponse = { available: true, version: 1, projectID: "project", generatedAt: 1,
      discardedEvents: 0, missions: [], activity: { generatedAt: 1, missions: [] } }
    const first = store.refresh(instanceId)
    assert.equal(store.state(instanceId).status, "loading")
    detach(); detach = backendEvents.attach(backendId, source)
    const second = replacement ? store.refresh(instanceId) : undefined
    if (failure) requests[0].reject(new Error("late failure")); else requests[0].resolve(answer)
    await first
    assert.equal(store.state(instanceId).status, replacement ? "loading" : "idle")
    assert.equal(store.state(instanceId).projectID, undefined, "obsolete list cannot publish")
    if (second) { requests[1].resolve(answer); await second }
    assert.notEqual(store.state(instanceId).status, "loading")
  })

  test(`outline pending: revoked ${failure ? "failure" : "success"}, B=${replacement}`, async t => {
    const backendId = `indicator_outline_${failure}_${replacement}`, instanceId = `${backendId}~ws`
    let detach = backendEvents.attach(backendId, source)
    const original = serverApi.fetchSessionOutline
    const requests: ReturnType<typeof deferred<any>>[] = []
    const [active, setActive] = createSignal(true)
    let dispose!: () => void
    serverApi.fetchSessionOutline = async () => { const gate = deferred<any>(); requests.push(gate); return gate.promise }
    setSessions(previous => new Map(previous).set(instanceId, new Map([["s", { id: "s", status: "idle",
      projectID: "project", location: { directory: "/repo" } } as any]])))
    t.after(() => {
      dispose(); detach(); serverApi.fetchSessionOutline = original
      for (const gate of requests) gate.resolve({ status: "outline", entries: [], checkpoints: [], total: 0, cursor: null })
      setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
    })
    const outline = createRoot(cleanup => {
      dispose = cleanup
      return createSessionOutline({ instanceId: () => instanceId, sessionId: () => "s", active })
    })
    await until(() => requests.length === 1)
    assert.equal(outline.pending(), true)
    if (!replacement) setActive(false)
    detach(); detach = backendEvents.attach(backendId, source)
    if (replacement) await until(() => requests.length === 2)
    if (failure) requests[0].reject(new Error("late failure"))
    else requests[0].resolve({ status: "outline", entries: [], checkpoints: [], total: 0, cursor: null })
    await tick()
    assert.equal(outline.pending(), replacement, "reactive cleanup releases A without touching B")
    assert.equal(outline.error(), "")
    if (replacement) {
      requests[1].resolve({ status: "outline", entries: [], checkpoints: [], total: 0, cursor: null })
      await until(() => !outline.pending())
    }
  })
}
