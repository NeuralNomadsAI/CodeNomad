import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { oklab, oklabLightness, TEXT_ON_COLOR_LIGHTNESS_THRESHOLD, textOnColor, withOklabLightness } from "./color-contrast"

describe("OKLab filled-color text", () => {
  it("computes lightness from linearized sRGB", () => {
    for (const [fill, expected] of [
      ["#000000", 0], ["#FFFFFF", 1],
      ["#FF0000", .627955], ["#00FF00", .866440], ["#0000FF", .452014],
    ] as const) {
      assert.ok(Math.abs(oklabLightness(fill) - expected) < .000001, fill)
    }
  })
  it("uses white below the single lightness threshold and black above it", () => {
    assert.ok(oklabLightness("#989898") < TEXT_ON_COLOR_LIGHTNESS_THRESHOLD)
    assert.ok(oklabLightness("#999999") >= TEXT_ON_COLOR_LIGHTNESS_THRESHOLD)
    for (const fill of ["#000000", "#989898", "#0066FF", "#4D7AFE", "#665BA3", "#7F69E2", "#9D8325", "#6B7CFF", "#6C7FCB", "#8B9939"]) {
      assert.equal(textOnColor(fill), "#FFFFFF", fill)
    }
    for (const fill of ["#FFFFFF", "#999999", "#FF00FF", "#8FA8FF", "#A9BA45", "#D99254"]) {
      assert.equal(textOnColor(fill), "#000000", fill)
    }
  })
  it("keeps the fallback ink for noncanonical or nonopaque inputs", () => {
    for (const color of ["#fff", "#ffffff", "#GGGGGG", "#FFFFFF80", "red", ""]) {
      assert.equal(textOnColor(color), "#000000")
    }
  })
  it("round-trips RGB and changes lightness without clipping hue out of gamut", () => {
    for (const source of ["#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#998877", "#4D7AFE"]) {
      assert.equal(withOklabLightness(source, oklabLightness(source)), source)
      assert.equal(withOklabLightness(source, 0), "#000000")
      assert.equal(withOklabLightness(source, 1), "#FFFFFF")
      const [, a, b] = oklab(source)
      for (const lightness of [.2, .5, .8]) {
        const result = withOklabLightness(source, lightness)
        const [l, x, y] = oklab(result)
        assert.ok(Math.abs(l - lightness) < .003, `${source} -> ${result}: lightness`)
        assert.ok(Math.hypot(x, y) <= Math.hypot(a, b) + .003, `${source}: source chroma ceiling`)
        if (Math.hypot(a, b) < .005) continue
        const delta = Math.abs(Math.atan2(b, a) - Math.atan2(y, x)) * 180 / Math.PI
        assert.ok(Math.min(delta, 360 - delta) < 3, `${source} -> ${result}: hue`)
      }
    }
  })
})
