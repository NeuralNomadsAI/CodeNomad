import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"

import { missionMessages as deMissions } from "./de/missions"
import { missionCreateMessages as deCreate } from "./de/missions-create"
const de = { ...deMissions, ...deCreate }
import { missionMessages as enMissions } from "./en/missions"
import { missionCreateMessages as enCreate } from "./en/missions-create"
const en = { ...enMissions, ...enCreate }
import { missionMessages as esMissions } from "./es/missions"
import { missionCreateMessages as esCreate } from "./es/missions-create"
const es = { ...esMissions, ...esCreate }
import { missionMessages as frMissions } from "./fr/missions"
import { missionCreateMessages as frCreate } from "./fr/missions-create"
const fr = { ...frMissions, ...frCreate }
import { missionMessages as heMissions } from "./he/missions"
import { missionCreateMessages as heCreate } from "./he/missions-create"
const he = { ...heMissions, ...heCreate }
import { missionMessages as jaMissions } from "./ja/missions"
import { missionCreateMessages as jaCreate } from "./ja/missions-create"
const ja = { ...jaMissions, ...jaCreate }
import { missionMessages as neMissions } from "./ne/missions"
import { missionCreateMessages as neCreate } from "./ne/missions-create"
const ne = { ...neMissions, ...neCreate }
import { missionMessages as ruMissions } from "./ru/missions"
import { missionCreateMessages as ruCreate } from "./ru/missions-create"
const ru = { ...ruMissions, ...ruCreate }
import { missionMessages as trMissions } from "./tr/missions"
import { missionCreateMessages as trCreate } from "./tr/missions-create"
const tr = { ...trMissions, ...trCreate }
import { missionMessages as zhHansMissions } from "./zh-Hans/missions"
import { missionCreateMessages as zhHansCreate } from "./zh-Hans/missions-create"
const zhHans = { ...zhHansMissions, ...zhHansCreate }

const locales = { de, en, es, fr, he, ja, ne, ru, tr, "zh-Hans": zhHans }

test("the user-facing mission journey has a translated key for every literal message", () => {
  const components = ["mission-result.tsx", "mission-task-checklist.tsx", "mission-tracking.tsx", "mission-attention.tsx",
    "mission-briefing.tsx", "mission-lifecycle-controls.tsx", "mission-recurrence-list.tsx", "mission-activity.tsx", "mission-guidance.tsx", "mission-model-library.tsx",
    "mission-profile-summary.tsx", "mission-default-inheritance-controls.tsx", "mission-editor.tsx", "mission-task-reader.tsx",
    "mission-preferences.tsx", "mission-subagent-depth.tsx", "mission-task-mode-controls.tsx"]
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
