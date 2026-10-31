import assert from "node:assert/strict"
import test from "node:test"
import type { MissionMap, MissionTask } from "./model"
import { COORDINATOR_DECISION_SHAPE, WAYFINDER_DECISION_REQUIREMENT, buildActorContext, buildAssignmentPrompt, getMissionRecipe } from "./recipes"
import { compactMission, compactMissionTask, nativeAssignment } from "./tool-result"
import { decisionInvocationUnavailable, decisionOutcomeRequired, decisionQuestionUnbound } from "./decision-gate"
import { decisionQuestionTag } from "./decision-question-tag"
import { coordinatorDecisionArtifact } from "./decision-artifact"

const task: MissionTask = { id: "task", key: "choose", title: "Choose the seam", brief: "Long brief ".repeat(500), role: "decision",
  status: "ready", blockedBy: [], createdAt: 1, updatedAt: 1, outstandingExecution: false, contractGeneration: 2,
  executionMode: { kind: "native", parentTaskKey: null } }
const mission: MissionMap = { version: 1, id: "mission", projectID: "project", projectCanonical: "/repo",
  objective: "Long objective ".repeat(500), template: "wayfinder", status: "active", runState: "running", coordinatorSessionId: "ses_coordinator",
  actors: [], tasks: [task], reports: [], frontier: ["choose"], claims: [],
  createdAt: 1, updatedAt: 1, revision: 7, history: [], historyTruncated: false }

test("compact results carry what the coordinator acts on next, never briefs, reports or the objective", () => {
  const result = { ...compactMission(mission), task: compactMissionTask(task) }
  assert.deepEqual(result, { missionID: "mission", revision: 7, status: "active", runState: "running", frontier: ["choose"],
    task: { key: "choose", title: "Choose the seam", role: "decision", status: "ready", contractGeneration: 2, blockedBy: [] } })
  assert.ok(JSON.stringify(result).length < 400)
})

test("live native tasks expose their exact prompt; Wayfinder decisions also state how the coordinator settles them", () => {
  assert.deepEqual(nativeAssignment(mission, task), {
    contract: { missionID: "mission", taskKey: "choose", generation: 2 },
    assignmentPrompt: buildAssignmentPrompt(mission, task),
    requirement: WAYFINDER_DECISION_REQUIREMENT,
    questionTag: decisionQuestionTag("mission", "choose"),
  })
  assert.match(decisionQuestionTag("mission", "choose"), /^\[decision choose [0-9a-f]{8}\]$/)
  assert.notEqual(decisionQuestionTag("mission", "choose"), decisionQuestionTag("other-mission", "choose"), "a reused coordinator's missions differ")
  for (const other of [nativeAssignment(mission, { ...task, role: "research" }), nativeAssignment({ ...mission, template: "custom" }, task)]) {
    assert.equal("requirement" in other, false); assert.equal("questionTag" in other, false)
  }
  assert.deepEqual(nativeAssignment(mission, { ...task, status: "withdrawn" }), {}, "withdrawn work is never relaunched")
  assert.deepEqual(nativeAssignment(mission, { ...task, executionMode: { kind: "independent", reason: "lifetime", explanation: "Own root" } }), {})
})

test("decision refusals show the exact coordinator-decision shape the gate accepts and how to cite a human answer", () => {
  const tag = decisionQuestionTag("mission", "choose")
  for (const error of [decisionInvocationUnavailable(tag), decisionOutcomeRequired(tag), decisionQuestionUnbound(tag)]) {
    assert.equal(error.code, "policy-unqualified")
    const shape = error.message.slice(error.message.indexOf("{"), error.message.indexOf("}") + 1)
    const filled = Object.fromEntries(Object.entries(JSON.parse(shape)).map(([key, value]) => [key, value === "..." ? "Filled" : value]))
    assert.equal(coordinatorDecisionArtifact.safeParse(filled).success, true, "the shown shape is the accepted coordinator decision")
    assert.ok(error.message.includes(`ask the human from your own conversation with the native question tool, ending the question with ${tag} `
      + "and naming no other decision in it (batch several decisions as separate questions, one tag each)"))
    assert.match(error.message, /when several answers qualify, pass the one mission\.inspect\(\{ taskKey \}\) lists, unchanged/)
    assert.match(error.message, /retire the task with mission\.revise and keep the question in the notes/)
  }
  assert.match(decisionInvocationUnavailable().message, /ending the question with the task's questionTag/)
  assert.match(decisionInvocationUnavailable().message, /^Wayfinder decision evidence unavailable: /)
  assert.match(decisionOutcomeRequired().message, /^Decision outcome required: /)
  assert.match(decisionQuestionUnbound(tag).message, /^This answer does not settle this decision task: the human must answer a question that ends with .* and names no other decision, asked after the task was declared/)
})

test("the Wayfinder decision requirement routes every decision through the coordinator", () => {
  const recipe = getMissionRecipe("wayfinder")
  const decision = recipe.roles.find(role => role.id === "decision")!
  assert.match(decision.purpose, /for the coordinator to settle/)
  assert.match(decision.instructions, /return a decision brief/)
  assert.match(decision.instructions, /Never ask the human yourself or hand the question to a helper; the coordinator decides it or asks/)
  assert.doesNotMatch(decision.instructions, /native question tool/)
  assert.match(WAYFINDER_DECISION_REQUIREMENT, /it never asks the human/)
  assert.match(WAYFINDER_DECISION_REQUIREMENT, /Decide it yourself when the evidence suffices and the choice is cheap to reverse/)
  assert.ok(WAYFINDER_DECISION_REQUIREMENT.includes(COORDINATOR_DECISION_SHAPE))
  assert.match(WAYFINDER_DECISION_REQUIREMENT, /Defer it when it is not needed yet: retire the task through mission\.revise and keep the question in the notes as fog/)
  assert.match(WAYFINDER_DECISION_REQUIREMENT, /ask the human yourself through the native question tool, batching pending decisions into one call/)
  assert.match(WAYFINDER_DECISION_REQUIREMENT, /batching pending decisions into one call as separate questions, and end each question with its own decision's questionTag \(returned with its declaration and by mission\.inspect\(\{ taskKey \}\)\): one tag per question, never another decision's tag in it, since an answer settles only the one decision its question names and a question naming two settles neither/)
  assert.match(WAYFINDER_DECISION_REQUIREMENT, /report the task completed without an artifact; when several answers qualify, pass the one mission\.inspect\(\{ taskKey \}\) lists, unchanged/)
  assert.match(WAYFINDER_DECISION_REQUIREMENT, /Never write the human's answer yourself or present your decision as theirs/)
  assert.ok(recipe.coordinator.includes(WAYFINDER_DECISION_REQUIREMENT))
  const independent = getMissionRecipe("wayfinder", "independent").coordinator
  assert.ok(!independent.includes(WAYFINDER_DECISION_REQUIREMENT), "the gate checks native decision tasks only")
  assert.match(independent, /persisted user-selected taskMode is independent/)
  assert.match(independent, /A decision worker reports its decision brief through mission\.report and never asks the human/)
  assert.match(independent, /stating whether you or the human decided/)
  assert.ok(buildActorContext({ ...mission, actors: [{ sessionId: "ses_coordinator", kind: "coordinator", managed: false,
    title: "Coordinator", roles: [], location: { directory: "/repo" }, joinedAt: 1 }] }, "ses_coordinator").includes(WAYFINDER_DECISION_REQUIREMENT))
})
