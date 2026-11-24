import assert from "node:assert/strict"
import test from "node:test"
import { matchesExecution, sameExecution } from "./execution"

const requested = { agent: "worker", model: { providerID: "fixture", id: "fixture" } }
const nativeCreated = { ...requested, model: { ...requested.model, variant: "default" } }

test("native default variant resolution does not block the freshly created assignment", () => {
  assert.equal(matchesExecution(requested, nativeCreated), true)
  assert.equal(matchesExecution(nativeCreated, requested), true)
  assert.equal(matchesExecution(requested, requested), true)
  // Contract identity/replay stays exact, independent of native matching.
  assert.equal(sameExecution(requested, nativeCreated), false)
})

test("default normalization never admits another model, agent, or thinking variant", () => {
  assert.equal(matchesExecution(requested, { ...nativeCreated, agent: "other" }), false)
  for (const model of [{ ...nativeCreated.model, variant: "high" }, { ...nativeCreated.model, id: "other" },
    { ...nativeCreated.model, providerID: "other" }]) {
    assert.equal(matchesExecution(requested, { agent: requested.agent, model }), false)
  }
  assert.equal(matchesExecution({ ...requested, model: { ...requested.model, variant: "high" } }, nativeCreated), false)
  assert.equal(matchesExecution(requested, { agent: requested.agent }), false)
})
