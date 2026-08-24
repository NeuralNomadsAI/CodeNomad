import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import {
  isModelVisible,
  normalizeModelVisibilityPreference,
  normalizeModelVisibilityPreferences,
  resolvePickerValue,
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

test("uses the current model as the picker value only while it remains in the collection", () => {
  const current = { key: "provider/current" }
  assert.equal(resolvePickerValue(current, [current]), current)
  assert.equal(resolvePickerValue(current, [{ key: "provider/visible" }]), undefined)
})

test("provider refresh updates shared and modal catalogs without disposing active instances", () => {
  const source = fs.readFileSync(
    new URL("../components/provider-auth/provider-manager-modal.tsx", import.meta.url),
    "utf8",
  )
  const start = source.indexOf("async function refreshProviderData()")
  const end = source.indexOf("function closeModelManager()", start)
  const refresh = source.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(refresh, /await fetchProviders\(instanceId\)/)
  assert.match(refresh, /await loadProviderData\(authClient\)/)
  assert.doesNotMatch(refresh, /global\.dispose/)
})

test("model picker wires collection-safe selection and an accessible current-model label", () => {
  const source = fs.readFileSync(new URL("../components/model-selector.tsx", import.meta.url), "utf8")
  assert.match(source, /value=\{comboboxValue\(\)\}/)
  assert.equal(source.match(/aria-label=\{currentModelAccessibleLabel\(\)\}/g)?.length, 2)
  assert.match(source, /id: `\$\{current\.providerId\}\/\$\{current\.id\}`/)
})

test("serializes visibility writes across providers before installing server snapshots", () => {
  const source = fs.readFileSync(new URL("../stores/preferences.tsx", import.meta.url), "utf8")
  assert.match(source, /let modelVisibilityWriteQueue = Promise\.resolve\(\)/)
  assert.match(source, /const previous = modelVisibilityWriteQueue/)
  assert.match(source, /modelVisibilityWriteQueue = write/)
})
