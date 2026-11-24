import assert from "node:assert/strict"
import test from "node:test"
import { missionMessages as en } from "../lib/i18n/messages/en/missions.ts"
import { missionMessages as de } from "../lib/i18n/messages/de/missions.ts"
import { missionMessages as es } from "../lib/i18n/messages/es/missions.ts"
import { missionMessages as fr } from "../lib/i18n/messages/fr/missions.ts"
import { missionMessages as he } from "../lib/i18n/messages/he/missions.ts"
import { missionMessages as ja } from "../lib/i18n/messages/ja/missions.ts"
import { missionMessages as ne } from "../lib/i18n/messages/ne/missions.ts"
import { missionMessages as ru } from "../lib/i18n/messages/ru/missions.ts"
import { missionMessages as tr } from "../lib/i18n/messages/tr/missions.ts"
import { missionMessages as zhHans } from "../lib/i18n/messages/zh-Hans/missions.ts"

test("all ten Mission bundles own native execution and notification labels without fallback", () => {
  const bundles = { en, de, es, fr, he, ja, ne, ru, tr, "zh-Hans": zhHans }
  const keys = Object.keys(en).filter(key => key.startsWith("missions.control.native.") || key.startsWith("missions.control.report.notification.") || key.startsWith("missions.control.report.delivery."))
  assert.equal(keys.length, 25)
  assert.equal(Object.keys(bundles).length, 10)
  for (const [locale, bundle] of Object.entries(bundles)) for (const key of keys) {
    const value = (bundle as Record<string, string>)[key]
    assert.ok(Object.prototype.hasOwnProperty.call(bundle, key) && value?.trim(), `${locale} owns ${key}`)
    if (locale !== "en") assert.notEqual(value, (en as Record<string, string>)[key], `${locale} translates ${key}`)
  }
  assert.match(en["missions.control.native.separate"], /do not prove session termination or task completion/)
  assert.match(en["missions.control.report.notification.admitted"], /consumption unconfirmed/)
  assert.doesNotMatch(en["missions.control.native.bound"], /admitted|complete/i)
  for (const [locale, bundle] of Object.entries(bundles)) assert.ok(bundle["missions.control.report.late"], `${locale} owns late report guidance`)
  assert.match(en["missions.control.report.late"], /Mission Stop/)
  assert.match(en["missions.control.report.delivery.nativeReturn"], /native-parent return route; consumption unconfirmed/)
  assert.match(en["missions.control.report.notification.nativeReturnPending"], /not admitted.*no coordinator send requested/)
  assert.match(en["missions.control.report.delivery.readout"], /Coordinator business readout; no notification is sent/)
})
