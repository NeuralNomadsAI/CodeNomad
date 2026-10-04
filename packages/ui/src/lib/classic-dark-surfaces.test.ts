import assert from "node:assert/strict"
import { it } from "node:test"
import { classicDarkSurfaces } from "./classic-dark-surfaces"
import { applyColorScheme, normalizeColorScheme } from "./theme-scheme"

it("preserves Classic's historical message tint, roles and borders without overriding its calibrated accent", () => {
  const colors = normalizeColorScheme("classic").colors!
  assert.equal(colors.accentPrimary, "#4D7AFE")
  assert.equal(colors.userAccent, "#2196F3")
  assert.equal(colors.agentAccent, "#D97706")
  assert.equal(colors.compactionAccent, "#C084FC")
  assert.deepEqual(classicDarkSurfaces(colors), {
    "--message-user-bg": "#202734",
    "--message-tool-border": "#ADB5BD", "--border-secondary": "#3A3A3A",
    "--border-muted": "#3A3A3A", "--border-strong": "#3A3A3A",
  })
  const properties = new Map<string, string>()
  applyColorScheme(normalizeColorScheme("classic"), {
    systemDark: true,
    target: {
      style: { setProperty: (key, value) => { properties.set(key, value) }, removeProperty: key => { properties.delete(key) } },
      dataset: {}, setAttribute() {}, removeAttribute() {},
    },
  })
  assert.equal(properties.get("--accent-primary"), "#4D7AFE")
  assert.equal(properties.get("--accent-hover"), "#668DFE")
})

it("retains the V1 accent hover only for the saved historical accent", () => {
  const colors = { ...normalizeColorScheme("classic").colors!, accentPrimary: "#0080FF" }
  assert.equal(classicDarkSurfaces(colors)["--accent-hover"], "#0066CC")
  assert.deepEqual(normalizeColorScheme({ id: "classic", colors }).colors, colors)
})

it("does not mask a customized dark palette", () => {
  const colors = { ...normalizeColorScheme("classic").colors!, userAccent: "#77BBEE", accentPrimary: "#8866AA", borderBase: "#444444" }
  assert.deepEqual(classicDarkSurfaces(colors), {})
  assert.deepEqual(normalizeColorScheme({ id: "classic", colors }).colors, colors)
})
