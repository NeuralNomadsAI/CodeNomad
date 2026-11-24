import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { effectiveAppearance, normalizeAppearancePreferences, selectAppearancePalette } from "./appearance-preferences"
import { normalizeColorScheme } from "./theme-scheme"

describe("independent appearance preferences", () => {
  it("migrates a fixed palette without changing colors, mode or preset identity", () => {
    const legacy = normalizeColorScheme({ id: "custom", appearance: "light", colors: normalizeColorScheme("linen").colors })
    const pair = normalizeAppearancePreferences(undefined, legacy, "saved-linen")
    assert.equal(pair.mode, "light")
    assert.deepEqual(pair.light, { scheme: legacy, presetId: "saved-linen" })
    assert.equal(pair.dark.scheme.id, "mist")
  })
  it("migrates automatic mode with two soft defaults", () => {
    const pair = normalizeAppearancePreferences(undefined, normalizeColorScheme("system"))
    assert.equal(pair.mode, "system")
    assert.equal(pair.light.scheme.id, "porcelain")
    assert.equal(pair.dark.scheme.id, "mist")
  })
  it("selecting the inactive palette preserves mode and the other selection across reload", () => {
    const before = normalizeAppearancePreferences(undefined, normalizeColorScheme("slate"))
    const after = selectAppearancePalette(before, normalizeColorScheme("iris"))
    assert.equal(after.mode, "dark")
    assert.deepEqual(after.dark, before.dark)
    assert.equal(after.light.scheme.id, "iris")
    assert.deepEqual(normalizeAppearancePreferences(JSON.parse(JSON.stringify(after)), normalizeColorScheme("system")), after)
  })
  it("changing to automatic mode does not replace either slot", () => {
    const before = normalizeAppearancePreferences(undefined, normalizeColorScheme("clay"))
    const after = selectAppearancePalette(before, normalizeColorScheme("system"))
    assert.equal(after.mode, "system")
    assert.deepEqual(after.dark, before.dark)
    assert.deepEqual(after.light, before.light)
    assert.equal(effectiveAppearance(after.mode, true), "dark")
    assert.equal(effectiveAppearance(after.mode, false), "light")
    assert.equal(effectiveAppearance("light", true), "light")
    assert.equal(effectiveAppearance("dark", false), "dark")
  })
  it("rejects wrong-appearance or malformed slots without modifying the source", () => {
    const input = { mode: "bad", light: { scheme: normalizeColorScheme("clay") }, dark: null }
    const snapshot = JSON.stringify(input)
    const pair = normalizeAppearancePreferences(input, normalizeColorScheme("system"))
    assert.equal(pair.light.scheme.id, "porcelain")
    assert.equal(pair.dark.scheme.id, "mist")
    assert.equal(pair.mode, "system")
    assert.equal(JSON.stringify(input), snapshot)
  })
})
