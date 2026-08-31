import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  BUILT_IN_COLOR_SCHEMES,
  DEFAULT_CUSTOM_COLORS,
  applyColorScheme,
  contrastRatio,
  normalizeColorScheme,
  textOnColor,
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
})

describe("built-in color schemes", () => {
  it("keeps every preset within its contrast requirements", () => {
    for (const scheme of BUILT_IN_COLOR_SCHEMES) {
      if (scheme.colors) assert.equal(validateColorSchemeColors(scheme.colors), true, scheme.id)
    }
  })

  it("uses the specified independent preset accents", () => {
    const accents = Object.fromEntries(BUILT_IN_COLOR_SCHEMES.filter((scheme) => !scheme.editable).map((scheme) => [scheme.id, scheme.colors?.accentPrimary]))
    assert.equal(accents.basalt, "#8FA8FF")
    assert.equal(accents.fjord, "#67C9BA")
    assert.equal(accents.lichen, "#A9C47F")
    assert.equal(accents.velvet, "#E5A77D")
    assert.equal(accents.ember, "#D79A66")
  })

  it("preserves the exact CodeNomad Classic dark palette", () => {
    assert.deepEqual(BUILT_IN_COLOR_SCHEMES.find((scheme) => scheme.id === "classic")?.colors, {
      surfaceBase: "#1A1A1A",
      surfaceSecondary: "#2A2A2A",
      surfaceMuted: "#212529",
      borderBase: "#3A3A3A",
      textPrimary: "#CFD4DC",
      textMuted: "#999999",
      accentPrimary: "#0080FF",
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
  it("clears stale overrides when switching to system or light", () => {
    const root = target()
    applyColorScheme(normalizeColorScheme("fjord"), { target: root.value })
    assert.ok(root.properties.size > 0)
    assert.equal(root.attributes.get("data-theme"), "dark")

    applyColorScheme(normalizeColorScheme("system"), { target: root.value, systemDark: true })
    assert.equal(root.properties.size, 0)
    assert.equal(root.attributes.has("data-theme"), false)
    assert.equal(root.value.dataset.colorScheme, "system")

    applyColorScheme(normalizeColorScheme("ember"), { target: root.value })
    applyColorScheme(normalizeColorScheme("light"), { target: root.value })
    assert.equal(root.properties.size, 0)
    assert.equal(root.attributes.get("data-theme"), "light")
  })

  it("uses the existing dark CSS tokens for CodeNomad Classic", () => {
    const root = target()
    applyColorScheme(normalizeColorScheme("fjord"), { target: root.value })
    applyColorScheme(normalizeColorScheme("classic"), { target: root.value })
    assert.equal(root.properties.size, 0)
    assert.equal(root.attributes.get("data-theme"), "dark")
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

  it("derives legacy blue UI states from the selected accent", () => {
    const root = target()
    applyColorScheme(normalizeColorScheme("fjord"), { target: root.value })
    assert.equal(root.properties.get("--attachment-chip-text"), "#67C9BA")
    assert.equal(root.properties.get("--dropdown-highlight-bg"), "rgba(103, 201, 186, 0.2)")
  })

  it("applies customizable semantic roles", () => {
    const root = target()
    const colors = { ...DEFAULT_CUSTOM_COLORS, userAccent: "#52B5F5", agentAccent: "#E7A74A", compactionAccent: "#C99AF4", yoloAccent: "#92B8FF" }
    applyColorScheme(normalizeColorScheme({ id: "custom", colors }), { target: root.value })
    assert.equal(root.properties.get("--message-user-border"), colors.userAccent)
    assert.equal(root.properties.get("--message-assistant-border"), colors.agentAccent)
    assert.equal(root.properties.get("--session-status-compacting-fg"), colors.compactionAccent)
    assert.equal(root.properties.get("--session-yolo-accent"), colors.yoloAccent)
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
