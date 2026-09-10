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
  await store.refresh("instance-1")
  assert.deepEqual(store.state("instance-1"), {
    status: "unavailable",
    missions: [],
    reason: "plugin-unavailable",
  })
})

test("ignores stale snapshot responses after a reconnect refresh", async () => {
  const resolvers: Array<(value: MissionListResponse) => void> = []
  const store = createMissionStore(() => new Promise((resolve) => resolvers.push(resolve)))
  const stale = store.refresh("instance-1")
  const current = store.refresh("instance-1")
  resolvers[1](available("current"))
  await current
  resolvers[0](available("stale"))
  await stale
  assert.equal(store.state("instance-1").missions[0]?.objective, "current")
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
