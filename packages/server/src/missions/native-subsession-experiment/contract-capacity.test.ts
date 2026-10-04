import assert from "node:assert/strict"
import test from "node:test"
import { MISSION_MAX_ACTORS, reduceMissionEvents, type MissionEvent, type MissionMap } from "../model"
import { createNativeActorCapacityReservations } from "./contract-capacity"

const projectID = "project_capacity", coordinatorID = "ses_coordinator"
const location = { directory: "D:/fixture/capacity", workspaceID: "wrk_capacity" }
let fixtureID = 0
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function fixture(children = 0, id = "msn_capacity_" + ++fixtureID, directory = location.directory, project = projectID) {
  let clock = 1
  const nativeLocation = { ...location, directory }
  const events: MissionEvent[] = [{ version: 1, id: "evt_created", missionID: id, projectID: project, createdAt: clock++, type: "mission.created", projectCanonical: "D:/fixture/repository", objective: "Capacity qualification", template: "custom", coordinator: { sessionID: coordinatorID, title: "Coordinator", location: nativeLocation } }]
  for (let index = 0; index < 12; index++) events.push({ version: 1, id: "evt_task_" + index, missionID: id, projectID: project, createdAt: clock++, type: "task.created", task: { id: "task_" + index, key: "task-" + index, title: "Task " + index, brief: "Bounded fake native actor", role: "worker", blockedBy: [] } })
  const snapshot = () => reduceMissionEvents(events, clock)
  const mission = () => snapshot().missions[0]
  const bind = (index: number, childID = "ses_child_" + index) => {
    events.push({ version: 1, id: "evt_bound_" + index, missionID: id, projectID: project, createdAt: clock++, type: "task.native-bound", taskKey: "task-" + index, actor: { sessionID: childID, title: "Child " + index, location: nativeLocation, managed: false }, binding: { generation: 1, parentSessionID: coordinatorID, toolCallID: "call_" + index, parentMessageID: "msg_" + index } })
    return childID
  }
  for (let index = 0; index < children; index++) bind(index)
  return { snapshot, mission, bind, events, id }
}

test("actor cap including coordinator refuses before native executor or child birth", () => {
  const f = fixture(MISSION_MAX_ACTORS - 1), capacity = createNativeActorCapacityReservations(projectID)
  let nativeExecuted = 0
  const invoke = () => {
    const reservation = capacity.reserve(f.mission())
    try { nativeExecuted++; reservation.bound(f.bind(7), f.snapshot()) } finally { reservation.release() }
  }
  assert.equal(f.mission().actors.length, MISSION_MAX_ACTORS)
  const count = f.events.length
  assert.throws(invoke, /capacity reached before child creation/)
  assert.equal(nativeExecuted, 0)
  assert.equal(f.events.length, count)
  assert.equal(f.snapshot().discardedEvents, 0)
})

test("overlapping sibling admissions and different installs share the last slot", async () => {
  const f = fixture(MISSION_MAX_ACTORS - 2)
  const firstInstall = createNativeActorCapacityReservations(projectID), secondInstall = createNativeActorCapacityReservations(projectID)
  const authoritativeRead = async () => f.mission()
  const snapshotA = await authoritativeRead(), snapshotB = await authoritativeRead()
  const ticket = firstInstall.reserve(snapshotA)
  try {
    assert.throws(() => secondInstall.reserve(snapshotB), /capacity reached/)
    ticket.bound(f.bind(6), f.snapshot())
    assert.throws(() => secondInstall.reserve(f.mission()), /capacity reached/)
    assert.equal(f.snapshot().discardedEvents, 0)
  } finally { ticket.release() }
})

test("a re-evaluated plugin module shares host reservations rather than resetting admitted slots", async () => {
  const f = fixture(6), capacity = createNativeActorCapacityReservations(projectID)
  const ticket = capacity.reserve(f.mission())
  try {
    const incarnation = await import(new URL("./contract-capacity.ts?capacity-fixture-incarnation=2", import.meta.url).href) as typeof import("./contract-capacity")
    assert.notEqual(incarnation.createNativeActorCapacityReservations, createNativeActorCapacityReservations)
    const reloaded = incarnation.createNativeActorCapacityReservations(projectID)
    assert.throws(() => reloaded.reserve(f.mission()), /capacity reached/)
    ticket.release()
    const later = reloaded.reserve(f.mission())
    later.release()
  } finally { ticket.release() }
})

test("finally release after native error allows a later attempt; cleanup is idempotent", () => {
  const f = fixture(6), capacity = createNativeActorCapacityReservations(projectID)
  const failure = () => {
    const ticket = capacity.reserve(f.mission())
    try { throw new Error("Native executor failed") } finally { ticket.release(); ticket.release() }
  }
  assert.throws(failure, /Native executor failed/)
  const next = capacity.reserve(f.mission())
  next.release(); next.release()
  const again = capacity.reserve(f.mission())
  again.release()
  assert.equal(f.snapshot().discardedEvents, 0)
})

test("bound consumes exactly its actual actor footprint without double counting or freeing another ticket", () => {
  const f = fixture(4), capacity = createNativeActorCapacityReservations(projectID)
  const first = capacity.reserve(f.mission()), second = capacity.reserve(f.mission())
  try {
    first.bound(f.bind(4), f.snapshot())
    // Six actors plus one still-pending slot leaves precisely one more slot.
    const last = capacity.reserve(f.mission())
    try {
      first.bound("ses_child_4", f.snapshot())
      first.release(); first.release()
      assert.throws(() => capacity.reserve(f.mission()), /capacity reached/)
      second.bound(f.bind(5), f.mission())
      assert.throws(() => capacity.reserve(f.mission()), /capacity reached/)
      last.bound(f.bind(6), f.snapshot())
      assert.equal(f.mission().actors.length, 8)
      assert.equal(f.snapshot().discardedEvents, 0)
    } finally { last.release() }
  } finally { first.release(); second.release() }
})

test("existing owned specialist may be reused at cap without an extra reserved slot", () => {
  const f = fixture(7), capacity = createNativeActorCapacityReservations(projectID)
  const reused = capacity.reserve(f.mission(), "ses_child_3")
  try {
    reused.bound("ses_child_3", f.snapshot())
    reused.bound("ses_child_3", f.mission())
    assert.throws(() => capacity.reserve(f.mission()), /capacity reached/)
  } finally { reused.release(); reused.release() }
  assert.equal(f.snapshot().discardedEvents, 0)
})

test("reuse tickets leave the remaining fresh-child slot available", () => {
  const f = fixture(6), capacity = createNativeActorCapacityReservations(projectID)
  const reused = capacity.reserve(f.mission(), "ses_child_2"), fresh = capacity.reserve(f.mission())
  try {
    reused.bound("ses_child_2", f.mission())
    assert.throws(() => capacity.reserve(f.mission()), /capacity reached/)
    fresh.bound(f.bind(6), f.snapshot())
    assert.equal(f.snapshot().discardedEvents, 0)
  } finally { reused.release(); fresh.release() }
})

test("unknown, coordinator and foreign reuse actors fail before consuming capacity", () => {
  const f = fixture(6), capacity = createNativeActorCapacityReservations(projectID)
  assert.throws(() => capacity.reserve(f.mission(), "ses_unknown"), /Reuse actor/)
  assert.throws(() => capacity.reserve(f.mission(), coordinatorID), /Reuse actor/)
  const foreign = clone(f.mission())
  foreign.actors.find(actor => actor.sessionId === "ses_child_0")!.location.directory = "D:/foreign"
  assert.throws(() => capacity.reserve(foreign, "ses_child_0"), /Reuse actor/)
  const ticket = capacity.reserve(f.mission())
  ticket.release()
})

test("unknown or mismatched actual progress actor cannot consume a fresh reservation", () => {
  const f = fixture(6), capacity = createNativeActorCapacityReservations(projectID)
  const ticket = capacity.reserve(f.mission())
  try {
    assert.throws(() => ticket.bound("ses_unknown", f.snapshot()), /unknown, foreign or mismatched/)
    assert.throws(() => ticket.bound("ses_child_0", f.snapshot()), /unknown, foreign or mismatched/)
    assert.throws(() => capacity.reserve(f.mission()), /capacity reached/)
    const childID = f.bind(6)
    const wrongLocation = clone(f.mission())
    wrongLocation.actors.find(actor => actor.sessionId === childID)!.location.directory = "D:/foreign"
    assert.throws(() => ticket.bound(childID, wrongLocation), /unknown, foreign or mismatched/)
    ticket.bound(childID, f.snapshot())
    assert.throws(() => ticket.bound("ses_other", f.snapshot()), /child identity mismatch/)
  } finally { ticket.release() }
})

test("reuse cannot change the actor identity or bind a different child", () => {
  const f = fixture(6), capacity = createNativeActorCapacityReservations(projectID)
  const ticket = capacity.reserve(f.mission(), "ses_child_0")
  try {
    assert.throws(() => ticket.bound("ses_child_1", f.snapshot()), /child identity mismatch/)
    const changed = clone(f.mission())
    changed.actors.find(actor => actor.sessionId === "ses_child_0")!.title = "Different actor"
    assert.throws(() => ticket.bound("ses_child_0", changed), /inventory identity changed/)
    ticket.bound("ses_child_0", f.snapshot())
  } finally { ticket.release() }
})

test("duplicate sibling claims cannot consume one new actor footprint twice", () => {
  const f = fixture(5), capacity = createNativeActorCapacityReservations(projectID)
  const first = capacity.reserve(f.mission()), second = capacity.reserve(f.mission())
  try {
    const child = f.bind(5)
    first.bound(child, f.snapshot())
    assert.throws(() => second.bound(child, f.snapshot()), /already consumed/)
    assert.throws(() => capacity.reserve(f.mission()), /capacity reached/)
    second.bound(f.bind(6), f.snapshot())
    assert.equal(f.snapshot().discardedEvents, 0)
  } finally { first.release(); second.release() }
})

test("changed scope, incomplete inventory, stale or damaged snapshot fails closed", () => {
  const f = fixture(6), capacity = createNativeActorCapacityReservations(projectID)
  const ticket = capacity.reserve(f.mission())
  try {
    const childID = f.bind(6)
    const changes: Array<(mission: MissionMap) => void> = [
      mission => { mission.id = "msn_foreign" },
      mission => { mission.projectID = "foreign_project" },
      mission => { mission.projectCanonical = "D:/foreign" },
      mission => { mission.revision = 1 },
      mission => { mission.actors[0].location.directory = "D:/moved" },
      mission => { mission.actors = mission.actors.filter(actor => actor.sessionId !== "ses_child_0") },
    ]
    for (const change of changes) {
      const fresh = clone(f.mission()); change(fresh)
      assert.throws(() => ticket.bound(childID, fresh))
    }
    assert.throws(() => ticket.bound(childID, { ...f.snapshot(), discardedEvents: 1 }), /shared snapshot evidence/)
    assert.throws(() => ticket.bound(childID, { ...f.snapshot(), missions: [] }), /missing or ambiguous/)
    ticket.bound(childID, f.snapshot())
  } finally { ticket.release() }
})

test("release rejects late binding and cannot remove a newer reservation", () => {
  const f = fixture(6), capacity = createNativeActorCapacityReservations(projectID)
  const old = capacity.reserve(f.mission())
  old.release()
  const current = capacity.reserve(f.mission())
  try {
    old.release()
    assert.throws(() => old.bound("ses_unknown", f.snapshot()), /released/)
    assert.throws(() => capacity.reserve(f.mission()), /capacity reached/)
  } finally { current.release() }
})

test("project, Mission and Location scopes are separate but identical factories share them", () => {
  const f = fixture(6), capacity = createNativeActorCapacityReservations(projectID)
  const ticket = capacity.reserve(f.mission())
  const otherMission = fixture(6), otherLocation = fixture(6, f.id, "D:/different-location"), otherProject = fixture(6, f.id, location.directory, "other_project")
  const tickets = []
  try {
    assert.throws(() => createNativeActorCapacityReservations(projectID).reserve(f.mission()), /capacity reached/)
    tickets.push(capacity.reserve(otherMission.mission()))
    tickets.push(capacity.reserve(otherLocation.mission()))
    tickets.push(createNativeActorCapacityReservations("other_project").reserve(otherProject.mission()))
    assert.throws(() => capacity.reserve(otherProject.mission()), /Mission identity/)
  } finally { ticket.release(); for (const other of tickets) other.release() }
})

test("malformed or over-cap actor inventory is not admission authority", () => {
  const f = fixture(6), capacity = createNativeActorCapacityReservations(projectID)
  const duplicate = clone(f.mission()); duplicate.actors.push(duplicate.actors[1])
  assert.throws(() => capacity.reserve(duplicate), /inventory/)
  const overCap = clone(f.mission()); overCap.actors.push({ ...overCap.actors[1], sessionId: "ses_extra_1" }, { ...overCap.actors[1], sessionId: "ses_extra_2" })
  assert.throws(() => capacity.reserve(overCap), /capacity already exceeded/)
  const coordinatorMissing = clone(f.mission()); coordinatorMissing.actors.shift()
  assert.throws(() => capacity.reserve(coordinatorMissing), /inventory/)
  assert.throws(() => createNativeActorCapacityReservations(""), /trusted project/)
  const ticket = capacity.reserve(f.mission()); ticket.release()
})

test("external actor footprint changes fail closed rather than discarding another authority event", () => {
  const f = fixture(5), capacity = createNativeActorCapacityReservations(projectID)
  const first = capacity.reserve(f.mission()), second = capacity.reserve(f.mission())
  try {
    f.bind(7) // Unreserved external writer; deliberately outside the local promise.
    const child = f.bind(5)
    assert.equal(f.snapshot().discardedEvents, 0)
    assert.throws(() => first.bound(child, f.snapshot()), /capacity changed/)
    assert.throws(() => capacity.reserve(f.mission()), /capacity reached/)
  } finally { first.release(); second.release() }
})
