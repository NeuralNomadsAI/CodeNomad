import assert from "node:assert/strict"
import { test } from "node:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { createMissionStore, type MissionRowsResponse } from "./mission-store"
import { createMissionPanelInventory } from "./mission-panel-inventory"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve }
}
const response = (projectID: string): MissionRowsResponse => ({ available: true, projectID, generatedAt: 1, discardedEvents: 0, summaries: [] })

for (const retire of ["clear", "invalidateTasks"] as const)
test(`${retire} admits a new same-attachment read and old settlement preserves its busy owner`, async () => {
  const reads = [deferred<MissionRowsResponse>(), deferred<MissionRowsResponse>()]
  const attachment = new AbortController()
  let calls = 0
  const store = createMissionStore(() => reads[calls++].promise, undefined, () => attachment.signal)
  const old = store.refresh("east~workspace")
  store[retire]("east~workspace")
  const replacement = store.refresh("east~workspace")
  assert.equal(calls, 2)
  reads[0].resolve(response("obsolete")); await old
  assert.equal(store.state("east~workspace").status, "loading")
  assert.equal(store.state("east~workspace").projectID, undefined)
  reads[1].resolve(response("current")); await replacement
  assert.equal(store.state("east~workspace").status, "ready")
  assert.equal(store.state("east~workspace").projectID, "current")
  assert.equal(calls, 2, "old settlement starts no trailing read")
})

for (const replacement of ["attachment", "invalidation"] as const)
test(`panel ${replacement} admits fresh lanes before obsolete lanes settle`, async () => {
  let attachment = new AbortController()
  const reads: { reject(error: Error): void }[] = []
  const store = createMissionPanelInventory({ scope: () => "east-project", signal: () => attachment.signal,
    tasks: async () => { throw new Error("unexpected tasks") },
    read: () => new Promise((_resolve, reject) => { reads.push({ reject }) }) })
  try {
    store.setDemand("east~workspace", true)
    const old = store.ensure("east~workspace")
    await new Promise<void>(resolve => setImmediate(resolve))
    const count = reads.length
    assert.ok(count > 0)
    if (replacement === "attachment") { attachment.abort(); attachment = new AbortController() }
    else store.invalidateTasks("east~workspace")
    const fresh = store.refresh("east~workspace")
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(reads.length, count * 2, "replacement never waits for revoked pending lanes")
    for (const read of reads.slice(0, count)) read.reject(new Error("obsolete"))
    await old
    assert.equal(store.reading("east~workspace"), true, "old finally cannot clear replacement loading")
    for (const read of reads.slice(count)) read.reject(new Error("current"))
    await fresh
    assert.equal(store.reading("east~workspace"), false)
    assert.match(store.state("east~workspace").error!, /current/)
  } finally { store.clear("east~workspace") }
})

test("mission inventory shares one projection across readers of a large family", async () => {
  const instanceId = "panel-family", other = "panel-other", projectID = "project"
  const missions = Array.from({ length: 16 }, (_, i) => `mission-${i}`)
  const order = "a".repeat(43)
  const window = (total: number) => ({ offset: 0, end: total, total, order })
  const flags = { discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }
  let observedAt = 1
  const store = createMissionPanelInventory({
    scope: id => id,
    tasks: async () => { throw new Error("unexpected task read") },
    read: async (_id, selector) => {
      const envelope = { available: true as const, version: 1 as const, projectID, source: selector.source, ...flags,
        page: { digest: order, total: 0, pieces: [] }, window: window(0) }
      if (selector.source === "summaries") {
        return { envelope: { ...envelope, window: window(missions.length), finishHighWater: 0 },
          values: missions.map(id => ({ id, objective: id, status: "active", actorCount: 1, updatedAt: 1, revision: 1, coordinatorSessionId: `root-${id}` })) }
      }
      if (selector.source === "marks") {
        const observations = missions.map(id => {
          const root = `root-${id}`
          return {
            context: { id, projectID, revision: 1, status: "active", coordinatorSessionId: root,
              actors: [{ sessionId: root, title: root, location: { directory: "/fixture" }, reportOwed: false, callOpen: false }], actorPage: window(1), ...flags },
            coverage: "observed", requests: { state: "observed", items: [] },
            activity: { actors: [{ sessionId: root, state: "running" }], family: { state: "observed",
              members: Array.from({ length: 33 }, (_, i) => ({ sessionId: `${root}-child-${i}`, actorSessionId: root, kind: "ordinary" })) } },
          }
        })
        return { envelope: { ...envelope, window: undefined, phase: "observed", observedAt }, values: [{ observations, missionPage: window(missions.length) }] }
      }
      return { envelope, values: [] }
    },
  })
  try {
    store.setDemand(instanceId, true)
    await store.ensure(instanceId)
    await store.more(instanceId, "marks", true)
    assert.equal(store.state(instanceId).activity?.missions.length, missions.length)
    createRoot(dispose => {
      try {
        const [pulse, publish] = createSignal(0)
        const projections = new Set<unknown>()
        for (let i = 0; i < 40; i++) createMemo(() => { pulse(); projections.add(store.state(instanceId).activity) })
        for (let i = 1; i <= 3; i++) publish(i)
        assert.equal(projections.size, 1, "160 reads of unchanged activity must use one retained projection")
      } finally { dispose() }
    })
    const cached = store.state(instanceId)
    await store.ensure(other)
    assert.equal(store.state(instanceId), cached, "another panel's publication keeps the original projection")
    observedAt++
    await store.more(instanceId, "marks", true)
    assert.equal(store.state(instanceId).activity?.generatedAt, observedAt)
    store.invalidateTasks(instanceId)
    assert.equal(store.state(instanceId).activity?.missions[0]?.actors[0]?.state, "unknown")
  } finally {
    store.clear(instanceId)
    store.clear(other)
  }
})
