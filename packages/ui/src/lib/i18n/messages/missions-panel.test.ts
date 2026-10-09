import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"

import { missionsPanelMessages as de } from "./de/missions-panel"
import { missionsPanelMessages as en } from "./en/missions-panel"
import { missionsPanelMessages as es } from "./es/missions-panel"
import { missionsPanelMessages as fr } from "./fr/missions-panel"
import { missionsPanelMessages as he } from "./he/missions-panel"
import { missionsPanelMessages as ja } from "./ja/missions-panel"
import { missionsPanelMessages as ne } from "./ne/missions-panel"
import { missionsPanelMessages as ru } from "./ru/missions-panel"
import { missionsPanelMessages as tr } from "./tr/missions-panel"
import { missionsPanelMessages as zhHans } from "./zh-Hans/missions-panel"

const locales = { de, en, es, fr, he, ja, ne, ru, tr, "zh-Hans": zhHans }
const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

test("every Missions panel key exists in all ten locales with the English placeholders", () => {
  const expected = Object.keys(en).sort()
  for (const [locale, messages] of Object.entries(locales)) {
    assert.deepEqual(Object.keys(messages).sort(), expected, `${locale} keys`)
    for (const key of expected) assert.deepEqual(placeholders((messages as Record<string, string>)[key]),
      placeholders(en[key as keyof typeof en]), `${locale}:${key} placeholders`)
  }
})

test("panel components reference only declared Missions panel keys", () => {
  const files = ["instance/shell/right-panel/tabs/MissionControl.tsx", "mission-index-row.tsx", "mission-task-tree.tsx",
    "mission-tracking.tsx", "mission-attention.tsx", "mission-lifecycle-controls.tsx", "mission-recurrence-list.tsx", "mission-overview-details.tsx"]
  for (const file of files) {
    const source = readFileSync(new URL(`../../../components/${file}`, import.meta.url), "utf8")
    for (const match of source.matchAll(/["`](missionsPanel\.[\w.-]+?)(\$\{[^}]+\})?["`]/g)) {
      const key = match[1]
      if (match[2]) assert.ok(Object.keys(en).some(candidate => candidate.startsWith(key)), `${file}: ${key}* is missing`)
      else assert.ok(Object.prototype.hasOwnProperty.call(en, key), `${file}: ${key} is missing`)
    }
  }
  for (const word of ["done", "active", "input", "assigned", "ready", "waiting", "blocked", "failed", "retired"]) assert.ok(`missionsPanel.task.${word}` in en)
  for (const action of ["pause", "resume"]) assert.ok(`missionsPanel.action.${action}` in en)
})
