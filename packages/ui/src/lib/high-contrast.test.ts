import assert from "node:assert/strict"
import { it } from "node:test"
import { effectiveHighContrast, HIGH_CONTRAST_CURVE, highContrastColors, normalizeHighContrastPreference } from "./high-contrast"
import { channel, oklabLightness } from "./color-contrast"
import { BUILT_IN_COLOR_SCHEMES, applyColorScheme, normalizeColorScheme, type ColorSchemeTarget } from "./theme-scheme"
import { SOFT_COLOR_SCHEMES } from "./soft-color-schemes"

const palettes = BUILT_IN_COLOR_SCHEMES.filter(s => s.colors && s.id !== "custom")

it("resolves absent, on, off and Auto preferences against the system", () => {
  assert.equal(normalizeHighContrastPreference(undefined), "auto")
  for (const system of [false, true]) {
    assert.equal(effectiveHighContrast("auto", system), system)
    assert.equal(effectiveHighContrast("on", system), true)
    assert.equal(effectiveHighContrast("off", system), false)
  }
})

it("applies the exact clamped sRGB channel curve", () => {
  assert.deepEqual(HIGH_CONTRAST_CURVE, { contrast: 1.3, pivotShift: .3 })
  for (const [input, dark, light] of [
    ["#000000", "#000000", "#000000"],
    ["#FFFFFF", "#FFFFFF", "#FFFFFF"],
    ["#808080", "#979797", "#696969"],
    ["#336699", "#3375B8", "#05478A"],
    ["#112233", "#071D33", "#000005"],
  ]) {
    const source = { ...palettes[0].colors!, accentPrimary: input }
    assert.equal(highContrastColors(source, true).accentPrimary, dark, input)
    assert.equal(highContrastColors(source, false).accentPrimary, light, input)
  }
})

it("mirrors the pivot and preserves grayscale lightness order through clipping", () => {
  assert.equal(highContrastColors({ ...palettes[0].colors!, accentPrimary: "#333333" }, true).accentPrimary, "#333333")
  assert.equal(highContrastColors({ ...palettes[0].colors!, accentPrimary: "#CCCCCC" }, false).accentPrimary, "#CCCCCC")
  let previousDark = -1, previousLight = -1
  for (let value = 0; value <= 255; value++) {
    const gray = (v: number) => `#${v.toString(16).padStart(2, "0").repeat(3).toUpperCase()}`
    const source = { ...palettes[0].colors!, accentPrimary: gray(value) }
    const dark = highContrastColors(source, true).accentPrimary
    const light = highContrastColors(source, false).accentPrimary
    const mirrored = highContrastColors({ ...source, accentPrimary: gray(255 - value) }, false).accentPrimary
    assert.ok(Math.abs(channel(dark, 1) + channel(mirrored, 1) - 255) <= 1, `mirror/${value}`)
    assert.ok(oklabLightness(dark) >= previousDark, `dark/${value}`)
    assert.ok(oklabLightness(light) >= previousLight, `light/${value}`)
    previousDark = oklabLightness(dark)
    previousLight = oklabLightness(light)
  }
})

it("curves every input, increases text/surface separation and preserves source and surface order on all 17 palettes", () => {
  assert.equal(palettes.length, 17)
  for (const palette of palettes) {
    const source = Object.freeze(structuredClone(palette.colors!))
    const dark = palette.appearance === "dark"
    const transformed = highContrastColors(source, dark)
    assert.deepEqual(Object.keys(transformed), Object.keys(source))
    for (const key of Object.keys(source) as (keyof typeof source)[]) {
      for (const offset of [1, 3, 5]) {
        const pivot = dark ? .2 : .8
        const expected = Math.round(255 * Math.max(0, Math.min(1, pivot + (channel(source[key], offset) / 255 - pivot) * 1.3)))
        assert.equal(channel(transformed[key], offset), expected, `${palette.id}/${key}/${offset}`)
      }
    }
    assert.deepEqual(source, palette.colors)
    const surfaces = ["surfaceBase", "surfaceSecondary", "surfaceMuted"] as const
    for (const surface of surfaces) {
      for (const text of ["textPrimary", "textMuted"] as const) {
        assert.ok(Math.abs(oklabLightness(transformed[text]) - oklabLightness(transformed[surface]))
          > Math.abs(oklabLightness(source[text]) - oklabLightness(source[surface])), `${palette.id}/${text}/${surface}`)
      }
      for (const other of surfaces) {
        const direction = Math.sign(oklabLightness(source[surface]) - oklabLightness(source[other]))
        assert.ok(direction * (oklabLightness(transformed[surface]) - oklabLightness(transformed[other])) >= 0,
          `${palette.id}/${surface}/${other}: clipping may tie, never reverse`)
      }
    }
  }
})

it("derives ordinary tokens with original filled-button ink and restores exact normal rendering", () => {
  const properties = new Map<string, string>()
  const target: ColorSchemeTarget = {
    style: { setProperty: (key, value) => { properties.set(key, value) }, removeProperty: key => properties.delete(key) },
    dataset: {}, setAttribute() {}, removeAttribute() {},
  }
  for (const { id } of BUILT_IN_COLOR_SCHEMES) for (const systemDark of [false, true]) {
    const scheme = normalizeColorScheme(id), snapshot = structuredClone(scheme)
    applyColorScheme(scheme, { target, systemDark })
    const normal = new Map(properties)
    for (let pass = 0; pass < 2; pass++) {
      applyColorScheme(scheme, { target, systemDark, highContrast: true })
      assert.equal(target.dataset.contrast, "more")
      for (const ink of ["--text-on-accent", "--text-inverted"]) {
        assert.equal(properties.get(ink), normal.get(ink), `${id}/${ink}: original button ink`)
      }
      const curved = new Map(properties)
      if (scheme.colors) {
        applyColorScheme({ ...scheme, colors: highContrastColors(scheme.colors, scheme.appearance === "dark") }, { target, systemDark })
        for (const ink of ["--text-on-accent", "--text-inverted"]) properties.set(ink, normal.get(ink)!)
        assert.deepEqual(properties, curved, `${id}: ordinary token derivation`)
      }
      applyColorScheme(scheme, { target, systemDark, highContrast: false })
      assert.deepEqual(properties, normal, id)
      assert.equal(target.dataset.contrast, undefined)
      assert.deepEqual(scheme, snapshot)
    }
  }
})

it("places the lightest surface in Base for the six soft light palettes", () => {
  const light = SOFT_COLOR_SCHEMES.filter(s => s.appearance === "light")
  assert.equal(light.length, 6)
  for (const { id, colors } of light) {
    assert.ok(oklabLightness(colors!.surfaceBase) > oklabLightness(colors!.surfaceSecondary), id)
  }
})
