import assert from "node:assert/strict"
import { test } from "node:test"
import { missionSchedulingMessages as en } from "../lib/i18n/messages/en/mission-scheduling"

for (const locale of ["de", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) test(`scheduling ${locale} has every key and exact placeholders`, async () => {
  const messages = (await import(`../lib/i18n/messages/${locale}/mission-scheduling.ts`)).missionSchedulingMessages as Record<string, string>
  assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort())
  for (const [key, value] of Object.entries(en)) {
    assert.ok(messages[key].trim(), key)
    assert.deepEqual(messages[key].match(/\{\w+\}/g)?.sort() ?? [], value.match(/\{\w+\}/g)?.sort() ?? [], key)
  }
})
