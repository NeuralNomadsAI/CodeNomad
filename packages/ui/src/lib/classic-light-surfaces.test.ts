import assert from "node:assert/strict"
import { it } from "node:test"
import { classicLightSurfaces } from "./classic-light-surfaces"
import { BUILT_IN_COLOR_SCHEMES, normalizeColorScheme } from "./theme-scheme"

it("names both historical appearances Classic while preserving stable IDs", () => {
  const light = BUILT_IN_COLOR_SCHEMES.find(s => s.id === "light")!
  assert.equal(light.labelKey, BUILT_IN_COLOR_SCHEMES.find(s => s.id === "classic")!.labelKey)
  assert.equal(light.appearance, "light")
  assert.equal(normalizeColorScheme("light").id, "light")
  assert.equal(BUILT_IN_COLOR_SCHEMES.find(s => s.appearance === "light")?.id, "light")
  assert.equal(BUILT_IN_COLOR_SCHEMES.find(s => s.appearance === "dark")?.id, "classic")
})

it("restores the V1 light surface relationship without resurrecting harsh rollovers", () => {
  const colors = normalizeColorScheme("light").colors!
  assert.equal(colors.surfaceBase, "#FFFFFF")
  assert.equal(colors.surfaceSecondary, "#F5F5F5")
  assert.equal(colors.surfaceMuted, "#F8FAFC")
  assert.equal(colors.borderBase, "#E0E0E0")
  assert.equal(colors.accentPrimary, "#0066FF")
  assert.deepEqual(classicLightSurfaces(colors), {
    "--message-assistant-bg": "#F8F8F8", "--message-tool-bg": "#F8F8F8",
    "--surface-code": "#F1F5F9", "--text-secondary": "#334155", "--accent-hover": "#0052CC",
  })
})

it("does not mask custom light colors or overwrite saved embedded selections", () => {
  const colors = { ...normalizeColorScheme("light").colors!, surfaceBase: "#EEEEEE", surfaceMuted: "#DDDDDD", textMuted: "#445566", accentPrimary: "#225588" }
  assert.deepEqual(classicLightSurfaces(colors), {})
  assert.deepEqual(normalizeColorScheme({ id: "light", colors }).colors, colors)
})
