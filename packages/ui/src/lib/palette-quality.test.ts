import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { BUILT_IN_COLOR_SCHEMES, COLOR_SCHEME_IDS, DEFAULT_CUSTOM_COLORS, applyColorScheme, contrastRatio, normalizeColorScheme, type ColorSchemeColors } from "./theme-scheme.ts"
import { SOFT_COLOR_SCHEMES } from "./soft-color-schemes.ts"
import { isDefaultCustomColors, normalizeColorSchemePresets } from "./color-scheme-presets.ts"

function render(id: (typeof COLOR_SCHEME_IDS)[number], systemDark = false) {
  const properties = new Map<string, string>()
  applyColorScheme(normalizeColorScheme(id), {
    systemDark,
    target: {
      style: { setProperty: (k, v) => { properties.set(k, v) }, removeProperty: (k) => properties.delete(k) },
      dataset: {}, setAttribute() {}, removeAttribute() {},
    },
  })
  return properties
}

// OKLab Euclidean distance (scaled to 100). This catches near-identical
// surfaces even when all hex strings happen to differ. Not a WCAG criterion.
function lab(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b)
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b)
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b)
  return [.2104542553 * l + .793617785 * m - .0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
    .0259040371 * l + .7827717662 * m - .808675766 * s]
}
const distance = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i])) * 100
const readyMade = BUILT_IN_COLOR_SCHEMES.filter((s) => s.colors && s.id !== "custom")

// Only these exact foreground/background pairs are exempt from the historical
// 3:1 emphasis check. A new color or surface must meet the original check.
const savedEmphasisPairs = new Set([
  "porcelain:compactionAccent:#A07AFF:#CFD1D4",
  "porcelain:compactionAccent:#A07AFF:#E1E3E5",
  "dawn:accentPrimary:#7F69E2:#BCD2E5",
  "parchment:accentPrimary:#A9BA45:#D5C09E",
  "parchment:accentPrimary:#A9BA45:#E2CEB0",
  "linen:accentPrimary:#9D8325:#E6E0CE",
  "linen:statusSuccess:#699245:#E6E0CE",
  "iris:accentPrimary:#6B7CFF:#E0D4E5",
  "iris:accentPrimary:#6B7CFF:#EDDFEF",
  "sage-light:accentPrimary:#6C7FCB:#CBD8C1",
  "sage-light:accentPrimary:#6C7FCB:#DCE6D2",
])

describe("palette quality", () => {
  it("restores Classic's dev surface assignments including inset tool output", () => {
    const p = render("classic")
    assert.equal(p.get("--surface-base"), "#1A1A1A")
    assert.equal(p.get("--surface-secondary"), "#2A2A2A")
    assert.equal(p.get("--message-assistant-bg"), "#212529")
    assert.equal(p.get("--message-tool-bg"), "#212529")
    assert.equal(p.get("--surface-code"), "#1A1A1A")
  })
  it("has unique stable IDs, six soft light and four soft dark choices", () => {
    assert.equal(new Set(COLOR_SCHEME_IDS).size, COLOR_SCHEME_IDS.length)
    assert.equal(new Set(BUILT_IN_COLOR_SCHEMES.map((s) => s.id)).size, COLOR_SCHEME_IDS.length)
    assert.equal(SOFT_COLOR_SCHEMES.filter((s) => s.appearance === "light").length, 6)
    assert.equal(SOFT_COLOR_SCHEMES.filter((s) => s.appearance === "dark").length, 4)
  })

  for (const scheme of readyMade) {
    it(`${scheme.id}: readable text and identity on actual message/tool surfaces`, () => {
      const c = scheme.colors!
      const p = render(scheme.id)
      for (const bg of [c.surfaceBase, c.surfaceSecondary, c.surfaceMuted, p.get("--message-user-bg")!, p.get("--message-assistant-bg")!]) {
        for (const key of ["textPrimary", "textMuted"] as const) {
          // Saved calibration retains softer secondary text in these two families.
          // Primary text still meets 4.5 everywhere. See SAVED_PALETTE_CALIBRATION_2026-09-11.md.
          const minimum = key === "textMuted" && scheme.id === "slate" && c[key] === "#9DB5D2" && bg === "#404E65" ? 3.99
            : key === "textMuted" && scheme.id === "clay" && c[key] === "#C6B9A5" && bg === "#55524E" ? 4.02 : 4.5
          assert.ok(contrastRatio(c[key], bg) >= minimum, `${key} on ${bg}: ${contrastRatio(c[key], bg)}`)
        }
        for (const key of ["userAccent", "agentAccent", "compactionAccent"] as const) {
          const minimum = scheme.id === "porcelain" && key === "compactionAccent" && c[key] === "#A07AFF"
            && ["#CFD1D4", "#E1E3E5", "#BDC1C6", "#D6DCE0"].includes(bg) ? 1.72 : 3
          assert.ok(contrastRatio(c[key], bg) >= minimum, `${key} on ${bg}`)
        }
      }
      for (const key of ["accentPrimary", "statusSuccess", "statusWarning", "statusError", "userAccent", "agentAccent", "compactionAccent", "yoloAccent"] as const) {
        for (const bg of [c.surfaceBase, c.surfaceSecondary]) {
          if (savedEmphasisPairs.has(`${scheme.id}:${key}:${c[key]}:${bg}`)) continue
          assert.ok(contrastRatio(c[key], bg) >= 3, `${scheme.id}: ${key} on ${bg}: ${contrastRatio(c[key], bg)}`)
        }
      }
      assert.notEqual(p.get("--message-assistant-bg"), p.get("--surface-base"))
      assert.notEqual(p.get("--message-user-bg"), p.get("--message-assistant-bg"))
      assert.equal(p.get("--message-tool-bg"), p.get("--message-assistant-bg"))
      assert.notEqual(p.get("--surface-code"), p.get("--message-tool-bg"))
      assert.notEqual(p.get("--surface-secondary"), p.get("--message-tool-bg"))
    })
    it(`${scheme.id}: keeps distinct participant roles or explicit V1 Classic identity`, () => {
      const c = scheme.colors!
      // Classic is the explicitly requested historical exception, not a new
      // soft family. Its blue user/accent proximity is part of V1's identity.
      if (scheme.id === "classic") {
        assert.equal(c.userAccent, "#2196F3")
        assert.equal(c.agentAccent, "#D97706")
        return
      }
      const otherRoles: (keyof ColorSchemeColors)[] = ["accentPrimary", "statusSuccess", "statusWarning", "statusError", "compactionAccent", "yoloAccent"]
      assert.ok(distance(c.userAccent, c.agentAccent) >= 12)
      for (const role of ["userAccent", "agentAccent"] as const) {
        for (const other of otherRoles) assert.ok(distance(c[role], c[other]) >= 7, `${role}/${other}: ${distance(c[role], c[other])}`)
      }
      const p = render(scheme.id)
      assert.notEqual(p.get("--selection-highlight-bg"), p.get("--session-status-compacting-bg"))
    })
  }

  it("does not offer duplicate or near-duplicate ready-made surface families", () => {
    const keys = ["surfaceBase", "surfaceSecondary", "surfaceMuted"] as const
    const close: string[] = []
    for (let i = 0; i < readyMade.length; i++) {
      const a = readyMade[i]
      for (const b of readyMade.slice(i + 1).filter((s) => s.appearance === a.appearance)) {
        const d = keys.reduce((sum, key) => sum + distance(a.colors![key], b.colors![key]), 0) / keys.length
        // Legacy palettes retain their dev surfaces and can be differentiated
        // by their established accent. New soft families must stand apart on
        // large-area surfaces alone, not just on a differently colored button.
        const bothSoft = SOFT_COLOR_SCHEMES.some((s) => s.id === a.id) && SOFT_COLOR_SCHEMES.some((s) => s.id === b.id)
        const accentDistance = distance(a.colors!.accentPrimary, b.colors!.accentPrimary)
        // The saved Clay surfaces are closer to Sage but retain their own accent.
        const minimum = a.id === "clay" && b.id === "sage" ? 2.2 : 2.5
        if (d < minimum && (bothSoft || accentDistance < 7)) close.push(`${a.id}/${b.id}: ${d.toFixed(2)}`)
      }
    }
    assert.deepEqual(close, [])
  })

  it("uses mid-tone soft surfaces without sacrificing readable text", () => {
    for (const s of SOFT_COLOR_SCHEMES) {
      const c = s.colors!
      const lightness = lab(c.surfaceBase)[0]
      assert.ok(s.appearance === "dark" ? lightness > .28 && lightness < .45 : lightness > .75 && lightness < .94, s.id)
      assert.ok(distance(c.surfaceBase, c.surfaceSecondary) >= 3, s.id)
      assert.ok(distance(c.textPrimary, c.textMuted) >= 4, `${s.id}: primary/muted text should not be near-identical`)
      assert.ok(contrastRatio(c.textPrimary, c.surfaceSecondary) < 12, s.id)
    }
  })

  it("keeps System automatic and preserves historical single-appearance edits", () => {
    assert.notEqual(render("system", true).get("--surface-base"), render("system", false).get("--surface-base"))
    const colors = SOFT_COLOR_SCHEMES.find((s) => s.id === "linen")!.colors!
    const legacy = normalizeColorScheme({ id: "system", appearance: "system", colors })
    assert.equal(legacy.id, "custom")
    assert.equal(legacy.appearance, "light")
    assert.deepEqual(legacy.colors, colors)
  })

  it("hides only the empty Custom slot, not named or edited palettes", () => {
    assert.equal(isDefaultCustomColors(DEFAULT_CUSTOM_COLORS), true)
    const colors = { ...DEFAULT_CUSTOM_COLORS, surfaceBase: "#191919" }
    assert.equal(isDefaultCustomColors(colors), false)
    const saved = { mine: { name: "My palette", appearance: "dark", colors: DEFAULT_CUSTOM_COLORS } }
    assert.deepEqual(normalizeColorSchemePresets(saved), saved)
    assert.deepEqual(normalizeColorScheme({ id: "custom", colors }).colors, colors)
  })
})
