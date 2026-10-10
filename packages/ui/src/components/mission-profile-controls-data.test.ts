import assert from "node:assert/strict"
import test from "node:test"
import { changeMissionProfile, changeProfileModel, legalProfileAgents, modelSelectionKey, profilesForTemplate } from "./mission-profile-controls-data"
import { missionMessages as en } from "../lib/i18n/messages/en/missions"
import { missionMessages as de } from "../lib/i18n/messages/de/missions"
import { missionMessages as es } from "../lib/i18n/messages/es/missions"
import { missionMessages as fr } from "../lib/i18n/messages/fr/missions"
import { missionMessages as he } from "../lib/i18n/messages/he/missions"
import { missionMessages as ja } from "../lib/i18n/messages/ja/missions"
import { missionMessages as ne } from "../lib/i18n/messages/ne/missions"
import { missionMessages as ru } from "../lib/i18n/messages/ru/missions"
import { missionMessages as tr } from "../lib/i18n/messages/tr/missions"
import { missionMessages as zhHans } from "../lib/i18n/messages/zh-Hans/missions"

test("root/child/independent agent legality is explicit and never assumes a primary default for children", () => {
  const agents = [
    { id: "root", mode: "primary" }, { id: "child", mode: "subagent" }, { id: "both", mode: "all" },
    { id: "hidden", mode: "all", hidden: true }, { id: "unknown", mode: "future" },
  ]
  assert.deepEqual(legalProfileAgents(agents, "coordinator").map(agent => agent.id), ["root", "both"])
  assert.deepEqual(legalProfileAgents(agents, "native").map(agent => agent.id), ["child", "both"])
  assert.deepEqual(legalProfileAgents(agents, "independent").map(agent => agent.id), ["root", "both"])
})

test("changing model clears variant and ambiguous native IDs remain distinct", () => {
  const models = [{ providerID: "a:b", id: "c", variants: [{ id: "high" }] }, { providerID: "a", id: "b:c", variants: [] }]
  assert.notEqual(modelSelectionKey(models[0]), modelSelectionKey(models[1]))
  assert.deepEqual(changeProfileModel({ agent: "child", model: { providerID: "a:b", id: "c", variant: "high" } }, modelSelectionKey(models[1]), models), {
    agent: "child", model: { providerID: "a", id: "b:c" },
  })
  assert.deepEqual(changeProfileModel({ agent: "child" }, "", models), { agent: "child" })
})

test("profile edits preserve other roles and explicit template switch preserves only legal presets", () => {
  const a = changeMissionProfile(undefined, "coordinator", { agent: "root" })!
  const b = changeMissionProfile(a, "review-standards", { agent: "child", model: { providerID: "p", id: "m", variant: "high" } })!
  assert.deepEqual(a, { coordinator: { agent: "root" } })
  assert.equal(b.roles!["review-standards"].model!.variant, "high")
  assert.deepEqual(profilesForTemplate(b, "wayfinder"), a)
  assert.equal(changeMissionProfile(undefined, "validator", {}), undefined)
  assert.deepEqual(changeMissionProfile(b, "review-standards", {}), a)
})

test("all ten locale bundles own all twenty profile labels without English fallback", () => {
  const keys = Object.keys(en).filter(key => key.startsWith("missions.control.profiles."))
  assert.equal(keys.length, 20)
  const locales = { en, de, es, fr, he, ja, ne, ru, tr, "zh-Hans": zhHans }
  for (const [locale, bundle] of Object.entries(locales)) for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(bundle, key), `${locale} owns ${key}`)
    const value = (bundle as Record<string, string>)[key]
    assert.ok(value.trim(), `${locale} has text for ${key}`)
    if (locale !== "en") assert.notEqual(value, (en as Record<string, string>)[key], `${locale} translates ${key}`)
  }
  assert.match(en["missions.control.profiles.debug"], /separate standards and specification axes/)
  assert.match(en["missions.control.profiles.debug"], /exact implementer child/)
  assert.match(en["missions.control.profiles.detail"], /future calls, not proof/)
})
