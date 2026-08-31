import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { DEFAULT_CUSTOM_COLORS, LIGHT_COLOR_SCHEME_COLORS, validateColorSchemeColors } from "./theme-scheme.ts"
import { nextColorSchemePresetName, normalizeColorSchemePresets } from "./color-scheme-presets.ts"

describe("color scheme presets", () => {
  it("normalizes saved presets and increments derived names", () => {
    assert.deepEqual(normalizeColorSchemePresets({
      valid: { name: " Fjord 2 ", appearance: "dark", colors: DEFAULT_CUSTOM_COLORS },
      invalid: { name: "Broken", appearance: "dark", colors: { surfaceBase: "#fff" } },
    }), {
      valid: { name: "Fjord 2", appearance: "dark", colors: DEFAULT_CUSTOM_COLORS },
    })
    assert.equal(nextColorSchemePresetName("Fjord", ["Fjord 2", "Fjord 3"]), "Fjord 4")
    assert.equal(nextColorSchemePresetName("Fjord 2", ["Fjord 2"]), "Fjord 3")
    assert.equal(validateColorSchemeColors(LIGHT_COLOR_SCHEME_COLORS), true)
  })
})
