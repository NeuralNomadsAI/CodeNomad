import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"

import { missionMessages as de } from "./de/missions"
import { missionMessages as en } from "./en/missions"
import { missionMessages as es } from "./es/missions"
import { missionMessages as fr } from "./fr/missions"
import { missionMessages as he } from "./he/missions"
import { missionMessages as ja } from "./ja/missions"
import { missionMessages as ne } from "./ne/missions"
import { missionMessages as ru } from "./ru/missions"
import { missionMessages as tr } from "./tr/missions"
import { missionMessages as zhHans } from "./zh-Hans/missions"

const locales = { de, en, es, fr, he, ja, ne, ru, tr, "zh-Hans": zhHans }

test("the user-facing mission journey has a translated key for every literal message", () => {
  const components = ["mission-progress.tsx", "mission-activity.tsx", "mission-guidance.tsx", "mission-model-library.tsx",
    "mission-profile-summary.tsx", "mission-default-inheritance-controls.tsx", "mission-editor.tsx", "mission-task-reader.tsx", "settings/missions-settings-section.tsx"]
  for (const file of components) {
    const source = readFileSync(new URL(`../../../components/${file}`, import.meta.url), "utf8")
    for (const match of source.matchAll(/"(missions\.[\w.-]+)"/g)) {
      assert.ok(Object.prototype.hasOwnProperty.call(en, match[1]), `${file}: ${match[1]} is missing`)
    }
  }
  for (const intent of ["priority", "constraint", "alternative"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(en, `missions.control.guidance.intent.${intent}`))
  }
})

test("keeps Mission Control keys and interpolation placeholders aligned across locales", () => {
  const expectedKeys = Object.keys(en).sort()
  for (const [locale, messages] of Object.entries(locales)) {
    assert.deepEqual(Object.keys(messages).sort(), expectedKeys, `${locale} mission keys`)
    for (const key of expectedKeys) {
      const englishPlaceholders = placeholders(en[key as keyof typeof en])
      const localized = messages as Record<string, string>
      assert.deepEqual(placeholders(localized[key]), englishPlaceholders, `${locale}:${key} placeholders`)
    }
  }
})

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}
