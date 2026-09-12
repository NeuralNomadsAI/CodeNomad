import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  BUILT_IN_COLOR_SCHEMES,
  DEFAULT_CUSTOM_COLORS,
  LIGHT_COLOR_SCHEME_COLORS,
  SYSTEM_DARK_COLOR_SCHEME_COLORS,
  SYSTEM_LIGHT_COLOR_SCHEME_COLORS,
  applyColorScheme,
  contrastRatio,
  normalizeColorScheme,
  textOnColor,
  toColorSchemeMergePatch,
  validateColorSchemeColors,
  type ColorSchemeTarget,
} from "./theme-scheme.ts"

function target() {
  const properties = new Map<string, string>()
  const attributes = new Map<string, string>()
  const value: ColorSchemeTarget = {
    style: {
      setProperty(name, propertyValue) {
        properties.set(name, propertyValue)
      },
      removeProperty(name) {
        return properties.delete(name)
      },
    },
    dataset: {},
    setAttribute(name, attributeValue) {
      attributes.set(name, attributeValue)
    },
    removeAttribute(name) {
      attributes.delete(name)
    },
  }
  return { value, properties, attributes }
}

describe("normalizeColorScheme", () => {
  it("fails malformed persistence closed to safe defaults", () => {
    assert.equal(normalizeColorScheme({ id: "unknown" }).id, "system")
    assert.equal(normalizeColorScheme({ id: "toString" }).id, "system")
    assert.deepEqual(normalizeColorScheme({ id: "custom", colors: { surfaceBase: "#fff" } }), {
      id: "custom",
      appearance: "dark",
      colors: DEFAULT_CUSTOM_COLORS,
    })
    assert.equal(normalizeColorScheme({ id: "custom", colors: { ...DEFAULT_CUSTOM_COLORS, surfaceBase: "#ffffff" } }).colors?.surfaceBase, "#17181A")
  })

  it("maps legacy themes only when the color scheme is invalid", () => {
    assert.equal(normalizeColorScheme(undefined, "system").id, "system")
    assert.equal(normalizeColorScheme(undefined, "light").id, "light")
    assert.equal(normalizeColorScheme(undefined, "dark").id, "classic")
    assert.equal(normalizeColorScheme("fjord", "light").id, "fjord")
  })

  it("persists a custom scheme's independent appearance", () => {
    assert.equal(normalizeColorScheme({ id: "custom", appearance: "light", colors: DEFAULT_CUSTOM_COLORS }).appearance, "light")
    assert.equal(normalizeColorScheme({ id: "custom", appearance: "system", colors: DEFAULT_CUSTOM_COLORS }).appearance, "dark")
  })

  it("preserves saved colors on an embedded palette", () => {
    const colors = { ...LIGHT_COLOR_SCHEME_COLORS, surfaceBase: "#FF00FF" }
    assert.deepEqual(normalizeColorScheme({ id: "light", appearance: "light", colors }), {
      id: "light",
      appearance: "light",
      colors,
    })
  })
})

describe("toColorSchemeMergePatch", () => {
  it("clears stale colors when returning to the system palette", () => {
    assert.deepEqual(toColorSchemeMergePatch(normalizeColorScheme("system")), {
      id: "system",
      appearance: "system",
      colors: null,
    })
  })

  it("keeps all colors for explicit palettes", () => {
    const classic = normalizeColorScheme("classic")
    assert.deepEqual(toColorSchemeMergePatch(classic), classic)
  })
})

describe("built-in color schemes", () => {
  it("bounds contrast exceptions to the explicitly saved palette calibration", () => {
    // Keep the validator strict; these exact user-selected palettes intentionally
    // have softer secondary text or brighter accents. Primary text is checked
    // independently on every rendered surface in palette-quality.test.ts.
    assert.deepEqual(BUILT_IN_COLOR_SCHEMES.filter((scheme) => scheme.colors && !validateColorSchemeColors(scheme.colors)).map((scheme) => scheme.id), [
      "porcelain", "dawn", "slate", "parchment", "clay", "linen", "iris", "sage-light",
    ])
  })

  it("uses the specified independent preset accents", () => {
    const accents = Object.fromEntries(BUILT_IN_COLOR_SCHEMES.filter((scheme) => !scheme.editable).map((scheme) => [scheme.id, scheme.colors?.accentPrimary]))
    assert.equal(accents.basalt, "#8FA8FF")
    assert.equal(accents.fjord, "#67C9BA")
    assert.equal(accents.lichen, "#A9C47F")
    assert.equal(accents.velvet, "#E5A77D")
    assert.equal(accents.ember, "#D99254")
  })

  it("keeps the additional Zed-inspired palettes light", () => {
    for (const id of ["porcelain", "dawn", "parchment"]) {
      assert.equal(BUILT_IN_COLOR_SCHEMES.find((scheme) => scheme.id === id)?.appearance, "light")
    }
  })

  it("keeps System distinct from CodeNomad Classic", () => {
    const classic = BUILT_IN_COLOR_SCHEMES.find((scheme) => scheme.id === "classic")?.colors
    assert.notDeepEqual(SYSTEM_DARK_COLOR_SCHEME_COLORS, classic)
    assert.notDeepEqual(SYSTEM_LIGHT_COLOR_SCHEME_COLORS, LIGHT_COLOR_SCHEME_COLORS)
  })

  it("preserves Classic surfaces while separating participant roles", () => {
    assert.deepEqual(BUILT_IN_COLOR_SCHEMES.find((scheme) => scheme.id === "classic")?.colors, {
      surfaceBase: "#1A1A1A",
      surfaceSecondary: "#2A2A2A",
      surfaceMuted: "#212529",
      borderBase: "#3A3A3A",
      textPrimary: "#CFD4DC",
      textMuted: "#999999",
      accentPrimary: "#4D7AFE",
      statusSuccess: "#4CAF50",
      statusWarning: "#FF9800",
      statusError: "#F44336",
      userAccent: "#2196F3",
      agentAccent: "#D97706",
      compactionAccent: "#C084FC",
      yoloAccent: "#0080FF",
    })
  })
})

describe("applyColorScheme", () => {
  it("replaces stale overrides when switching to system or light", () => {
    const root = target()
    applyColorScheme(normalizeColorScheme("fjord"), { target: root.value })
    assert.ok(root.properties.size > 0)
    assert.equal(root.attributes.get("data-theme"), "dark")

    applyColorScheme(normalizeColorScheme("system"), { target: root.value, systemDark: true })
    assert.equal(root.properties.get("--surface-base"), SYSTEM_DARK_COLOR_SCHEME_COLORS.surfaceBase)
    assert.equal(root.attributes.has("data-theme"), false)
    assert.equal(root.value.dataset.colorScheme, "system")

    applyColorScheme(normalizeColorScheme("ember"), { target: root.value })
    applyColorScheme(normalizeColorScheme("light"), { target: root.value })
    assert.equal(root.properties.get("--surface-base"), LIGHT_COLOR_SCHEME_COLORS.surfaceBase)
    assert.equal(root.attributes.get("data-theme"), "light")
  })

  it("renders Classic defaults and explicit edits through the same token path", () => {
    const root = target()
    applyColorScheme(normalizeColorScheme("fjord"), { target: root.value })
    applyColorScheme(normalizeColorScheme("classic"), { target: root.value })
    assert.equal(root.properties.get("--surface-base"), "#1A1A1A")
    assert.equal(root.attributes.get("data-theme"), "dark")
    const colors = { ...normalizeColorScheme("classic").colors!, accentPrimary: "#FF00FF" }
    applyColorScheme(normalizeColorScheme({ id: "classic", colors }), { target: root.value })
    assert.equal(root.properties.get("--accent-primary"), "#FF00FF")
  })

  it("resolves system appearance without imposing a data theme", () => {
    const darkRoot = target()
    const lightRoot = target()
    assert.equal(applyColorScheme(normalizeColorScheme("system"), { target: darkRoot.value, systemDark: true }), true)
    assert.equal(applyColorScheme(normalizeColorScheme("system"), { target: lightRoot.value, systemDark: false }), false)
    assert.equal(darkRoot.attributes.has("data-theme"), false)
    assert.equal(lightRoot.attributes.has("data-theme"), false)
  })

  it("derives readable text on accent", () => {
    const root = target()
    const scheme = normalizeColorScheme("basalt")
    applyColorScheme(scheme, { target: root.value })
    const text = root.properties.get("--text-on-accent")
    assert.equal(text, textOnColor("#8FA8FF"))
    assert.ok(contrastRatio(text ?? "", "#8FA8FF") >= 4.5)
  })

  it("keeps neutral selection independent of accent-colored actions", () => {
    const root = target()
    applyColorScheme(normalizeColorScheme("fjord"), { target: root.value })
    assert.equal(root.properties.get("--attachment-chip-text"), "#67C9BA")
    assert.equal(root.properties.get("--dropdown-highlight-bg"), "rgba(168, 184, 191, 0.2)")
  })

  it("applies customizable semantic roles", () => {
    const root = target()
    const colors = { ...DEFAULT_CUSTOM_COLORS, userAccent: "#52B5F5", agentAccent: "#E7A74A", compactionAccent: "#C99AF4", yoloAccent: "#92B8FF" }
    applyColorScheme(normalizeColorScheme({ id: "custom", colors }), { target: root.value })
    assert.equal(root.properties.get("--message-user-border"), colors.userAccent)
    assert.equal(root.properties.get("--message-assistant-border"), colors.agentAccent)
    assert.equal(root.properties.get("--session-status-compacting-fg"), colors.compactionAccent)
    assert.equal(root.properties.get("--session-yolo-accent"), colors.accentPrimary)
  })

  it("derives tabs and message surfaces from each palette", () => {
    for (const id of ["light", "classic", "fjord", "lichen", "velvet", "ember", "porcelain", "dawn", "parchment"] as const) {
      const root = target()
      const scheme = normalizeColorScheme(id)
      applyColorScheme(scheme, { target: root.value })
      assert.equal(root.properties.get("--tab-active-bg"), scheme.colors?.surfaceBase, id)
      assert.equal(root.properties.get("--tab-inactive-bg"), scheme.colors?.surfaceSecondary, id)
      assert.equal(root.properties.get("--message-user-border"), scheme.colors?.userAccent, id)
      assert.notEqual(root.properties.get("--message-user-bg"), scheme.colors?.surfaceSecondary, id)
      assert.equal(root.properties.get("--message-assistant-border"), scheme.colors?.agentAccent, id)
      assert.equal(root.properties.get("--message-assistant-bg"), id === "light" ? "#F8F8F8" : scheme.colors?.surfaceMuted, id)
      assert.notEqual(root.properties.get("--message-assistant-bg"), root.properties.get("--surface-base"), id)
    }
  })
})

describe("custom color validation", () => {
  it("fills semantic roles when loading a persisted legacy custom scheme", () => {
    const { userAccent: _user, agentAccent: _agent, compactionAccent: _compaction, yoloAccent: _yolo, ...legacyColors } = DEFAULT_CUSTOM_COLORS
    assert.deepEqual(normalizeColorScheme({ id: "custom", colors: legacyColors }).colors, DEFAULT_CUSTOM_COLORS)
  })

  it("rejects weak text and emphasis contrast", () => {
    assert.equal(validateColorSchemeColors(DEFAULT_CUSTOM_COLORS), true)
    assert.equal(validateColorSchemeColors({ ...DEFAULT_CUSTOM_COLORS, textMuted: "#555555" }), false)
    assert.equal(validateColorSchemeColors({ ...DEFAULT_CUSTOM_COLORS, accentPrimary: "#303030" }), false)
    assert.equal(validateColorSchemeColors({ ...DEFAULT_CUSTOM_COLORS, surfaceMuted: DEFAULT_CUSTOM_COLORS.textPrimary }), false)
    assert.equal(validateColorSchemeColors({ ...DEFAULT_CUSTOM_COLORS, statusWarning: "orange" }), false)
    assert.equal(validateColorSchemeColors({
      ...DEFAULT_CUSTOM_COLORS,
      surfaceBase: "#FFFFFF",
      surfaceSecondary: "#000000",
      textPrimary: "#767676",
      textMuted: "#767676",
      accentPrimary: "#FFFFFF",
      statusSuccess: "#FFFFFF",
      statusWarning: "#FFFFFF",
      statusError: "#FFFFFF",
    }), false)
  })
})
