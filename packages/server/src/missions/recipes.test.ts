import assert from "node:assert/strict"
import test from "node:test"
import type { MissionMap, MissionTask, MissionTemplateId } from "./model"
import { AUTOMATIC_BRIEFINGS, USER_FACING_TEXT, buildAssignmentPrompt, buildActorContext, getMissionRecipe } from "./recipes"

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

test("optional working notes stay verbatim in the map and are quoted as untrusted actor context for every playbook", () => {
  const notes = "  Optional <working notes> & technical context\n  "
  for (const template of ["custom", "pocock-fix-bug", "wayfinder"] as const) {
    const map = { ...mission, template, notes }
    const context = buildActorContext(map, "ses_coordinator")
    assert.ok(context.includes("<mission-notes>  Optional &lt;working notes&gt; &amp; technical context\n  </mission-notes>"))
    assert.equal(map.notes, notes)
  }
})

test("every coordinator plans all requested workstreams and launches independent work before waiting", () => {
  for (const template of ["custom", "pocock-fix-bug", "wayfinder"] satisfies MissionTemplateId[]) {
    const context = buildActorContext({ ...mission, template }, "ses_coordinator")
    assert.match(context, /Cover every explicitly requested workstream/)
    assert.match(context, /Before waiting for one result, launch the other independent ready tasks/)
    assert.match(context, /background native calls or concurrent native calls/)
    assert.match(context, /reuseFromTaskKey selects context, not a blockedBy dependency/)
    assert.match(context, /Prefer a fresh native child for independent work/)
    assert.match(context, /Do not add a dependency just to reuse a session/)
    assert.match(context, /One workstream's missing tool, consent or failure must not park unrelated ready work/)
    assert.match(context, /Never infer idle from a report/)
  }
})

test("every coordinator writes plain-language summaries and publishes automatic briefings", () => {
  for (const template of ["custom", "pocock-fix-bug", "wayfinder"] satisfies MissionTemplateId[]) {
    for (const taskMode of ["native", "independent"] as const) {
      const context = buildActorContext({ ...mission, template, taskMode }, "ses_coordinator")
      assert.ok(context.includes(USER_FACING_TEXT) && context.includes(AUTOMATIC_BRIEFINGS))
      assert.match(context, /user's language, in 3-5 short plain sentences, outcome first/)
      assert.match(context, /Never put session or message IDs, internal tool, fixture/)
      assert.match(context, /IDs, commands and test output go only in evidence items/)
      assert.match(context, /publish mission\.briefing on your own, without waiting for a request/)
      assert.match(context, /once the initial plan is declared/)
      assert.match(context, /after each mission\.report that settles a task as completed, failed or blocked/)
      assert.match(context, /whenever you start waiting on a human/)
      assert.match(context, /right before the final mission\.report/)
      assert.match(context, /requestID "auto:<revision>" with that same freshly inspected revision as basedOnRevision/)
      assert.match(context, /exact requestID supplied by the UI/)
      assert.match(context, /what was delivered, what remains, and what needs a decision, in at most 6 short sentences/)
      assert.doesNotMatch(context, /never after every tool\/task/)
    }
  }
  const pocock = buildActorContext(mission, "ses_coordinator")
  assert.match(pocock, /role's structured artifact from the returned evidence/, "Pocock evidence gate survives")
  assert.match(buildActorContext({ ...mission, template: "wayfinder" }, "ses_coordinator"), /never answer the human side yourself/)
  for (const prompt of [buildAssignmentPrompt(mission, task), buildAssignmentPrompt(mission, { ...task, executionMode: undefined })]) {
    assert.match(prompt, /Write the summary for a human reader: plain language/)
    assert.match(prompt, /put IDs, commands and test output only in evidence/)
  }
})

test("Wayfinder guidance cannot claim a human-proof gate without authoritative native Form DTOs", () => {
  const recipe = getMissionRecipe("wayfinder")
  assert.match(recipe.sequence.join("\n"), /replacement is optional for genuinely additive work/)
  assert.match(recipe.coordinator, /real native Form\/session references/)
  assert.match(recipe.coordinator, /typed authority-owned Form proof/)
  assert.match(recipe.coordinator, /do not claim that a report artifact enforces human consent/)
  assert.equal(recipe.roles.some(role => role.reportContract), false)
})

function assertNativeWorkPolicy(text: string) {
  assert.match(text, /Each native child owns its bounded assignment and may recursively decompose it/)
  assert.match(text, /Run independent subtasks in parallel when useful/)
  assert.match(text, /within the assignment's role and evidence gates/)
  assert.match(text, /Avoid conflicting edits or shared mutable checks/)
  assert.match(text, /Pass the relevant scope, role constraints, safety boundaries/)
  assert.match(text, /Context is not automatically propagated by Missions/)
  assert.match(text, /helpers may not alter mission topology or submit its mission report/)
  assert.match(text, /Integrate actual returned evidence.*immediate parent/)
  assert.match(text, /A background launch is not completion/)
  assert.match(text, /Respect native permissions and the user's configured runtime depth/)
  assert.match(text, /Do not change configuration, force a fixed depth/)
  assert.match(text, /denied\/depth-limited helper into an undeclared independent root/)
  assert.doesNotMatch(text, /subagent_depth|depth\s*[:=]\s*\d|reach (?:depth|level) \d/)
}

for (const template of ["custom", "pocock-fix-bug", "wayfinder"] satisfies MissionTemplateId[]) {
  test(`${template} propagates bounded native policy while retaining every role's constraints`, () => {
    const map = { ...mission, template }
    const recipe = getMissionRecipe(template)
    const coordinator = buildActorContext(map, "ses_coordinator")
    assertNativeWorkPolicy(coordinator)
    assert.match(coordinator, /Run independent ready frontier tasks in parallel;/)
    assert.match(coordinator, /blockedBy records real prerequisites/)
    assert.match(coordinator, /canonical assignmentPrompt.*only when its task is ready/)
    assert.match(coordinator, /context, not execution admission or proof/)
    assert.match(coordinator, /Keep the declared execution profile and native continuation checks intact/)
    for (const role of recipe.roles) {
      const assignment = { ...task, role: role.id }
      const prompt = buildAssignmentPrompt(map, assignment)
      assertNativeWorkPolicy(prompt)
      assert.ok(prompt.includes(role.instructions), `${role.id} keeps its full role contract`)
      if (role.reportContract) assert.ok(prompt.includes(role.reportContract), `${role.id} keeps its artifact contract`)
      assert.match(prompt, /Safety boundary:/)
      assert.match(prompt, /preserve unrelated user changes/)
      assert.match(prompt, /Never stage, commit, push/)
      assert.match(prompt, /Do not expose secrets/)
      assert.match(prompt, /ordinary native subagent result/)
      assert.match(prompt, /Do not copy it into mission.report/)
      const specialist: MissionMap = { ...map, tasks: [{ ...assignment, actorSessionId: "ses_specialist" }], actors: [
        ...map.actors, { ...map.actors[0], sessionId: "ses_specialist", kind: "specialist", roles: [role.id] },
      ] }
      assertNativeWorkPolicy(buildActorContext(specialist, "ses_specialist"))
      assert.equal(buildActorContext(specialist, "ses_unregistered_helper"), "", "no invented helper membership")
      const independent = buildAssignmentPrompt(map, { ...assignment, executionMode: { kind: "independent", reason: "playbook", explanation: "Read-only isolated exception" } })
      assertNativeWorkPolicy(independent)
      assert.match(independent, /When finished, call mission.report/)
    }
  })
}

test("playbook evidence and human boundaries survive parallel helper guidance", () => {
  const pocock = getMissionRecipe("pocock-fix-bug")
  assert.match(pocock.coordinator, /dependency-connected evidence gate/)
  assert.match(pocock.coordinator, /fresh distinct native sessions for both review axes and final validation/)
  for (const role of ["review-standards", "review-spec", "validator"]) {
    assert.match(buildAssignmentPrompt(mission, { ...task, role }), /Do not edit\./)
  }
  assert.match(buildAssignmentPrompt(mission, { ...task, role: "diagnostician" }), /test one variable at a time.*Do not edit production code/)
  assert.match(buildAssignmentPrompt(mission, task), /observe it red, make it green/)
  const wayfinder = getMissionRecipe("wayfinder")
  assert.match(wayfinder.sequence.join("\n"), /one durable decision per task does not restrict its native helper tree/)
  for (const role of ["prototype", "grilling"]) {
    assert.match(buildAssignmentPrompt({ ...mission, template: "wayfinder" }, { ...task, role }), /native Form/)
  }
  assert.match(wayfinder.coordinator, /never answer the human side yourself/)
})

test("withdrawn native assignments return terminal evidence without duplicate business reports", () => {
  const actor = { ...mission.actors[0], sessionId: "ses_native", kind: "specialist" as const }
  const withdrawn: MissionTask = { ...task, actorSessionId: actor.sessionId, status: "withdrawn", outstandingExecution: true }
  const native = buildActorContext({ ...mission, actors: [actor], tasks: [withdrawn] }, actor.sessionId)
  assert.match(native, /Do not continue new work; return terminal evidence to your parent without a mission.report copy/)
  assert.doesNotMatch(native, /submit one terminal mission.report/)
  const root = buildActorContext({ ...mission, actors: [actor], tasks: [{ ...withdrawn, executionMode: undefined }] }, actor.sessionId)
  assert.match(root, /submit one terminal mission.report if able/)
})
