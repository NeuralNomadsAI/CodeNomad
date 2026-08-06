import assert from "node:assert/strict"
import test from "node:test"
import {
  isModelVisible,
  normalizeModelVisibilityPreference,
  normalizeModelVisibilityPreferences,
} from "./model-visibility"

test("normalizes malformed preferences fail-open", () => {
  assert.deepEqual(normalizeModelVisibilityPreference(null), { hiddenModelIds: [] })
  assert.deepEqual(normalizeModelVisibilityPreference({ mode: "custom", modelIds: ["legacy"] }), { hiddenModelIds: [] })
  assert.deepEqual(normalizeModelVisibilityPreference({ hiddenModelIds: "hidden" }), { hiddenModelIds: [] })
  assert.deepEqual(normalizeModelVisibilityPreferences([]), {})
  assert.deepEqual(normalizeModelVisibilityPreferences({ broken: { hiddenModelIds: null } }), {
    broken: { hiddenModelIds: [] },
  })
})

test("keeps unique non-empty exact IDs without catalog-based deletion", () => {
  assert.deepEqual(
    normalizeModelVisibilityPreference({ hiddenModelIds: ["Model-A", "model-a", "", "Model-A", 7] }),
    { hiddenModelIds: ["Model-A", "model-a"] },
  )
})

test("matches hidden IDs exactly and case-sensitively", () => {
  const preference = { hiddenModelIds: ["Model-A"] }
  assert.equal(isModelVisible(preference, "Model-A"), false)
  assert.equal(isModelVisible(preference, "model-a"), true)
})

test("new models and missing preferences are visible by default", () => {
  assert.equal(isModelVisible({ hiddenModelIds: ["known"] }, "new"), true)
  assert.equal(isModelVisible(undefined, "new"), true)
})

test("a current model receives no helper-level visibility override", () => {
  assert.equal(isModelVisible({ hiddenModelIds: ["current"] }, "current"), false)
})
