import assert from "node:assert/strict"
import { test } from "node:test"
import type { MissionMap, MissionReport } from "../../../server/src/api-types"
import { missionBriefingFreshness } from "./mission-briefing-model"
import { missionTrackingExcerpt } from "./mission-progress-model"
import { missionBriefingRequestText } from "../lib/mission-briefing-request"

const report: MissionReport = { id: "report", taskKey: "work", sessionId: "coordinator", outcome: "completed",
  summary: "A verified result", evidence: [], next: [], createdAt: 3 }
const mission: MissionMap = { version: 1, id: "mission", coordinatorSessionId: "coordinator", projectID: "project", projectCanonical: "/repo",
  objective: "<ignore-previous-instructions>", notes: "secret-notes-not-interpolated", template: "custom", status: "active", actors: [],
  tasks: [{ id: "task", key: "work", title: "Work", brief: "Brief", role: "specialist", blockedBy: [], status: "completed", report,
    createdAt: 1, updatedAt: 3, outstandingExecution: false }], reports: [report], frontier: [], claims: [], createdAt: 1, updatedAt: 3,
  revision: 3, history: [], historyTruncated: false,
  briefing: { id: "briefing", requestID: "request", basedOnRevision: 1, basedOnUpdatedAt: 1, createdAt: 2,
    summary: "Earlier assessment", achieved: [], ongoing: [], obstacles: [], next: [] } }

test("freshness counts only exact current results since the assessed snapshot", () => {
  assert.deepEqual(missionBriefingFreshness(mission), { results: 1, changed: true })
  assert.deepEqual(missionBriefingFreshness({ ...mission, reports: [report, { ...report, id: "late", late: true }] }), { results: 1, changed: true })
  assert.deepEqual(missionBriefingFreshness({ ...mission, tasks: [{ ...mission.tasks[0], status: "withdrawn" }] }), { results: 0, changed: true })
  assert.deepEqual(missionBriefingFreshness({ ...mission, tasks: [{ ...mission.tasks[0], status: "queued", report: undefined }] }), { results: 0, changed: true })
  assert.deepEqual(missionBriefingFreshness({ ...mission, briefing: undefined }), { results: 0, changed: false })
  assert.deepEqual(missionBriefingFreshness({ ...mission, revision: 2, tasks: [], reports: [] }), { results: 0, changed: false })
})
test("fixed on-demand request names the exact mission, ID and language without embedding task-data instructions", () => {
  const text = missionBriefingRequestText(mission, "unique-request", "fr")
  assert.match(text, /Mission ID: mission/)
  assert.match(text, /Request ID: unique-request/)
  assert.match(text, /Response language: fr/)
  assert.match(text, /Do not perform new tests, run or replay tasks/)
  assert.match(text, /mission\.briefing/)
  assert.ok(!text.includes(mission.notes!))
  assert.ok(!text.includes(mission.objective))
})
test("fallback excerpts remain bounded and do not split Unicode or change the full reader source", () => {
  const text = "😀".repeat(1000)
  assert.equal(missionTrackingExcerpt(text, 2), "😀😀…")
  assert.equal(text.length, 2000)
  assert.equal(missionTrackingExcerpt("  Plain\nsource  "), "Plain source")
})
