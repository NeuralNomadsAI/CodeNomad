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

test("editor receipt reads keep their exact request and bodies when the panel holds only a task window", async () => {
  const mission = map()
  mission.tasks = Array.from({ length: 75 }, (_, index) => ({ id: `tsk_${index}`, key: `work-${index}`, title: `Work ${index}`,
    brief: `Brief ${index}`, role: "specialist", status: "ready", blockedBy: [], outstandingExecution: false, createdAt: 1, updatedAt: 1 }))
  mission.history[0].addedTaskKeys = mission.tasks.map(task => task.key)
  const shown = compact(mission), calls: unknown[] = []
  assert.equal(shown.tasks.length, 50)
  assert.equal(shown.taskPage?.total, 75)
  assert.equal(shown.history[0].requestID, "edit_original")
  assert.equal("addedTaskKeys" in shown.history[0], false)
  const fetch = async (query: Parameters<Parameters<typeof readMissionEditorBody>[2]>[0]) => {
    calls.push(query)
    return { available: true as const, ...readMissionContent(mission.projectID, { ...query, missionID: mission.id }, mission) }
  }
  assert.deepEqual(await readMissionEditorBody(shown, { kind: "change", change: 2, field: "objective" }, fetch), mission.history[0].objective)
  assert.equal(await readMissionEditorBody(shown, selector, fetch), mission.objective)
  assert.equal(calls.length, 2, "only exact text reads, independent of absent task rows")
  assert.equal(mission.tasks.length, 75, "the full source remains intact")
})
