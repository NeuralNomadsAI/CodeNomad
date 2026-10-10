import assert from "node:assert/strict"
import { test } from "node:test"

test("project briefing and tracking keys belong to all registered dictionaries with matching placeholders", async () => {
  const locales = ["en", "fr", "es", "de", "ru", "ja", "zh-Hans", "he", "ne", "tr"]
  let english: Record<string, string> = {}
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  for (const locale of locales) {
    const module = await import(`../lib/i18n/messages/${locale}/index.ts`)
    const messages = Object.values(module)[0] as Record<string, string>
    if (locale === "en") english = messages
    const keys = Object.keys(english).filter(key => key.startsWith("missions.briefing.") || key.startsWith("missions.tracking."))
    assert.ok(keys.length >= 30)
    for (const key of keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(messages, key), `${locale}: ${key}`)
      assert.deepEqual(placeholders(messages[key]), placeholders(english[key]), `${locale}: ${key}`)
    }
  }
})
