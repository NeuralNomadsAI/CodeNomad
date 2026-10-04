import assert from "node:assert/strict"
import test from "node:test"
import type { MissionMap, MissionTask } from "./model"
import { buildAssignmentPrompt, buildActorContext, getMissionRecipe } from "./recipes"

const task: MissionTask = { id: "task", key: "fix", title: "Fix <bug>", brief: "Only this seam", role: "implementer",
  status: "ready", blockedBy: [], createdAt: 1, updatedAt: 1, outstandingExecution: false,
  executionMode: { kind: "native", parentTaskKey: null } }
const mission: MissionMap = { version: 1, id: "mission", projectID: "project", projectCanonical: "/repo",
  objective: "Fix <symptom>", template: "pocock-fix-bug", status: "active", coordinatorSessionId: "ses_coordinator",
  actors: [{ sessionId: "ses_coordinator", kind: "coordinator", managed: false, title: "Coordinator", roles: ["coordinator"],
    location: { directory: "/repo" }, joinedAt: 1 }], tasks: [task], reports: [], frontier: ["fix"], claims: [],
  createdAt: 1, updatedAt: 1, revision: 1, history: [], historyTruncated: false }

test("native assignment permits ordinary helpers without granting topology or report authority", () => {
  const prompt = buildAssignmentPrompt(mission, task)
  assert.match(prompt, /native task actor/)
  assert.match(prompt, /ordinary native helpers/)
  assert.match(prompt, /may not alter mission topology or submit its mission report/)
  assert.match(prompt, /ordinary native subagent result/)
  assert.match(prompt, /Do not copy it into mission.report/)
  assert.match(prompt, /Fix &lt;symptom&gt;/)
  assert.match(prompt, /Fix &lt;bug&gt;/)
  const independent = buildAssignmentPrompt(mission, { ...task, executionMode: undefined })
  assert.match(independent, /independent root-session actor/)
  assert.match(independent, /"taskKey":"fix".*"final":false/)
})

test("coordinator preserves explicit native reuse and additive frontier planning", () => {
  const context = buildActorContext(mission, "ses_coordinator")
  assert.match(context, /declare only clear work, admit only the unblocked frontier/)
  assert.match(context, /reuseFromTaskKey/)
  assert.match(context, /Never infer idle from a report/)
  assert.match(context, /latest live implementation/)
  assert.match(context, /subagent\/all profiles/)
  assert.match(context, /primary\/all profiles/)
  assert.match(context, /not coordinator topology authority or mission.report privileges/)
  assert.match(context, /do not require child mission.report copies/)
  assert.match(context, /omit contract/)
})

test("Wayfinder guidance cannot claim a human-proof gate without authoritative native Form DTOs", () => {
  const recipe = getMissionRecipe("wayfinder")
  assert.match(recipe.sequence.join("\n"), /replacement is optional for genuinely additive work/)
  assert.match(recipe.coordinator, /real native Form\/session references/)
  assert.match(recipe.coordinator, /typed authority-owned Form proof/)
  assert.match(recipe.coordinator, /do not claim that a report artifact enforces human consent/)
  assert.equal(recipe.roles.some(role => role.reportContract), false)
})
