import assert from "node:assert/strict"
import { test } from "node:test"
import { missionGuidanceDraft, missionGuidanceText, setMissionGuidanceDraft } from "./mission-guidance"

test("direction preserves ordinary prompt text without optional context", () => {
  assert.equal(missionGuidanceText({ text: "  Keep iOS independent.  ", state: "draft" }, {}), "Keep iOS independent.")
})

test("optional user-selected context is explicit and precedes the instruction", () => {
  const draft = { text: "Try Android first.", intent: "alternative" as const, taskId: "task-a", state: "draft" as const }
  assert.equal(missionGuidanceText(draft, { intent: "Suggest an alternative", task: "Task: Verify SDK (sdk)" }),
    "Suggest an alternative\n\nTask: Verify SDK (sdk)\n\nTry Android first.")
  assert.equal(draft.text, "Try Android first.")
})

test("intent, task and uncertain text survive navigation without crossing identity", () => {
  const a = JSON.stringify(["instance", "project", "mission-a", "coordinator-a"])
  const b = JSON.stringify(["instance", "project", "mission-b", "coordinator-b"])
  const original = { text: "Keep the budget fixed.", intent: "constraint" as const, taskId: "task-a", state: "uncertain" as const }
  setMissionGuidanceDraft(a, original)
  setMissionGuidanceDraft(b, { text: "Different direction.", state: "draft" })
  assert.deepEqual(missionGuidanceDraft(a), original)
  assert.deepEqual(missionGuidanceDraft(b), { text: "Different direction.", state: "draft" })
  assert.deepEqual(missionGuidanceDraft("different-coordinator"), { text: "", state: "draft" })
})
