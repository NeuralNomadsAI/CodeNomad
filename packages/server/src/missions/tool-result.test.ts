import assert from "node:assert/strict"
import test from "node:test"
import type { MissionMap, MissionTask } from "./model"
import { WAYFINDER_DECISION_REQUIREMENT, buildActorContext, buildAssignmentPrompt, getMissionRecipe } from "./recipes"
import { compactMission, compactMissionTask, nativeAssignment } from "./tool-result"
import { decisionInvocationUnavailable } from "./control-error"
import { nativeDecisionProvenance } from "./contracts"

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

test("live native tasks expose their exact prompt; Wayfinder decisions also state the human-answer requirement", () => {
  assert.deepEqual(nativeAssignment(mission, task), {
    contract: { missionID: "mission", taskKey: "choose", generation: 2 },
    assignmentPrompt: buildAssignmentPrompt(mission, task),
    requirement: WAYFINDER_DECISION_REQUIREMENT,
  })
  assert.equal("requirement" in nativeAssignment(mission, { ...task, role: "research" }), false)
  assert.equal("requirement" in nativeAssignment({ ...mission, template: "custom" }, task), false)
  assert.deepEqual(nativeAssignment(mission, { ...task, status: "withdrawn" }), {}, "withdrawn work is never relaunched")
  assert.deepEqual(nativeAssignment(mission, { ...task, executionMode: { kind: "independent", reason: "lifetime", explanation: "Own root" } }), {})
})

test("a decision refusal shows the exact provenance shape the gate validates", () => {
  const error = decisionInvocationUnavailable()
  assert.equal(error.code, "policy-unqualified")
  assert.match(error.message, /^Wayfinder decision invocation unavailable: /)
  assert.match(error.message, /Record a self-contained analysis as a research task instead, or report this decision blocked\.$/)
  const artifact = JSON.parse(error.message.slice(error.message.indexOf("{"), error.message.lastIndexOf("}") + 1))
  assert.deepEqual(Object.keys(artifact), ["kind", "question", "answer", "provenance"])
  assert.deepEqual(Object.keys(artifact.provenance).sort(), Object.keys(nativeDecisionProvenance.shape).sort())
  assert.deepEqual(Object.keys(artifact.provenance.nativeCall).sort(), Object.keys(nativeDecisionProvenance.shape.nativeCall.shape).sort())
  assert.deepEqual(Object.keys(artifact.provenance.contract).sort(), ["generation", "missionID", "taskKey"])
})

test("the Wayfinder decision role and coordinator state the native human-answer rule up front", () => {
  const recipe = getMissionRecipe("wayfinder")
  const decision = recipe.roles.find(role => role.id === "decision")!
  assert.doesNotMatch(decision.purpose, /self-contained/)
  assert.match(decision.instructions, /ask the human from this conversation through the native question tool/)
  assert.match(decision.instructions, /never answer it yourself or hand the question to a helper/)
  assert.ok(recipe.coordinator.includes(WAYFINDER_DECISION_REQUIREMENT))
  const independent = getMissionRecipe("wayfinder", "independent").coordinator
  assert.ok(!independent.includes(WAYFINDER_DECISION_REQUIREMENT), "the gate checks native decision tasks only")
  assert.match(independent, /persisted user-selected taskMode is independent/)
  assert.match(independent, /never answer the human side yourself/)
  assert.match(WAYFINDER_DECISION_REQUIREMENT, /Use research for a self-contained analysis/)
  assert.ok(buildActorContext({ ...mission, actors: [{ sessionId: "ses_coordinator", kind: "coordinator", managed: false,
    title: "Coordinator", roles: [], location: { directory: "/repo" }, joinedAt: 1 }] }, "ses_coordinator").includes(WAYFINDER_DECISION_REQUIREMENT))
})
