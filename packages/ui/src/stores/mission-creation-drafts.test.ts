import assert from "node:assert/strict"
import test from "node:test"
import { holdMissionCreation, missionCreationHold, missionCreationPayloadIdentity, releaseMissionCreation, retainUncertainMissionCreation,
  uncertainMissionCreation, reconcileMissionCreation, consumeMissionCreation } from "./mission-creation-drafts"
import { serverApi } from "../lib/api-client"
const owner = { client: {}, generation: 1 }, current = () => true

test("a confirmed result remains held until its owning view consumes it", async t => {
  const operation = { requestId: "hidden-result", objective: "Original", notes: "", template: "custom" as const }
  retainUncertainMissionCreation("hidden-result/scope", operation)
  t.mock.method(serverApi, "missionCreationReceipt", async () => ({ requestId: operation.requestId, state: "created", mission: { id: "msn_original" } }))
  const receipt = await reconcileMissionCreation("hidden-result/scope", "original-instance", owner, current)
  assert.equal(receipt?.state, "created")
  assert.ok(missionCreationHold("hidden-result/scope"))
  assert.equal(holdMissionCreation("hidden-result/scope", { ...operation, requestId: "duplicate" }), false)
  assert.equal(await reconcileMissionCreation("hidden-result/scope", "original-instance", owner, current), receipt)
  assert.equal(consumeMissionCreation("hidden-result/scope", receipt!, owner), true)
})

test("exact original receipts release created/rejected holds; unknown and foreign receipts cannot authorize duplicates", async t => {
  const operation = { requestId: "receipt-original", objective: "Original", notes: "", template: "custom" as const, directory: "/original" }
  let receipt: any = { requestId: operation.requestId, state: "unknown" }, reads = 0
  t.mock.method(serverApi, "missionCreationReceipt", async (instanceId: string, requestId: string) => {
    reads++; assert.equal(instanceId, "original-instance"); assert.equal(requestId, operation.requestId)
    return receipt
  })
  for (const state of ["created", "rejected"] as const) {
    const scope = `receipt/${state}`
    holdMissionCreation(scope, operation); retainUncertainMissionCreation(scope, operation)
    for (const response of [{ requestId: operation.requestId, state: "unknown" }, { requestId: "other", state: "rejected" }, {}]) {
      receipt = response
      assert.equal(await reconcileMissionCreation(scope, "original-instance", owner, current), undefined)
      assert.equal(holdMissionCreation(scope, { ...operation, requestId: "duplicate" }), false)
    }
    receipt = { requestId: operation.requestId, state, ...(state === "created" ? { mission: { id: "msn_original" } } : {}) }
    const result = await reconcileMissionCreation(scope, "original-instance", owner, current)
    assert.equal(result?.state, state)
    assert.ok(missionCreationHold(scope), "proof stays held before a current view consumes it")
    assert.equal(consumeMissionCreation(scope, result!, owner), true)
    assert.equal(missionCreationHold(scope), undefined)
  }
  assert.equal(reads, 8)
})

test("replacement client or native generation starts a fresh read and cannot consume an old receipt", async t => {
  for (const change of ["client", "generation"] as const) {
    const scope = `connection/${change}`, operation = { requestId: `connection-${change}`, objective: "Original", notes: "", template: "custom" as const }
    const original = { client: {}, generation: 1 }, replacement = change === "client" ? { ...original, client: {} } : { ...original, generation: 2 }
    let live = original
    const calls: Array<{ resolve(value: any): void; signal: AbortSignal }> = []
    t.mock.method(serverApi, "missionCreationReceipt", (_instance: string, _request: string, signal: AbortSignal) =>
      new Promise(resolve => calls.push({ resolve, signal })))
    retainUncertainMissionCreation(scope, operation)
    const first = reconcileMissionCreation(scope, "fixture", original, () => live === original)
    await Promise.resolve()
    assert.equal(calls.length, 1)
    live = replacement
    const second = reconcileMissionCreation(scope, "fixture", replacement, () => live === replacement)
    await Promise.resolve()
    assert.notEqual(second, first)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].signal.aborted, true)
    calls[0].resolve({ requestId: operation.requestId, state: "rejected" })
    assert.equal(await first, undefined)
    assert.ok(missionCreationHold(scope))
    calls[1].resolve({ requestId: operation.requestId, state: "rejected" })
    const result = await second
    assert.equal(consumeMissionCreation(scope, result!, original), false)
    assert.equal(consumeMissionCreation(scope, result!, replacement), true)
  }
})

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

test("a dispatched creation fences its scope until its exact definitive outcome; unknown outcomes never release", () => {
  const operation = { requestId: "pending-original", objective: "Draft", notes: "", template: "custom" as const }
  assert.equal(holdMissionCreation("pending/scope", operation), true)
  assert.equal(missionCreationHold("pending/scope")!.state, "pending")
  assert.equal(uncertainMissionCreation("pending/scope"), undefined, "a pending reply is not yet an unknown outcome")
  assert.equal(holdMissionCreation("pending/scope", { ...operation, requestId: "second" }), false, "no second logical creation in the scope")
  releaseMissionCreation("pending/scope", "other-request")
  assert.equal(missionCreationHold("pending/scope")!.operation.requestId, "pending-original")
  releaseMissionCreation("pending/scope", "pending-original")
  assert.equal(missionCreationHold("pending/scope"), undefined)
  assert.equal(holdMissionCreation("pending/scope", operation), true)
  retainUncertainMissionCreation("pending/scope", { ...operation, objective: "Changed" })
  releaseMissionCreation("pending/scope", "pending-original")
  assert.equal(missionCreationHold("pending/scope")!.state, "uncertain")
  assert.equal(uncertainMissionCreation("pending/scope")!.objective, "Draft", "the original submitted payload is retained")
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

test("followed source identity and immutable draft survive lost creation replies", () => {
  const original = { requestId: "followed-original", objective: "Read", notes: "", template: "custom" as const, watchedConversationIDs: ["ses_one"] }
  const identity = missionCreationPayloadIdentity(original)
  retainUncertainMissionCreation("followed/scope", original)
  original.watchedConversationIDs[0] = "ses_changed"
  assert.deepEqual(uncertainMissionCreation("followed/scope")!.watchedConversationIDs, ["ses_one"])
  assert.notEqual(identity, missionCreationPayloadIdentity(original))
  assert.notEqual(identity, missionCreationPayloadIdentity({ ...original, watchedConversationIDs: undefined }))
})
