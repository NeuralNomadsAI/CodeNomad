import assert from "node:assert/strict"
import { test } from "node:test"
import { missionProfileRoles } from "../../../server/src/missions/playbook-profiles"
import { groupMissionProfileSummary, missionExecutionLabel } from "./mission-profile-summary-data"

test("labels name known models and keep exact IDs for the others", () => {
  const execution = { agent: "build", model: { providerID: "claude-code", id: "claude-opus-5-5[1m]", variant: "high" } }
  assert.equal(missionExecutionLabel(execution), "build / claude-code/claude-opus-5-5[1m] / high")
  assert.equal(missionExecutionLabel(execution, model => model.id === "claude-opus-5-5[1m]" ? "Opus 5.5 Fast" : undefined), "build / Opus 5.5 Fast / high")
  assert.equal(missionExecutionLabel({ model: { providerID: "p", id: "m" } }, () => undefined), "p/m")
  assert.equal(missionExecutionLabel({}, () => "never"), undefined)
})

test("all omitted/explicit native default roles form a single choice", () => {
  for (const template of ["custom", "wayfinder", "debug", "delivery", "compare"] as const) {
    assert.deepEqual(groupMissionProfileSummary(undefined, template), [{ roles: ["coordinator", ...missionProfileRoles[template]] }])
    assert.deepEqual(groupMissionProfileSummary({ coordinator: {}, roles: Object.fromEntries(missionProfileRoles[template].map(role => [role, {}])) }, template),
      [{ roles: ["coordinator", ...missionProfileRoles[template]] }])
  }
})

test("fanned-out global task choices display once and retain every localized-role identity", () => {
  const task = { agent: "child", model: { providerID: "p", id: "m", variant: "high" } }
  const profiles = { coordinator: { agent: "root" }, roles: Object.fromEntries(missionProfileRoles["debug"].map(role => [role, structuredClone(task)])) }
  const snapshot = structuredClone(profiles)
  assert.deepEqual(groupMissionProfileSummary(profiles, "debug"), [
    { roles: ["coordinator"], execution: { agent: "root" } }, { roles: [...missionProfileRoles["debug"]], execution: task },
  ])
  assert.deepEqual(profiles, snapshot)
})

test("agent/provider/model/variant differences never hide distinct overrides", () => {
  const execution = { agent: "child", model: { providerID: "p", id: "m", variant: "high" } }
  const groups = groupMissionProfileSummary({ coordinator: execution, roles: {
    cartographer: { ...execution, agent: "other" }, research: { ...execution, model: { ...execution.model, providerID: "q" } },
    prototype: { ...execution, model: { ...execution.model, id: "other" } },
    grilling: { ...execution, model: { ...execution.model, variant: "low" } }, decision: structuredClone(execution),
  } }, "wayfinder")
  assert.equal(groups.length, 5)
  assert.deepEqual(groups[0].roles, ["coordinator", "decision"])
  assert.deepEqual(groups.slice(1).map(group => group.roles), [["cartographer"], ["research"], ["prototype"], ["grilling"]])
})
