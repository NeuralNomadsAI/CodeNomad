import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { contrastRatio, luminance, mix, oklabLightness } from "./color-contrast"
import { effectiveHighContrast, HIGH_CONTRAST_SURFACE_STRENGTH, HIGH_CONTRAST_TARGETS, highContrastColors, highContrastProperties, normalizeHighContrastPreference, strengthenContrast } from "./high-contrast"
import { applyColorScheme, BUILT_IN_COLOR_SCHEMES, normalizeColorScheme } from "./theme-scheme"

describe("high contrast preference", () => {
  it("normalizes absent and invalid values without treating truthy values as on", () => {
    for (const value of [undefined, null, true, false, 1, "ON", "more", {}, []]) {
      assert.equal(normalizeHighContrastPreference(value), "auto")
    }
    for (const value of ["auto", "on", "off"] as const) assert.equal(normalizeHighContrastPreference(value), value)
  })
  it("follows dynamic system contrast only in Auto", () => {
    for (const system of [false, true, false]) {
      assert.equal(effectiveHighContrast("auto", system), system)
      assert.equal(effectiveHighContrast("on", system), true)
      assert.equal(effectiveHighContrast("off", system), false)
    }
    assert.equal(effectiveHighContrast("auto"), false)
  })
})

describe("strengthenContrast", () => {
  it("keeps the final source record immutable during custom rendering adaptation", () => {
    const source: Record<string, string> = {}
    applyColorScheme(normalizeColorScheme("parchment"), {
      target: {
        style: { setProperty: (key, value) => { source[key] = value }, removeProperty: key => { delete source[key] } },
        dataset: {}, setAttribute() {}, removeAttribute() {},
      },
    })
    const snapshot = structuredClone(source)
    Object.freeze(source)
    const properties = highContrastProperties(source, { dark: false })
    assert.deepEqual(source, snapshot)
    assert.notEqual(properties, source)
    for (const key of Object.keys(source).filter(key => key.startsWith("--surface-") && !key.includes("hover"))) {
      assert.equal(properties[key], source[key], key)
    }
  })
  it("copies only Base and Secondary inputs for every palette and validates strength", () => {
    assert.deepEqual(HIGH_CONTRAST_SURFACE_STRENGTH, { dark: 0.2, light: 0.8 })
    for (const scheme of BUILT_IN_COLOR_SCHEMES.filter(s => s.colors)) {
      const source = Object.freeze({ ...scheme.colors! })
      const snapshot = structuredClone(source)
      const dark = scheme.appearance === "dark"
      for (const strength of [0, .2, .3, .35, .5, .6, .9, 1]) {
        const colors = highContrastColors(source, dark, strength)
        for (const key of Object.keys(source) as (keyof typeof source)[]) {
          if (key === "surfaceBase" || key === "surfaceSecondary") {
            assert.ok(dark ? luminance(colors[key]) <= luminance(source[key]) : luminance(colors[key]) >= luminance(source[key]))
          } else assert.equal(colors[key], source[key], `${scheme.id}: ${key}`)
        }
        if (!strength) assert.deepEqual(colors, source)
        assert.deepEqual(source, snapshot)
      }
      for (const strength of [-1, 1.01, NaN, Infinity]) {
        assert.throws(() => highContrastColors(source, dark, strength), RangeError)
      }
    }
  })
  it("moves Secondary by half the absolute Base lightness delta in both appearances", () => {
    for (const scheme of BUILT_IN_COLOR_SCHEMES.filter(s => s.colors && s.id !== "custom")) {
      const dark = scheme.appearance === "dark"
      const source = scheme.colors!
      const colors = highContrastColors(source, dark)
      assert.equal(new Set([colors.surfaceBase, colors.surfaceSecondary, colors.surfaceMuted]).size, 3,
        `${scheme.id}: three distinct background levels`)
      const base = oklabLightness(source.surfaceBase), secondary = oklabLightness(source.surfaceSecondary)
      const baseDelta = oklabLightness(colors.surfaceBase) - base
      const secondaryDelta = oklabLightness(colors.surfaceSecondary) - secondary
      // RGB byte quantization rounds each independent OKLCH lightness move.
      assert.ok(Math.abs(baseDelta - ((dark ? 0 : 1) - base) * HIGH_CONTRAST_SURFACE_STRENGTH[dark ? "dark" : "light"]) < .003, scheme.id)
      assert.ok(Math.abs(secondaryDelta - baseDelta * .5) < .003, scheme.id)
      const gap = Math.abs(secondary - base)
      const finalGap = Math.abs(oklabLightness(colors.surfaceSecondary) - oklabLightness(colors.surfaceBase))
      if (scheme.id !== "light") assert.ok(finalGap > gap, `${scheme.id}: expanding ${scheme.appearance} gap`)
      else assert.ok(Math.abs(finalGap - gap) < .003, `${scheme.id}: Base already white`)
    }
    for (const dark of [true, false]) {
      const source = { ...normalizeColorScheme("custom").colors!,
        surfaceBase: dark ? "#333333" : "#CCCCCC", surfaceSecondary: dark ? "#555555" : "#AAAAAA" }
      const colors = highContrastColors(source, dark)
      assert.ok(Math.abs(oklabLightness(colors.surfaceSecondary) - oklabLightness(colors.surfaceBase))
        > Math.abs(oklabLightness(source.surfaceSecondary) - oklabLightness(source.surfaceBase)))
    }
  })
  it("keeps custom inputs immutable, including opposing and extreme surfaces", () => {
    for (const dark of [true, false]) {
      for (const surfaceMuted of ["#000000", "#FFFFFF", "#777777", "#FF00FF"]) {
        const source = Object.freeze({ ...normalizeColorScheme("custom").colors!, surfaceBase: "#FFFFFF", surfaceSecondary: "#000000", surfaceMuted })
        const colors = highContrastColors(source, dark)
        assert.equal(colors.surfaceMuted, surfaceMuted)
        assert.equal(source.surfaceBase, "#FFFFFF")
        const properties: Record<string, string> = {}
        applyColorScheme({ id: "custom", appearance: dark ? "dark" : "light", colors: source }, {
          highContrast: true, target: {
            style: { setProperty: (key, value) => { properties[key] = value }, removeProperty() {} },
            dataset: {}, setAttribute() {}, removeAttribute() {},
          },
        })
        assert.equal(properties["--surface-muted"], surfaceMuted)
        assert.match(properties["--text-primary"], /^#[0-9A-F]{6}$/)
      }
    }
  })
  it("leaves sufficient colors exact and measures the quantized result", () => {
    assert.deepEqual(HIGH_CONTRAST_TARGETS, { text: 7.5, nonText: 3.5 })
    assert.equal(strengthenContrast("#FFFFFF", ["#000000"], 7.5), "#FFFFFF")
    for (const background of ["#FFFFFF", "#D5C09E", "#55524E", "#17181A"]) {
      for (const target of [7.5, 3.5]) {
        const result = strengthenContrast("#998877", [background], target)
        assert.ok(contrastRatio(result, background) >= target, `${result} on ${background}`)
        assert.equal(strengthenContrast("#998877", [background], target), result)
      }
    }
  })
  it("finds the first passing byte on a grayscale path, rather than rounding below target", () => {
    const result = strengthenContrast("#888888", ["#FFFFFF"], 7.5)
    const next = Number.parseInt(result.slice(1, 3), 16) + 1
    const weaker = `#${next.toString(16).repeat(3).toUpperCase()}`
    assert.ok(contrastRatio(result, "#FFFFFF") >= 7.5)
    assert.ok(contrastRatio(weaker, "#FFFFFF") < 7.5)
    assert.equal(mix("#000000", "#FFFFFF", 0), "#FFFFFF")
  })
  it("maximizes attainable contrast on immutable intermediate or opposing custom backgrounds", () => {
    assert.equal(strengthenContrast("#777777", ["#777777"], 7.5), "#000000")
    const backgrounds = ["#000000", "#FFFFFF"]
    const value = strengthenContrast("#777777", backgrounds, 7.5)
    assert.ok(["#000000", "#FFFFFF"].includes(value))
    assert.equal(Math.min(...backgrounds.map(bg => contrastRatio(value, bg))), 1)
  })
  it("finds attainable intermediate border colors on opposing custom surfaces", () => {
    const backgrounds = ["#000000", "#FFFFFF"]
    const result = strengthenContrast("#101010", backgrounds, 3.5)
    for (const bg of backgrounds) assert.ok(contrastRatio(result, bg) >= 3.5, `${result} on ${bg}`)
  })
  it("rejects malformed colors and invalid targets at the boundary", () => {
    for (const color of ["#fff", "#ffffff", "red", "var(--text-primary)", ""]) {
      assert.throws(() => strengthenContrast(color, ["#FFFFFF"], 7.5), RangeError)
    }
    for (const target of [NaN, Infinity, 0, 22]) assert.throws(() => strengthenContrast("#000000", ["#FFFFFF"], target), RangeError)
    assert.throws(() => strengthenContrast("#000000", [], 7.5), RangeError)
    assert.throws(() => strengthenContrast("#000000", ["invalid"], 7.5), RangeError)
  })
})
