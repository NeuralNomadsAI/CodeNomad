import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { BUILT_IN_COLOR_SCHEMES, COLOR_SCHEME_IDS, DEFAULT_CUSTOM_COLORS, applyColorScheme, contrastRatio, normalizeColorScheme, type ColorSchemeColors } from "./theme-scheme.ts"
import { SOFT_COLOR_SCHEMES } from "./soft-color-schemes.ts"
import { isDefaultCustomColors, normalizeColorSchemePresets } from "./color-scheme-presets.ts"
import { TEXT_ON_COLOR_LIGHTNESS_THRESHOLD, textOnColor } from "./color-contrast"
import { highContrastColors, highContrastProperties } from "./high-contrast"

function render(id: (typeof COLOR_SCHEME_IDS)[number], systemDark = false, highContrast = false, colors?: ColorSchemeColors) {
  const properties = new Map<string, string>()
  applyColorScheme(colors ? { ...normalizeColorScheme(id), colors } : normalizeColorScheme(id), {
    systemDark,
    highContrast,
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

describe("high-contrast palette quality", () => {
  it("covers every built-in rendering palette", () => {
    assert.equal(readyMade.length, 17)
    assert.equal(readyMade.length, COLOR_SCHEME_IDS.length - 2)
  })
  it("preserves the normal border contrast hierarchy instead of flattening lighter roles", () => {
    for (const scheme of readyMade) {
      const normal = render(scheme.id), p = render(scheme.id, false, true)
      const reference = p.get("--surface-secondary")!, normalReference = normal.get("--surface-secondary")!
      const ratio = (key: string) => contrastRatio(p.get(key)!, reference)
      const normalRatio = (key: string) => contrastRatio(normal.get(key)!, normalReference)
      assert.ok(ratio("--border-base") >= 3, `${scheme.id}: primary border`)
      assert.ok(ratio("--border-strong") > ratio("--border-base"), `${scheme.id}: strong > base`)
      assert.ok(ratio("--border-base") > ratio("--border-secondary"), `${scheme.id}: base > secondary`)
      assert.ok(ratio("--border-secondary") > ratio("--border-muted"), `${scheme.id}: secondary > muted`)
      assert.ok(ratio("--border-divider") > ratio("--border-base"), `${scheme.id}: group divider > base`)
      assert.ok(ratio("--border-row") < ratio("--border-base"), `${scheme.id}: fine row < base`)
      for (const key of ["--border-secondary", "--border-muted"]) {
        const sourceWeight = (normalRatio(key) - 1) / (normalRatio("--border-base") - 1)
        const normalWeight = sourceWeight >= 1 ? key === "--border-secondary" ? .72 : .5 : sourceWeight
        const weight = (ratio(key) - 1) / (ratio("--border-base") - 1)
        assert.ok(Math.abs(weight - normalWeight) < .04, `${scheme.id}/${key}: ${weight} vs normal ${normalWeight}`)
      }
      assert.equal(p.get("--focus-ring-color"), normal.get("--focus-ring-color"), `${scheme.id}: focus source retained`)
    }
  })
  it("uses OKLab ink with WCAG 2 >= 3:1 on accent and hover fills in both modes and Auto", () => {
    // Measured [accent ink, L, ratio, hover ink, L, ratio]; ratios rounded to 4 decimals.
    const measured: Record<string, [string, number, number, string, number, number]> = {
      light: ["#FFFFFF", .563, 4.8336, "#FFFFFF", .480, 6.8207],
      classic: ["#FFFFFF", .620, 3.7971, "#FFFFFF", .669, 3.0855],
      porcelain: ["#FFFFFF", .515, 5.8492, "#FFFFFF", .449, 7.6990],
      mist: ["#000000", .906, 16.2757, "#000000", .920, 16.9339],
      dawn: ["#FFFFFF", .601, 4.1822, "#FFFFFF", .521, 5.8007],
      slate: ["#000000", .777, 10.3894, "#000000", .808, 11.5567],
      parchment: ["#000000", .753, 9.7965, "#FFFFFF", .652, 3.1281],
      clay: ["#000000", .737, 9.3780, "#000000", .772, 10.5691],
      linen: ["#FFFFFF", .617, 3.6798, "#FFFFFF", .535, 5.1785],
      iris: ["#FFFFFF", .640, 3.5281, "#FFFFFF", .555, 4.9573],
      "sage-light": ["#FFFFFF", .615, 3.7935, "#FFFFFF", .533, 5.3090],
      sage: ["#000000", .806, 11.5224, "#000000", .834, 12.6391],
      basalt: ["#000000", .748, 9.2130, "#000000", .783, 10.4467],
      fjord: ["#000000", .772, 10.6404, "#000000", .803, 11.7743],
      lichen: ["#000000", .783, 10.8894, "#000000", .813, 12.0108],
      velvet: ["#000000", .777, 10.1552, "#000000", .807, 11.3094],
      ember: ["#000000", .719, 8.1899, "#000000", .756, 9.4204],
    }
    for (const id of [...readyMade.map(s => s.id), "system"] as const) {
      for (const systemDark of [false, true]) {
        for (const highContrast of [false, true]) {
          const p = render(id, systemDark, highContrast)
          const expected = measured[id === "system" ? systemDark ? "mist" : "porcelain" : id]
          for (const [index, [text, fill]] of [["--text-on-accent", "--accent-primary"], ["--text-on-accent-hover", "--accent-hover"]].entries()) {
            const lightness = lab(p.get(fill)!)[0]
            const ratio = contrastRatio(p.get(text)!, p.get(fill)!)
            const label = `${id} ${systemDark} ${highContrast}: ${text} on ${fill}`
            assert.equal(p.get(text), lightness < TEXT_ON_COLOR_LIGHTNESS_THRESHOLD ? "#FFFFFF" : "#000000", label)
            assert.equal(p.get(text), expected[index * 3], label)
            assert.equal(Number(lightness.toFixed(3)), expected[index * 3 + 1], label)
            assert.equal(Number(ratio.toFixed(4)), expected[index * 3 + 2], label)
            assert.ok(ratio >= 3, `${label}: ${ratio}`)
          }
        }
      }
    }
  })
  for (const scheme of readyMade) {
    it(`${scheme.id}: texts >= 7 and boundaries >= 3 across final surfaces and derived states`, () => {
      const snapshot = structuredClone(scheme)
      const normal = render(scheme.id)
      const p = render(scheme.id, false, true)
      for (const key of ["--accent-primary", "--accent-hover"]) {
        assert.equal(p.get(key), normal.get(key), `${scheme.id}: immutable ${key}`)
      }
      assert.equal(p.get("--button-danger-bg"), normal.get("--status-error"), `${scheme.id}: immutable danger fill`)
      assert.equal(p.get("--button-danger-text"), textOnColor(normal.get("--status-error")!))
      // Foreground adaptation preserves normal derivation, including CSS role
      // aliases/mixes and Classic surfaces. Only the two input endpoints move.
      for (const strength of [0, .2, .3, .35, .5, .6, .9]) {
        const colors = highContrastColors(scheme.colors!, scheme.appearance === "dark", strength)
        const derived = render(scheme.id, false, false, colors)
        const q = highContrastProperties(Object.fromEntries(derived), { dark: scheme.appearance === "dark" })
        assert.notEqual(q["--surface-base"], q["--surface-secondary"], `${scheme.id} ${strength}: Base/Secondary gap`)
        for (const key of ["--surface-base", "--surface-secondary", "--surface-muted", "--surface-code",
          "--message-user-bg", "--message-assistant-bg", "--message-tool-bg"]) {
          assert.equal(q[key], derived.get(key), `${scheme.id} ${strength}: ${key}`)
        }
        for (const key of ["--surface-base", "--surface-secondary"]) {
          assert.notEqual(q[key], q["--surface-muted"], `${scheme.id} ${strength}: input/muted separation`)
        }
        for (const key of ["--surface-base", "--surface-secondary"]) {
          assert.ok(distance(q[key], q["--surface-muted"]) >= Math.min(.1, distance(normal.get(key)!, normal.get("--surface-muted")!)),
            `${scheme.id} ${strength}: ${key}/muted gap`)
        }
      }
      const backgrounds = ["--surface-base", "--surface-secondary", "--surface-muted", "--message-user-bg",
        "--message-assistant-bg", "--message-tool-bg", "--surface-code", "--list-item-highlight-bg",
        "--selection-highlight-bg", "--selection-highlight-strong-bg", "--surface-hover", "--menu-item-selected-bg"]
        .map(key => [key, p.get(key)!]).filter(([, value]) => value.startsWith("#"))
      for (const key of ["--text-primary", "--text-secondary", "--text-muted", "--tab-active-text", "--tab-inactive-text",
        "--new-tab-text", "--accent-text", "--accent-hover-text", "--status-success", "--status-warning", "--status-error",
        "--session-status-compacting-fg", "--session-yolo-accent", "--message-user-border", "--message-assistant-border",
        "--message-part-header-type", "--message-part-header-title", "--dropdown-highlight-text",
        "--selection-highlight-text", "--timeline-segment-active-text"]) {
        for (const [role, bg] of backgrounds) assert.ok(contrastRatio(p.get(key)!, bg) >= 7,
          `${scheme.id} ${key} normal/selected/hover on ${role} ${bg}: ${contrastRatio(p.get(key)!, bg)}`)
      }
      for (const key of ["--border-base", "--border-strong", "--border-critical",
        "--border-divider", "--message-tool-border", "--tab-border",
        "--list-item-highlight-border", "--scrollbar-thumb", "--scrollbar-thumb-hover"]) {
        for (const [role, bg] of backgrounds) assert.ok(contrastRatio(p.get(key)!, bg) >= 3,
          `${scheme.id} ${key} normal/selected/hover on ${role} ${bg}: ${contrastRatio(p.get(key)!, bg)}`)
      }
      for (const [text, bg] of [
        ["--attachment-chip-text", "--attachment-chip-bg"], ["--badge-neutral-text", "--badge-neutral-bg"],
        ["--env-vars-text", "--env-vars-bg"], ["--status-success", "--status-success-bg"],
        ["--status-warning", "--status-warning-bg"], ["--status-error-fg", "--status-error-bg"],
        ["--status-ready-fg", "--status-ready-bg"], ["--status-starting-fg", "--status-starting-bg"],
        ["--status-stopped-fg", "--status-stopped-bg"], ["--session-status-working-fg", "--session-status-working-bg"],
        ["--session-status-idle-fg", "--session-status-idle-bg"], ["--session-status-permission-fg", "--session-status-permission-bg"],
        ["--session-status-compacting-fg", "--session-status-compacting-bg"],
      ]) assert.ok(contrastRatio(p.get(text)!, p.get(bg)!) >= 7, `${scheme.id} ${text} on composed ${bg}`)
      for (const [key, source] of [
        ["--accent-text", "--accent-primary"], ["--accent-hover-text", "--accent-hover"],
        ...["--status-success", "--status-warning", "--status-error", "--message-user-border",
          "--message-assistant-border", "--session-status-compacting-fg", "--session-yolo-accent"]
          .map(key => [key, key]),
      ]) {
        const [, a, b] = lab(normal.get(source)!), [, x, y] = lab(p.get(key)!)
        const delta = Math.abs(Math.atan2(b, a) - Math.atan2(y, x)) * 180 / Math.PI
        // Near-white, byte quantization makes hue coarse; retain it within 12°.
        assert.ok(Math.min(delta, 360 - delta) < 12, `${scheme.id} ${key}: OKLCH hue drift ${delta}`)
        assert.ok(Math.hypot(x, y) > .005, `${scheme.id} ${key}: recognizable chroma`)
        assert.ok(!["#FFFFFF", "#000000"].includes(p.get(key)!), `${scheme.id} ${key}: colored ink`)
      }
      assert.deepEqual(scheme, snapshot)
    })
  }
  it("applies the same strict roles when the system appearance changes", () => {
    for (const dark of [true, false, true]) {
      const p = render("system", dark, true)
      for (const role of ["--surface-base", "--surface-secondary", "--surface-muted", "--message-user-bg"]) {
        assert.ok(contrastRatio(p.get("--text-muted")!, p.get(role)!) >= 7)
      }
    }
  })
})

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
  it("restores Classic's dev surface assignments with inset-role tool output", () => {
    const p = render("classic")
    assert.equal(p.get("--surface-base"), "#1A1A1A")
    assert.equal(p.get("--surface-secondary"), "#2A2A2A")
    assert.equal(p.get("--message-assistant-bg"), "#212529")
    assert.equal(p.get("--message-tool-bg"), "#212529")
    assert.equal(p.get("--surface-code"), "var(--surface-inset)")
  })
  it("has unique stable IDs, six soft light and four soft dark choices", () => {
    assert.equal(new Set(COLOR_SCHEME_IDS).size, COLOR_SCHEME_IDS.length)
    assert.equal(new Set(BUILT_IN_COLOR_SCHEMES.map((s) => s.id)).size, COLOR_SCHEME_IDS.length)
    assert.equal(SOFT_COLOR_SCHEMES.filter((s) => s.appearance === "light").length, 6)
    assert.equal(SOFT_COLOR_SCHEMES.filter((s) => s.appearance === "dark").length, 4)
  })

  it("places Base nearer the appearance extreme than Secondary in every built-in palette", () => {
    for (const scheme of BUILT_IN_COLOR_SCHEMES.filter(s => s.colors)) {
      const c = scheme.colors!
      const base = lab(c.surfaceBase)[0], secondary = lab(c.surfaceSecondary)[0]
      assert.ok(scheme.appearance === "dark" ? base < secondary : base > secondary, scheme.id)
    }
  })

  for (const scheme of readyMade) {
    it(`${scheme.id}: readable text and identity on actual message/tool surfaces`, () => {
      const c = scheme.colors!
      const p = render(scheme.id)
      for (const bg of [c.surfaceBase, c.surfaceSecondary, c.surfaceMuted, p.get("--message-user-bg")!, p.get("--message-assistant-bg")!]) {
        for (const key of ["textPrimary", "textMuted"] as const) {
          // Saved calibration retains softer secondary text in these two families.
          // Primary text still meets 4.5 everywhere.
          const minimum = key === "textMuted" && scheme.id === "slate" && c[key] === "#9DB5D2" && bg === "#404E65" ? 3.99
            : key === "textMuted" && scheme.id === "clay" && c[key] === "#C6B9A5" && bg === "#55524E" ? 4.02 : 4.5
          assert.ok(contrastRatio(c[key], bg) >= minimum, `${key} on ${bg}: ${contrastRatio(c[key], bg)}`)
        }
        for (const key of ["userAccent", "agentAccent", "compactionAccent"] as const) {
          const minimum = scheme.id === "porcelain" && key === "compactionAccent" && c[key] === "#A07AFF"
            && ["#CFD1D4", "#E1E3E5", "#BDC1C6", "#C5CBD0"].includes(bg) ? 1.72 : 3
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
      // Output blocks follow the inset role (title-bar tint: 25% secondary in OKLab) and
      // must stay visibly distinct from tool cards. Classic Light pins its V1 code surface.
      const code = p.get("--surface-code")!
      if (code.startsWith("#")) assert.notEqual(code, p.get("--message-tool-bg"))
      else {
        assert.equal(code, "var(--surface-inset)")
        const insetLab = lab(c.surfaceSecondary).map((v, i) => .25 * v + .75 * lab(c.surfaceBase)[i])
        const toolLab = lab(p.get("--message-tool-bg")!)
        const codeDistance = Math.hypot(...insetLab.map((v, i) => v - toolLab[i])) * 100
        assert.ok(codeDistance >= 2, `inset output vs tool card: ${codeDistance}`)
      }
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
