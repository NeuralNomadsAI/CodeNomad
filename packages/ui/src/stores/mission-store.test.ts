import assert from "node:assert/strict"
import test from "node:test"

import { createEffect, createRoot, onCleanup } from "solid-js"
import type { MissionListResponse } from "../../../server/src/api-types"
import { createMissionStore } from "./mission-store"

const available = (objective: string): MissionListResponse => ({
  available: true,
  version: 1,
  projectID: "project-1",
  generatedAt: 10,
  discardedEvents: 0,
  activity: { generatedAt: 11, missions: [{ missionId: `mission-${objective}`, actors: [] }] },
  missions: [{
    version: 1,
    id: `mission-${objective}`,
    projectID: "project-1",
    projectCanonical: "/repo",
    objective,
    template: "custom",
    status: "active",
    coordinatorSessionId: "session-1",
    actors: [],
    tasks: [],
    reports: [],
    frontier: [],
    claims: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    history: [],
    historyTruncated: false,
  }],
})

test("loads durable mission snapshots and represents optional unavailability", async () => {
  const responses: MissionListResponse[] = [
    available("first"),
    { available: false, reason: "plugin-unavailable", missions: [] },
  ]
  const store = createMissionStore(async () => responses.shift()!)
  await store.ensure("instance-1")
  assert.equal(store.state("instance-1").status, "ready")
  assert.equal(store.state("instance-1").missions[0]?.objective, "first")
  assert.equal(store.state("instance-1").activity?.generatedAt, 11)
  await store.refresh("instance-1")
  assert.deepEqual(store.state("instance-1"), {
    status: "unavailable",
    missions: [],
    summaries: [],
    reason: "plugin-unavailable",
  })
})

test("retains authoritative pending cleanup identities across passive failures and replaces them only on a successful read", async () => {
  const initial = available("first")
  if (!initial.available) throw new Error("fixture")
  const cleanup = { missionID: "msn_deleted", deletionID: "evt_deleted", requestID: "original-request", expectedRevision: 7,
    deleteManagedSessions: true, objective: "Deleted mission", removed: 1, retained: 0, pending: 1, reasons: [], createdAt: 1 }
  initial.cleanups = [cleanup]
  let fail = false
  const store = createMissionStore(async () => { if (fail) throw new Error("offline"); return initial })
  await store.ensure("instance-1")
  assert.deepEqual(store.state("instance-1").cleanups, [cleanup])
  fail = true; await store.refresh("instance-1")
  assert.equal(store.state("instance-1").cleanups![0].requestID, "original-request")
  assert.equal(store.state("instance-1").cleanups![0].pending, 1)
  fail = false; initial.cleanups = []; initial.cleanupUnavailable = true
  await store.refresh("instance-1")
  assert.equal(store.state("instance-1").cleanups![0].pending, 1)
  assert.equal(store.state("instance-1").cleanupUnavailable, true)
  delete initial.cleanupUnavailable; initial.cleanups = [{ ...cleanup, pending: 0, removed: 2 }]
  await store.refresh("instance-1")
  assert.equal(store.state("instance-1").cleanups![0].pending, 0)
})

const row = (id: string, status: "active" | "completed" = "completed") => ({ id, objective: id, status, coordinatorSessionId: "session-1",
  actorSessionIds: ["session-1"], updatedAt: 1, revision: 1 })

test("a summaries backend gets the wanted maps and the held version; rows survive an omitted list", async () => {
  const open = available("open")
  if (!open.available) throw new Error("fixture")
  const closed = { ...open.missions[0], id: "mission-closed", objective: "closed", status: "completed" as const }
  const requests: unknown[] = []
  const responses: MissionListResponse[] = [
    { ...open, summaries: [row("mission-open", "active"), row("mission-closed")], summariesVersion: "v1" },
    { ...open, missions: [...open.missions, closed], summariesVersion: "v1" },
    { ...open, summariesVersion: "v1" },
  ]
  const store = createMissionStore(async (_instanceId, request) => { requests.push(request); return responses.shift()! })
  store.want("instance-1", "selection", "mission-closed")
  await store.ensure("instance-1")
  // The first read cannot know the backend lists summaries; the follow-up asks for the selection.
  assert.deepEqual(requests, [{}, { include: ["mission-closed"], summariesVersion: "v1" }])
  assert.deepEqual(store.state("instance-1").missions.map(mission => mission.id), ["mission-open", "mission-closed"])
  assert.deepEqual(store.state("instance-1").summaries.map(value => value.id), ["mission-open", "mission-closed"], "the held rows answer an omitted list")
  // Releasing the selection drops it from the next read; a held map needs no extra read.
  store.want("instance-1", "selection", undefined)
  await store.refresh("instance-1")
  assert.deepEqual(requests.at(-1), { summariesVersion: "v1" })
  assert.deepEqual(store.state("instance-1").missions.map(mission => mission.id), ["mission-open"])
  assert.equal(requests.length, 3)
})

test("wanting a closed row reads it once; a full-snapshot backend never receives includes", async () => {
  const open = available("open")
  if (!open.available) throw new Error("fixture")
  const requests: unknown[] = []
  let summaries = true
  const store = createMissionStore(async (_instanceId, request) => {
    requests.push(request)
    return summaries ? { ...open, summaries: [row("mission-open", "active"), row("mission-closed")], summariesVersion: "v1" } : open
  })
  await store.refresh("instance-1")
  store.want("instance-1", "reader", "mission-closed")
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(requests, [{}, { include: ["mission-closed"], summariesVersion: "v1" }])
  // Unknown rows and maps already held trigger nothing.
  store.want("instance-1", "reader", "mission-unknown")
  store.want("instance-1", "other", "mission-open")
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(requests.length, 2)
  summaries = false
  await store.refresh("instance-1")
  assert.deepEqual(store.state("instance-1").summaries.map(value => value.id), ["mission-open"], "a full snapshot's maps are its rows")
  assert.equal(store.state("instance-1").summariesVersion, undefined)
  await store.refresh("instance-1")
  assert.deepEqual(requests.at(-1), {})
})

test("registration inside an effect never subscribes it: a failed include read stays parked", async () => {
  const open = available("open")
  if (!open.available) throw new Error("fixture")
  for (const fail of [true, false]) {
    let reads = 0
    const store = createMissionStore(async (_instanceId, request) => {
      reads++
      await new Promise(resolve => setTimeout(resolve, 5))
      if (fail && reads > 1) throw new Error("Temporary network failure")
      const closed = { ...open.missions[0], id: "mission-closed", status: "completed" as const }
      return { ...open, missions: request.include?.includes(closed.id) ? [closed] : [], summaries: [row("mission-closed")], summariesVersion: "v1" }
    })
    await store.refresh("instance-1")
    const dispose = createRoot(dispose => {
      createEffect(() => {
        store.want("instance-1", "selection", "mission-closed")
        onCleanup(() => store.want("instance-1", "selection", undefined))
      })
      return dispose
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    dispose()
    assert.equal(reads, 2, fail ? "one failed include read, then parked" : "one include read loads the map")
    assert.equal(store.state("instance-1").status, fail ? "error" : "ready")
  }
})

/** Waits for a condition, failing (instead of hanging) after two seconds. */
async function until(condition: () => boolean, what: string) {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 2_000) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test("a response for an obsolete include keeps the current wanted map and reads it once more", async () => {
  const open = available("open")
  if (!open.available) throw new Error("fixture")
  const map = (id: string) => ({ ...open.missions[0], id, status: "completed" as const })
  const pending: Array<{ include: string[]; resolve: () => void }> = []
  const store = createMissionStore(async (_instanceId, request) => {
    const include = request.include ?? []
    if (include.length) await new Promise<void>(resolve => pending.push({ include, resolve }))
    return { ...open, missions: include.map(map), summaries: [row("A"), row("B")], summariesVersion: "v1",
      activity: { generatedAt: 1, missions: include.map(missionId => ({ missionId, actors: [] })) } }
  })
  await store.refresh("instance-1")
  store.want("instance-1", "selection", "A")
  await until(() => pending.length > 0, "A's read")
  pending.shift()!.resolve()
  await until(() => store.state("instance-1").missions.some(mission => mission.id === "A"), "A's map")
  store.want("instance-1", "selection", "B")
  await until(() => pending.length > 0, "B's read")
  store.want("instance-1", "selection", "A")
  pending.shift()!.resolve()
  await until(() => pending.length > 0, "A's follow-up")
  // B's answer is published, A's loaded map and activity stay while its follow-up runs.
  assert.deepEqual(store.state("instance-1").missions.map(mission => mission.id).sort(), ["A", "B"])
  assert.deepEqual(store.state("instance-1").activity?.missions.map(item => item.missionId).sort(), ["A", "B"])
  assert.deepEqual(pending[0].include, ["A"])
  pending.shift()!.resolve()
  await until(() => store.state("instance-1").status === "ready", "the follow-up's answer")
  assert.deepEqual(store.state("instance-1").missions.map(mission => mission.id), ["A"])
  assert.equal(pending.length, 0)
})

test("a reader without panel demand gets its follow-up; a deactivation during a read cancels it", async () => {
  const open = available("open")
  if (!open.available) throw new Error("fixture")
  const requests: unknown[] = []
  let hide: (() => void) | undefined
  const store = createMissionStore(async (_instanceId, request) => {
    requests.push(request)
    hide?.()
    const closed = { ...open.missions[0], id: "mission-closed", status: "completed" as const }
    return { ...open, missions: request.include?.includes(closed.id) ? [closed] : [], summaries: [row("mission-closed")], summariesVersion: "v1" }
  })
  // Restored reader, panel never shown: the first answer names the row, one follow-up reads it.
  store.want("instance-1", "reader", "mission-closed")
  await store.ensure("instance-1")
  assert.deepEqual(requests, [{}, { include: ["mission-closed"], summariesVersion: "v1" }])
  assert.equal(store.state("instance-1").missions.some(mission => mission.id === "mission-closed"), true)
  // The panel shows then hides while a read for another selection runs.
  store.setDemand("instance-1", true)
  store.want("instance-1", "reader", undefined)
  store.want("instance-1", "selection", "mission-other")
  hide = () => { store.want("instance-1", "selection", "mission-closed"); store.setDemand("instance-1", false); hide = undefined }
  await store.refresh("instance-1")
  assert.equal(requests.length, 3, "the cancelled follow-up does not run")
})

test("an omitted list this view does not hold fails like any read, keeping the last good display", async () => {
  const open = available("open")
  if (!open.available) throw new Error("fixture")
  const store = createMissionStore(async () => ({ ...open, summariesVersion: "v2" }))
  await store.refresh("instance-1")
  assert.equal(store.state("instance-1").status, "error")
  assert.deepEqual(store.state("instance-1").summaries, [])
})

test("coalesces an in-flight invalidation into one trailing refresh", async () => {
  const resolvers: Array<(value: MissionListResponse) => void> = []
  const store = createMissionStore(() => new Promise((resolve) => resolvers.push(resolve)))
  const first = store.refresh("instance-1")
  const trailing = store.refresh("instance-1")
  assert.equal(resolvers.length, 1)
  resolvers[0](available("first"))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(resolvers.length, 2)
  resolvers[1](available("current"))
  await Promise.all([first, trailing])
  assert.equal(store.state("instance-1").missions[0]?.objective, "current")
})

test("tracks visible demand independently from cached snapshots", async () => {
  const store = createMissionStore(async () => available("cached"))
  await store.ensure("instance-1")
  assert.deepEqual(store.trackedInstanceIds(), ["instance-1"])
  assert.deepEqual(store.demandedInstanceIds(), [])
  store.setDemand("instance-1", true)
  assert.deepEqual(store.demandedInstanceIds(), ["instance-1"])
  store.setDemand("instance-1", false)
  assert.deepEqual(store.demandedInstanceIds(), [])
})

test("hiding the panel cancels a queued trailing read but preserves the current cached response", async () => {
  let resolve!: (value: MissionListResponse) => void
  let requests = 0
  const store = createMissionStore(() => { requests += 1; return new Promise(done => { resolve = done }) })
  store.setDemand("instance-1", true)
  const first = store.refresh("instance-1")
  const trailing = store.refresh("instance-1")
  store.setDemand("instance-1", false)
  resolve(available("cached"))
  await Promise.all([first, trailing])
  assert.equal(requests, 1)
  assert.equal(store.state("instance-1").missions[0]?.objective, "cached")
  assert.deepEqual(store.demandedInstanceIds(), [])
})

test("fences a late response after the workspace is cleared", async () => {
  let resolve!: (value: MissionListResponse) => void
  const store = createMissionStore(() => new Promise(done => { resolve = done }))
  const pending = store.refresh("instance-1")
  store.clear("instance-1")
  resolve(available("late"))
  await pending
  assert.equal(store.state("instance-1").status, "idle")
  assert.deepEqual(store.state("instance-1").missions, [])
})

test("preserves the last map through transient errors and clears stopped workspaces", async () => {
  let fail = false
  const store = createMissionStore(async () => {
    if (fail) throw new Error("offline")
    return available("durable")
  })
  await store.refresh("instance-1")
  fail = true
  await store.refresh("instance-1")
  assert.equal(store.state("instance-1").status, "error")
  assert.equal(store.state("instance-1").missions[0]?.objective, "durable")
  store.clear("instance-1")
  assert.equal(store.state("instance-1").status, "idle")
})
