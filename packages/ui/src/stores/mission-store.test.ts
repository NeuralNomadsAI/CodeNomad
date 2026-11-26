import assert from "node:assert/strict"
import test from "node:test"

import { listedMissionStore, type MissionListing } from "./mission-store.test-fixture"

type Listed = Extract<MissionListing, { available: true }>
const available = (objective: string): Listed => ({
  available: true,
  projectID: "project-1",
  generatedAt: 10,
  discardedEvents: 0,
  missions: [{
    version: 1,
    id: `mission-${objective}`,
    projectID: "project-1",
    projectCanonical: "/repo",
    excerpt: objective,
    template: "custom",
    status: "active",
    coordinatorSessionId: "session-1",
    actors: [],
    tasks: [],
    reports: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    history: [],
    historyTruncated: false,
  }],
})

test("a refresh publishes new objects only for the missions it changed", async () => {
  // The owner hands over the same map until its header changes.
  const a = available("a").missions[0]!, b = available("b").missions[0]!
  const two = (second = b): Listed => ({ ...available("a"), missions: [a, second] })
  const responses = [two(), two(), two({ ...b, revision: 2 })]
  const store = listedMissionStore(() => responses.shift()!)
  await store.refresh("instance-1")
  const first = store.state("instance-1")
  await store.refresh("instance-1")
  const same = store.state("instance-1")
  assert.equal(same.missions, first.missions, "an identical read keeps the published maps")
  assert.equal(same.summaries, first.summaries)
  await store.refresh("instance-1")
  const changed = store.state("instance-1")
  assert.notEqual(changed.missions, first.missions)
  assert.equal(changed.missions[0], first.missions[0], "the unchanged mission keeps its object")
  assert.notEqual(changed.missions[1], first.missions[1])
  assert.equal(changed.missions[1]!.revision, 2)
  assert.equal(changed.summaries[0], first.summaries[0], "the unchanged row keeps its object")
})

test("loads the rows and their adopted maps, and represents optional unavailability", async () => {
  const responses: MissionListing[] = [available("first"), { available: false, reason: "plugin-unavailable" }]
  const store = listedMissionStore(() => responses.shift()!)
  await store.ensure("instance-1")
  assert.equal(store.state("instance-1").status, "ready")
  assert.equal(store.state("instance-1").missions[0]?.excerpt, "first")
  assert.deepEqual(store.state("instance-1").summaries.map(row => row.id), ["mission-first"])
  assert.equal(store.state("instance-1").generatedAt, 10)
  await store.refresh("instance-1")
  assert.deepEqual(store.state("instance-1"), {
    status: "unavailable",
    missions: [],
    summaries: [],
    reason: "plugin-unavailable",
  })
})

test("pending cleanup identities stay through a failed read and through unavailability", async () => {
  const cleanup = { missionID: "msn_deleted", deletionID: "evt_deleted", requestID: "original-request", expectedRevision: 7,
    deleteManagedSessions: true, objective: "Deleted mission", removed: 1, retained: 0, pending: 1, documentPending: false, reasons: [], createdAt: 1 }
  let answer: "listed" | "offline" | "unavailable" = "listed"
  const store = listedMissionStore(async () => {
    if (answer === "offline") throw new Error("offline")
    return answer === "unavailable" ? { available: false, reason: "plugin-unavailable" } : { ...available("first"), cleanups: [cleanup] }
  })
  await store.ensure("instance-1")
  assert.deepEqual(store.state("instance-1").cleanups, [cleanup])
  answer = "offline"; await store.refresh("instance-1")
  assert.equal(store.state("instance-1").status, "error")
  assert.equal(store.state("instance-1").cleanups![0].requestID, "original-request")
  answer = "unavailable"; await store.refresh("instance-1")
  assert.deepEqual([store.state("instance-1").cleanups![0].requestID, store.state("instance-1").cleanupUnavailable], ["original-request", true])
})

test("wanting a mission reads nothing: its owner reads and adopts the map", async () => {
  let reads = 0
  const store = listedMissionStore(() => { reads++; return available("open") })
  await store.ensure("instance-1")
  store.want("instance-1", "selection", "mission-closed")
  store.want("instance-1", "reader", "mission-open", true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(reads, 1)
  assert.deepEqual(store.demandedInstanceIds(), ["instance-1"], "a reader owns demand without a panel")
})

test("coalesces an in-flight invalidation into one trailing refresh", async () => {
  const resolvers: Array<(value: MissionListing) => void> = []
  const store = listedMissionStore(() => new Promise<MissionListing>(resolve => resolvers.push(resolve)))
  const first = store.refresh("instance-1")
  const trailing = store.refresh("instance-1")
  assert.equal(resolvers.length, 1)
  resolvers[0](available("first"))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(resolvers.length, 2)
  resolvers[1](available("current"))
  await Promise.all([first, trailing])
  assert.equal(store.state("instance-1").missions[0]?.excerpt, "current")
})

test("tracks visible demand independently from cached snapshots", async () => {
  const store = listedMissionStore(() => available("cached"))
  await store.ensure("instance-1")
  assert.deepEqual(store.trackedInstanceIds(), ["instance-1"])
  assert.deepEqual(store.demandedInstanceIds(), [])
  store.setDemand("instance-1", true)
  assert.deepEqual(store.demandedInstanceIds(), ["instance-1"])
  store.setDemand("instance-1", false)
  assert.deepEqual(store.demandedInstanceIds(), [])
})

test("hiding the panel cancels a queued trailing read but preserves the current cached response", async () => {
  let resolve!: (value: MissionListing) => void
  let requests = 0
  const store = listedMissionStore(() => { requests += 1; return new Promise<MissionListing>(done => { resolve = done }) })
  store.setDemand("instance-1", true)
  const first = store.refresh("instance-1")
  const trailing = store.refresh("instance-1")
  store.setDemand("instance-1", false)
  resolve(available("cached"))
  await Promise.all([first, trailing])
  assert.equal(requests, 1)
  assert.equal(store.state("instance-1").missions[0]?.excerpt, "cached")
  assert.deepEqual(store.demandedInstanceIds(), [])
})

test("fences a late response after the workspace is cleared", async () => {
  let resolve!: (value: MissionListing) => void
  const store = listedMissionStore(() => new Promise<MissionListing>(done => { resolve = done }))
  const pending = store.refresh("instance-1")
  store.clear("instance-1")
  resolve(available("late"))
  await pending
  assert.equal(store.state("instance-1").status, "idle")
  assert.deepEqual(store.state("instance-1").missions, [])
})

test("preserves the last map through transient errors and clears stopped workspaces", async () => {
  let fail = false
  const store = listedMissionStore(async () => {
    if (fail) throw new Error("offline")
    return available("durable")
  })
  await store.refresh("instance-1")
  fail = true
  await store.refresh("instance-1")
  assert.equal(store.state("instance-1").status, "error")
  assert.equal(store.state("instance-1").missions[0]?.excerpt, "durable")
  store.clear("instance-1")
  assert.equal(store.state("instance-1").status, "idle")
})
