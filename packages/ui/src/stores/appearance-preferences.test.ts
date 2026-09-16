import assert from "node:assert/strict"
import { it } from "node:test"
import { storage } from "../lib/storage"
import { normalizeColorScheme } from "../lib/theme-scheme"

function merge(target: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const result = structuredClone(target)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = typeof value === "object" && !Array.isArray(value)
      ? merge(result[key] ?? {}, value) : value
  }
  return result
}

it("persists independent palettes, queued changes, overrides, deletion and failed writes", async () => {
  const originals = {
    loadConfigOwner: storage.loadConfigOwner, loadStateOwner: storage.loadStateOwner,
    patchStateOwner: storage.patchStateOwner, patchConfigOwner: storage.patchConfigOwner,
  }
  const legacy = normalizeColorScheme("slate")
  let state: Record<string, any> = { colorScheme: legacy, theme: "dark", untouched: { value: 123 } }
  let fail = false
  storage.loadConfigOwner = async () => ({})
  storage.loadStateOwner = async () => structuredClone(state)
  storage.patchConfigOwner = async () => ({})
  storage.patchStateOwner = async (_owner, patch) => {
    if (fail) throw new Error("Simulated storage failure")
    state = merge(state, patch as Record<string, any>)
    return structuredClone(state)
  }
  try {
    const {
      deleteColorSchemePreset, getAppearancePalette, getAppearancePresetId,
      resetColorSchemeOverride, saveColorSchemeOverride, saveColorSchemePreset,
      setColorSchemePreference, setThemePreference, themePreference, updatePreferences,
    } = await import("./preferences")
    await updatePreferences({}) // Load the legacy profile before interaction.
    assert.equal(themePreference(), "dark")
    assert.equal(getAppearancePalette("dark").id, "slate")
    await Promise.all([
      setColorSchemePreference(normalizeColorScheme("linen")),
      setColorSchemePreference(normalizeColorScheme("sage")),
      setThemePreference("system"),
    ])
    assert.equal(themePreference(), "system")
    assert.equal(getAppearancePalette("light").id, "linen")
    assert.equal(getAppearancePalette("dark").id, "sage")
    assert.deepEqual(state.untouched, { value: 123 })

    const colors = { ...getAppearancePalette("light").colors!, accentPrimary: "#665544" }
    await saveColorSchemeOverride("linen", "light", colors)
    assert.equal(themePreference(), "system")
    assert.equal(getAppearancePalette("light").colors!.accentPrimary, "#665544")
    await resetColorSchemeOverride("linen")
    assert.deepEqual(getAppearancePalette("light"), normalizeColorScheme("linen"))

    const id = await saveColorSchemePreset("Saved light", "light", colors)
    assert.equal(getAppearancePresetId("light"), id)
    await setThemePreference("dark")
    assert.equal(getAppearancePresetId("light"), id)
    await deleteColorSchemePreset(id)
    assert.equal(getAppearancePresetId("light"), undefined)
    assert.deepEqual(getAppearancePalette("light").colors, colors)
    assert.equal(getAppearancePalette("dark").id, "sage")

    const snapshot = structuredClone(state)
    fail = true
    await assert.rejects(setThemePreference("light"), /Simulated/)
    assert.equal(themePreference(), "dark")
    assert.deepEqual(state, snapshot)
    fail = false
    await setThemePreference("light")
    assert.equal(themePreference(), "light")
    assert.deepEqual(getAppearancePalette("light").colors, colors)
  } finally { Object.assign(storage, originals) }
})
