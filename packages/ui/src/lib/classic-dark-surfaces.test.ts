import assert from "node:assert/strict"
import { it } from "node:test"
import { classicDarkSurfaces } from "./classic-dark-surfaces"
import { normalizeColorScheme } from "./theme-scheme"

it("restores compatible V1 dark message tint, roles and borders without masking the current accent", () => {
  const colors = normalizeColorScheme("classic").colors!
  assert.equal(colors.userAccent, "#2196F3")
  assert.equal(colors.agentAccent, "#D97706")
  assert.equal(colors.compactionAccent, "#C084FC")
  assert.deepEqual(classicDarkSurfaces(colors), {
    "--message-user-bg": "#202734",
    "--message-tool-border": "#ADB5BD", "--border-secondary": "#3A3A3A",
    "--border-muted": "#3A3A3A", "--border-strong": "#3A3A3A",
  })
  assert.equal(classicDarkSurfaces({ ...colors, accentPrimary: "#0080FF" })["--accent-hover"], "#0066CC")
})

it("does not mask a customized dark palette", () => {
  const colors = { ...normalizeColorScheme("classic").colors!, userAccent: "#77BBEE", accentPrimary: "#8866AA", borderBase: "#444444" }
  assert.deepEqual(classicDarkSurfaces(colors), {})
  assert.deepEqual(normalizeColorScheme({ id: "classic", colors }).colors, colors)
})
