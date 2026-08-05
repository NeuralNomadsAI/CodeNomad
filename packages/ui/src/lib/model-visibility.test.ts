import assert from "node:assert/strict"
import test from "node:test"
import {
  getUnavailableSelectedModelIds,
  isModelVisible,
  normalizeModelVisibilityPreference,
  normalizeModelVisibilityPreferences,
  seedCustomModelVisibility,
} from "./model-visibility"

test("normalizes malformed preferences fail-open", () => {
  assert.deepEqual(normalizeModelVisibilityPreference(null), { mode: "all" })
  assert.deepEqual(normalizeModelVisibilityPreference({ mode: "custom" }), { mode: "all" })
  assert.deepEqual(normalizeModelVisibilityPreferences([]), {})
  assert.deepEqual(normalizeModelVisibilityPreferences({ broken: { mode: "nope" } }), {
    broken: { mode: "all" },
  })
})

test("keeps unique non-empty exact IDs without catalog-based deletion", () => {
  assert.deepEqual(
    normalizeModelVisibilityPreference({ mode: "custom", modelIds: ["Model-A", "model-a", "", "Model-A", 7] }),
    { mode: "custom", modelIds: ["Model-A", "model-a"] },
  )
})

test("matches IDs case-sensitively and overrides a hidden current model", () => {
  const preference = { mode: "custom", modelIds: ["Model-A"] } as const
  assert.equal(isModelVisible(preference, "Model-A"), true)
  assert.equal(isModelVisible(preference, "model-a"), false)
  assert.equal(isModelVisible(preference, "hidden", "hidden"), true)
})

test("new models follow mode while disappeared selections are retained", () => {
  const custom = { mode: "custom", modelIds: ["known", "disappeared"] } as const
  assert.equal(isModelVisible(custom, "new"), false)
  assert.equal(isModelVisible({ mode: "all" }, "new"), true)
  assert.deepEqual(getUnavailableSelectedModelIds(custom, ["known", "new"]), ["disappeared"])
  assert.deepEqual(seedCustomModelVisibility(["known", "new", "known"]), {
    mode: "custom",
    modelIds: ["known", "new"],
  })
})
