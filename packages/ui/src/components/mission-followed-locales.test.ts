import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { missionMessages as en } from "../lib/i18n/messages/en/missions"

for (const locale of ["en", "de", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) test(`followed conversations: ${locale} labels, placeholders and help agree`, async () => {
  const messages = (await import(`../lib/i18n/messages/${locale}/missions.ts`)).missionMessages as Record<string, string>
  assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort())
  for (const [key, value] of Object.entries(en)) {
    assert.ok(messages[key].trim(), key)
    assert.deepEqual(messages[key].match(/\{\w+\}/g)?.sort() ?? [], value.match(/\{\w+\}/g)?.sort() ?? [], key)
  }
  const help = await readFile(new URL(`../../../../docs/help/${locale}/missions.md`, import.meta.url), "utf8")
  for (const key of ["missions.followed.title", "missions.followed.add"]) assert.ok(help.includes(`**${messages[key]}**`), key)
})
