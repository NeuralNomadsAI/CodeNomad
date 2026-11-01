import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"

import { missionMessages as deMissions } from "./de/missions"
import { missionCreateMessages as deCreate } from "./de/missions-create"
import { missionSchedulingMessages as deScheduling } from "./de/mission-scheduling"
const de = { ...deMissions, ...deCreate, ...deScheduling }
import { missionMessages as enMissions } from "./en/missions"
import { missionCreateMessages as enCreate } from "./en/missions-create"
import { missionSchedulingMessages as enScheduling } from "./en/mission-scheduling"
const en = { ...enMissions, ...enCreate, ...enScheduling }
import { missionMessages as esMissions } from "./es/missions"
import { missionCreateMessages as esCreate } from "./es/missions-create"
import { missionSchedulingMessages as esScheduling } from "./es/mission-scheduling"
const es = { ...esMissions, ...esCreate, ...esScheduling }
import { missionMessages as frMissions } from "./fr/missions"
import { missionCreateMessages as frCreate } from "./fr/missions-create"
import { missionSchedulingMessages as frScheduling } from "./fr/mission-scheduling"
const fr = { ...frMissions, ...frCreate, ...frScheduling }
import { missionMessages as heMissions } from "./he/missions"
import { missionCreateMessages as heCreate } from "./he/missions-create"
import { missionSchedulingMessages as heScheduling } from "./he/mission-scheduling"
const he = { ...heMissions, ...heCreate, ...heScheduling }
import { missionMessages as jaMissions } from "./ja/missions"
import { missionCreateMessages as jaCreate } from "./ja/missions-create"
import { missionSchedulingMessages as jaScheduling } from "./ja/mission-scheduling"
const ja = { ...jaMissions, ...jaCreate, ...jaScheduling }
import { missionMessages as neMissions } from "./ne/missions"
import { missionCreateMessages as neCreate } from "./ne/missions-create"
import { missionSchedulingMessages as neScheduling } from "./ne/mission-scheduling"
const ne = { ...neMissions, ...neCreate, ...neScheduling }
import { missionMessages as ruMissions } from "./ru/missions"
import { missionCreateMessages as ruCreate } from "./ru/missions-create"
import { missionSchedulingMessages as ruScheduling } from "./ru/mission-scheduling"
const ru = { ...ruMissions, ...ruCreate, ...ruScheduling }
import { missionMessages as trMissions } from "./tr/missions"
import { missionCreateMessages as trCreate } from "./tr/missions-create"
import { missionSchedulingMessages as trScheduling } from "./tr/mission-scheduling"
const tr = { ...trMissions, ...trCreate, ...trScheduling }
import { missionMessages as zhHansMissions } from "./zh-Hans/missions"
import { missionCreateMessages as zhHansCreate } from "./zh-Hans/missions-create"
import { missionSchedulingMessages as zhHansScheduling } from "./zh-Hans/mission-scheduling"
const zhHans = { ...zhHansMissions, ...zhHansCreate, ...zhHansScheduling }

const locales = { de, en, es, fr, he, ja, ne, ru, tr, "zh-Hans": zhHans }

test("the user-facing mission journey has a translated key for every literal message", () => {
  const components = ["mission-task-tree.tsx", "mission-tracking.tsx", "mission-attention.tsx", "mission-overview-details.tsx",
    "mission-briefing.tsx", "mission-lifecycle-controls.tsx", "mission-recurrence-list.tsx", "mission-model-library.tsx",
    "mission-profile-summary.tsx", "mission-profile-controls.tsx", "mission-editor.tsx", "mission-task-reader.tsx",
    "mission-preferences.tsx", "mission-subagent-depth.tsx", "mission-task-mode-controls.tsx", "mission-comparison-report.tsx",
    "mission-scheduling.tsx", "mission-scheduling-sources.tsx", "mission-schedule-list.tsx", "mission-schedule-controls.ts", "mission-editor-schedule.ts"]
  for (const file of components) {
    const source = readFileSync(new URL(`../../../components/${file}`, import.meta.url), "utf8")
    for (const match of source.matchAll(/"(missions\.[\w.-]+)"/g)) {
      assert.ok(Object.prototype.hasOwnProperty.call(en, match[1]), `${file}: ${match[1]} is missing`)
    }
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
