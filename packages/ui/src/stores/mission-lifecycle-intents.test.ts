import assert from "node:assert/strict"
import test from "node:test"
import type { MissionMap } from "../../../server/src/api-types"
import { createMissionLifecycleIntents, missionLifecycleSource } from "./mission-lifecycle-intents"

const input = (id = "original") => ({ action: "pause" as const, expectedRevision: 1, requestId: id })
const mission = { id: "mission", projectID: "project", projectCanonical: "/project", coordinatorSessionId: "coordinator",
  actors: [{ sessionId: "coordinator", kind: "coordinator", location: { directory: "/actor", workspaceID: "workspace" } }] } as MissionMap

test("unknown intent survives absence of component, visibility, display receipts and reconnect", () => {
  const store = createMissionLifecycleIntents(), original = input()
  const record = store.reserve("source", "mission", original)!
  assert.equal(store.start(record), true)
  assert.equal(store.busy("source"), true)
  assert.equal(store.start(record), false, "remount cannot submit a second in-flight retry")
  store.finish(record, "unknown")
  assert.equal(store.busy("source"), false)
  assert.equal(store.retry("source"), record)
  assert.deepEqual(store.retry("source")!.input, original)
  assert.equal(store.reserve("source", "mission", { ...original, expectedRevision: 2 }), undefined)
  assert.equal(store.reserve("source", "mission", original), record)
  assert.equal(store.finish(record, "acknowledged"), true)
  assert.equal(store.retry("source"), undefined)
})

test("certified rejection or ACK can settle exact ownership while hidden or disposed; ABA cannot settle a replacement", () => {
  const store = createMissionLifecycleIntents()
  for (const outcome of ["rejected", "acknowledged"] as const) {
    const old = store.reserve("source", "mission", input())!
    store.start(old)
    assert.equal(store.finish(old, outcome), true)
    const replacement = store.reserve("source", "mission", input())!
    assert.notEqual(old, replacement)
    assert.equal(store.finish(old, outcome), false)
    assert.equal(store.retry("source"), replacement)
    store.finish(replacement, "acknowledged")
  }
})

test("late outcome for an older operation never releases another action/request or foreign source", () => {
  const store = createMissionLifecycleIntents()
  const old = store.reserve("source", "mission", input("pause"))!
  store.finish(old, "unknown")
  const stop = store.reserve("source", "mission", { action: "stop", expectedRevision: 2, requestId: "stop" })!
  const foreign = store.reserve("foreign", "mission", input("pause"))!
  assert.equal(store.finish(old, "rejected"), true)
  assert.equal(store.retry("source"), stop)
  assert.equal(store.retry("foreign"), foreign)
  store.start(stop); store.finish(stop, "unknown")
  assert.deepEqual(store.retry("source")!.input, { action: "stop", expectedRevision: 2, requestId: "stop" })
})

test("capacity never evicts unresolved input or treats unknown as resolution; an exact release frees one slot", () => {
  const store = createMissionLifecycleIntents(2)
  const first = store.reserve("one", "mission", input("one"))!, second = store.reserve("two", "mission", input("two"))!
  store.finish(first, "unknown")
  assert.equal(store.available(), false)
  assert.equal(store.reserve("three", "mission", input("three")), undefined)
  assert.equal(store.retry("one"), first)
  assert.equal(store.retry("two"), second)
  assert.equal(store.start(first), true, "exact existing retries remain possible at capacity")
  store.finish(first, "unknown")
  assert.equal(store.available(), false)
  store.finish(second, "rejected")
  assert.equal(store.available(), true)
  assert.ok(store.reserve("three", "mission", input("three")))
  assert.deepEqual(store.retry("one")!.input, input("one"))
})

test("full instance/location/project/mission source identity is collision-safe and revision independent", () => {
  const location = { directory: "/worktree", proxyPath: "/proxy", projectID: "instance-project", snapshotProjectID: "snapshot-project" }
  const original = missionLifecycleSource("instance", mission, location)
  assert.equal(missionLifecycleSource("instance", { ...mission, revision: 9 }, location), original)
  const variants = [missionLifecycleSource("other-instance", mission, location),
    ...(["directory", "proxyPath", "projectID", "snapshotProjectID"] as const).map(field => missionLifecycleSource("instance", mission, { ...location, [field]: "changed" })),
    ...(["id", "projectID", "projectCanonical", "coordinatorSessionId"] as const).map(field => missionLifecycleSource("instance", { ...mission, [field]: "changed" }, location)),
    ...(["directory", "workspaceID"] as const).map(field => missionLifecycleSource("instance", { ...mission,
      actors: [{ ...mission.actors[0], location: { ...mission.actors[0].location, [field]: "changed" } }] }, location))]
  assert.equal(new Set([original, ...variants]).size, 12)
  const store = createMissionLifecycleIntents()
  const record = store.reserve(original, mission.id, input())!
  for (const variant of variants) assert.equal(store.retry(variant), undefined)
  assert.equal(store.retry(original), record)
})

test("window-local stores do not share uncertainty or capacity; inputs cannot be mutated after reservation", () => {
  const windowA = createMissionLifecycleIntents(1), windowB = createMissionLifecycleIntents(1)
  const draft = input(), a = windowA.reserve("source", "mission", draft)!
  draft.expectedRevision = 2
  assert.equal(a.input.expectedRevision, 1)
  assert.equal(Object.isFrozen(a.input), true)
  assert.equal(windowA.available(), false)
  assert.equal(windowB.retry("source"), undefined)
  assert.equal(windowB.available(), true)
  assert.ok(windowB.reserve("source", "mission", input()))
})

test("hydrating the already-known project identity cannot forget an unresolved intent", () => {
  const store = createMissionLifecycleIntents(), location = { directory: "/worktree", proxyPath: "/proxy" }
  const originalSource = missionLifecycleSource("instance", mission, location)
  const record = store.reserve(originalSource, mission.id, input())!
  store.finish(record, "unknown")
  const hydratedSource = missionLifecycleSource("instance", mission, { ...location, projectID: mission.projectID, snapshotProjectID: mission.projectID })
  assert.equal(hydratedSource, originalSource, "metadata presence is not a different source when project identity agrees")
  assert.equal(store.retry(hydratedSource), record)
})
