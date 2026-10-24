import assert from "node:assert/strict"
import test from "node:test"

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
