import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { missionSchedulingMessages as en } from "../lib/i18n/messages/en/mission-scheduling"

for (const locale of ["en", "de", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) test(`scheduling ${locale} has every key, exact placeholders and its configuration label in help`, async () => {
  const messages = (await import(`../lib/i18n/messages/${locale}/mission-scheduling.ts`)).missionSchedulingMessages as Record<string, string>
  assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort())
  for (const [key, value] of Object.entries(en)) {
    assert.ok(messages[key].trim(), key)
    assert.deepEqual(messages[key].match(/\{\w+\}/g)?.sort() ?? [], value.match(/\{\w+\}/g)?.sort() ?? [], key)
  }
  const label = messages["missions.settings.effectiveOrigin"]
  assert.match(label, /[:：]$/)
  if (locale === "fr") assert.equal(label, "Fichier de configuration OpenCode\u00a0:")
  const help = await readFile(new URL(`../../../../docs/help/${locale}/missions.md`, import.meta.url), "utf8")
  assert.ok(help.includes(`**${label}**`), "help cites the exact UI label")
})
