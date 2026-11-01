import assert from "node:assert/strict"
import { test } from "node:test"
import type { MissionMap } from "../../../server/src/api-types"
import { compactMissionMap } from "../../../server/src/missions/mission-compact-map"
import { readMissionContent } from "../../../server/src/missions/mission-content"
import { readMissionEditorBody } from "./mission-editor-body"

const selector = { kind: "mission", field: "objective" } as const
function map(): MissionMap {
  return { version: 1, id: "msn_fixture", projectID: "project", projectCanonical: "/fixture", objective: "Original \ud800 text", notes: "",
    template: "custom", status: "active", runState: "prepared", coordinatorSessionId: "ses_coordinator", revision: 2,
    createdAt: 1, updatedAt: 1, frontier: [], claims: [], actors: [], tasks: [], reports: [], historyTruncated: false,
    history: [{ source: "user", requestID: "edit_original", revision: 2, createdAt: 1, objective: { before: "before", after: "\u0800".repeat(20_000) },
      addedTaskKeys: [], retiredTasks: [], dependencyUpdates: [] }] }
}
const compact = compactMissionMap

test("editor reads compact mission inputs and exact plan-change bodies, including surrogate-safe multi-slice JSON", async () => {
  const mission = map(), shown = compact(mission), calls: number[] = []
  // Escape-heavy text makes the serialized change exceed one content slice.
  mission.history[0].objective!.before = "\u0000".repeat(20_000)
  const changed = compact(mission)
  const fetch = async (query: Parameters<Parameters<typeof readMissionEditorBody>[2]>[0]) => {
    calls.push(query.offset)
    return { available: true as const, ...readMissionContent(mission.projectID, { ...query, missionID: mission.id }, mission) }
  }
  assert.equal(await readMissionEditorBody(shown, selector, fetch), mission.objective)
  assert.equal(await readMissionEditorBody(shown, { kind: "mission", field: "notes" }, fetch), "")
  assert.deepEqual(await readMissionEditorBody(changed, { kind: "change", change: 2, field: "objective" }, fetch), mission.history[0].objective)
  assert.ok(calls.some(offset => offset > 0))
  assert.equal(await readMissionEditorBody(changed, { kind: "change", change: 2, field: "notes" }, fetch), undefined)
})

test("changed or missing evidence never confirms an editor's retained request", async () => {
  const mission = map(), shown = compact(mission)
  mission.objective = "Changed after the display read"
  await assert.rejects(readMissionEditorBody(shown, selector, async query => ({ available: true,
    ...readMissionContent(mission.projectID, { ...query, missionID: mission.id }, mission) })), /unavailable/)
  await assert.rejects(readMissionEditorBody(shown, selector, async query => ({ available: true,
    ...readMissionContent(mission.projectID, { ...query, missionID: mission.id }, undefined) })), /unavailable/)
})

test("editor refuses a foreign body or a different digest even at offset zero", async () => {
  const mission = map(), shown = compact(mission)
  for (const foreign of [true, false]) await assert.rejects(readMissionEditorBody(shown, selector, async query => {
    const result = readMissionContent(mission.projectID, { ...query, missionID: mission.id }, mission)
    if ("content" in result) {
      if (foreign) result.missionID = "msn_foreign"
      else result.content.digest = "another_digest"
    }
    return { available: true, ...result }
  }), /unavailable|changed|Invalid/)
})

test("maps from a plugin without descriptors keep their inline inputs", async () => {
  const mission = map()
  assert.equal(await readMissionEditorBody(mission, selector, async () => { throw new Error("Unexpected read") }), mission.objective)
})
