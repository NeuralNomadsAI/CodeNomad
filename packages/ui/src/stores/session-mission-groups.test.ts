import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Session } from "../types/session"
import { buildSessionThreadsFromMap } from "./session-tree"
import { isMissionRootSession, missionCoordinatorFor, missionSessionTitle, partitionMissionThreads, readMissionMarker } from "./session-mission-groups"

const make = (id: string, updated: number, parentId: string | null = null, marker?: unknown) => ({
  id, title: id, instanceId: "i", parentId, location: { directory: "/repo" }, status: "idle", time: { created: 1, updated },
  ...(marker === undefined ? {} : { metadata: { "codenomad.mission": marker } }),
}) as unknown as Session

describe("session mission groups", () => {
  it("reads only well-formed native Mission markers", () => {
    assert.deepEqual(readMissionMarker(make("a", 1, null, { missionID: "m", kind: "actor" })), { missionID: "m", kind: "actor" })
    for (const marker of [null, [], { kind: "actor" }, { missionID: "", kind: "actor" }, { missionID: "m" }]) {
      assert.equal(readMissionMarker(make("a", 1, null, marker)), null)
    }
    assert.equal(isMissionRootSession(make("child", 1, "parent", { missionID: "m", kind: "actor" })), false)
  })

  it("strips only the generated display prefixes", () => {
    assert.equal(missionSessionTitle("Mission coordinator: Ship it"), "Ship it")
    assert.equal(missionSessionTitle("Mission · reviewer: Check"), "reviewer: Check")
    assert.equal(missionSessionTitle("Mission impossible"), "Mission impossible")
    assert.equal(missionSessionTitle("Mission coordinator:"), "Mission coordinator:")
  })

  it("nests task roots under their coordinator and keeps orphans and ordinary order", () => {
    const sessions = new Map([
      make("user", 1), make("other", 9),
      make("coord", 2, null, { missionID: "m1", kind: "coordinator" }),
      make("task", 7, null, { missionID: "m1", kind: "actor" }),
      make("helper", 8, "task"),
      make("orphan", 3, null, { missionID: "m2", kind: "actor" }),
    ].map(session => [session.id, session]))
    const threads = buildSessionThreadsFromMap(sessions, ["user", "other", "coord", "task", "orphan"])
    const { ordinary, missions } = partitionMissionThreads(threads)
    assert.deepEqual(ordinary.map(thread => thread.session.id), ["other", "user"])
    assert.deepEqual(missions.map(thread => thread.session.id), ["coord", "orphan"])
    assert.deepEqual(missions[0].children.map(thread => thread.session.id), ["task"])
    assert.equal(missions[0].latestUpdated, 8, "nested task activity orders its coordinator")
    assert.equal(missionCoordinatorFor(sessions, sessions.get("task")!), "coord")
    assert.equal(missionCoordinatorFor(sessions, sessions.get("orphan")!), null)
  })
})
