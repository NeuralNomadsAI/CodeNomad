import assert from "node:assert/strict"
import test from "node:test"
import { missionCreationPayloadIdentity, retainUncertainMissionCreation, uncertainMissionCreation } from "./mission-creation-drafts"

test("uncertain creation keeps immutable original request/draft in its window scope, never adopting a refreshed scope", () => {
  const original = { requestId: "original", objective: "Draft", notes: "Notes", template: "custom" as const, directory: "/private" }
  retainUncertainMissionCreation("instance/directory/project", original)
  original.objective = "Changed"
  retainUncertainMissionCreation("instance/directory/project", { ...original, requestId: "original" })
  assert.equal(uncertainMissionCreation("instance/directory/project")!.objective, "Draft")
  assert.equal(uncertainMissionCreation("instance/directory/project")!.requestId, "original")
  assert.equal(uncertainMissionCreation("other-instance/directory/project"), undefined)
  assert.equal(uncertainMissionCreation("instance/other-directory/project"), undefined)
  assert.equal(uncertainMissionCreation("instance/directory/other-project"), undefined)
})

test("unknown creation retains a deep-frozen copy of all profile selections, including variant", () => {
  const profiles = { coordinator: { agent: "root", model: { providerID: "p", id: "m", variant: "high" } }, roles: {
    "review-spec": { agent: "child", model: { providerID: "p", id: "m", variant: "low" } },
  } }
  const operation = { requestId: "profile-original", objective: "Review", notes: "", template: "debug" as const, profiles }
  retainUncertainMissionCreation("profiles/scope", operation)
  profiles.coordinator.model.variant = "changed"
  profiles.roles["review-spec"].agent = "changed"
  retainUncertainMissionCreation("profiles/scope", { ...operation, profiles: undefined })
  const saved = uncertainMissionCreation("profiles/scope")!
  assert.equal(saved.profiles!.coordinator!.model!.variant, "high")
  assert.equal(saved.profiles!.roles!["review-spec"].agent, "child")
  for (const value of [saved, saved.profiles, saved.profiles!.coordinator, saved.profiles!.coordinator!.model,
    saved.profiles!.roles, saved.profiles!.roles!["review-spec"], saved.profiles!.roles!["review-spec"].model]) assert.ok(Object.isFrozen(value))
  assert.equal(Object.isFrozen(profiles), false)
})

test("logical retry identity includes profiles and variant but not role insertion order", () => {
  const base = { objective: "Review", notes: "", template: "debug" as const }
  const profiles = { coordinator: { agent: "root" }, roles: { validator: {}, "review-spec": { model: { providerID: "p", id: "m", variant: "high" } } } }
  const original = missionCreationPayloadIdentity({ ...base, profiles })
  assert.equal(original, missionCreationPayloadIdentity({ ...base, profiles: { ...profiles, roles: { "review-spec": profiles.roles["review-spec"], validator: {} } } }))
  for (const other of [undefined, {}, { ...profiles, coordinator: { agent: "other" } },
    { ...profiles, roles: { ...profiles.roles, "review-spec": { model: { providerID: "p", id: "m", variant: "low" } } } },
  ]) assert.notEqual(original, missionCreationPayloadIdentity({ ...base, profiles: other }))
  assert.notEqual(missionCreationPayloadIdentity(base), missionCreationPayloadIdentity({ ...base, profiles: {} }))
  assert.notEqual(missionCreationPayloadIdentity(base), missionCreationPayloadIdentity({ ...base, taskMode: "native" }))
  assert.notEqual(missionCreationPayloadIdentity({ ...base, taskMode: "native" }), missionCreationPayloadIdentity({ ...base, taskMode: "independent" }))
})
