import assert from "node:assert/strict"
import { test } from "node:test"

test("every locale advertises skills alongside files and agents in the prompt", async () => {
  for (const locale of ["de", "en", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const messages = await import(`./i18n/messages/${locale}/index.ts`)
    const merged = Object.values(messages)[0] as Record<string, string>
    const placeholder = merged["promptInput.placeholder.default"]
    assert.match(placeholder, /@skill/, locale)
    assert.match(placeholder, /@agent/, locale)
    assert.match(placeholder, /@(?:file|fichier|datei)/, locale)
  }
})
