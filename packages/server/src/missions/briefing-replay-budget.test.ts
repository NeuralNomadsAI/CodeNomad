import assert from "node:assert/strict"
import { test } from "node:test"
import { reduceMissionEvents, type MissionEvent } from "./model"

test("briefing replay checks its exact revision without rereading every earlier timestamp", () => {
  const missionID = "msn_briefings", projectID = "project", actorSessionID = "ses_coordinator"
  const base = { version: 1 as const, missionID, projectID }
  let timestampReads = 0
  const events: MissionEvent[] = [{ ...base, id: "evt_created", type: "mission.created", createdAt: 1,
    objective: "Keep working", projectCanonical: "/repo", template: "custom",
    coordinator: { sessionID: actorSessionID, title: "Coordinator", location: { directory: "/repo" } } }]
  for (let index = 1; index < 1500; index++) {
    const id = `evt_briefing_${index}`
    events.push({ ...base, id, type: "mission.briefed", actorSessionID,
      get createdAt() { timestampReads++; return index + 1 },
      briefing: { id, requestID: `auto:${index}`, basedOnRevision: index, basedOnUpdatedAt: index,
        summary: "Continue", achieved: [], ongoing: [], obstacles: [], next: [], createdAt: index + 1 } })
  }
  const replay = reduceMissionEvents(events)
  assert.equal(replay.missions[0].revision, events.length)
  assert.equal(replay.missions[0].briefing?.basedOnRevision, events.length - 1)
  assert.equal(replay.discardedEvents, 0)
  assert.ok(timestampReads < events.length * 10, `replay inspected ${timestampReads} timestamps for ${events.length} ordered events`)
})
