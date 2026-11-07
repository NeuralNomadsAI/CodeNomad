import assert from "node:assert/strict"
import { test } from "node:test"
import { shouldShowProviderUsageWindow } from "./provider-usage-state"
import { settingsMessages } from "../../lib/i18n/messages/en/settings"

test("supplemental provider credit balances are opt-in", () => {
  assert.equal(shouldShowProviderUsageWindow("credits_balance", false), false)
  assert.equal(shouldShowProviderUsageWindow("credits_balance", true), true)
  assert.equal(shouldShowProviderUsageWindow("credits", false), true)
  assert.equal(shouldShowProviderUsageWindow("weekly", false), true)
})

test("all ten app locales include every provider usage label", async () => {
  const keys = Object.keys(settingsMessages).filter(key => key.startsWith("providerUsage.")).sort()
  for (const locale of ["fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const messages = (await import(`../../lib/i18n/messages/${locale}/settings.ts`)).settingsMessages
    assert.deepEqual(Object.keys(messages).filter(key => key.startsWith("providerUsage.")).sort(), keys, locale)
    for (const key of keys) assert.ok(messages[key]?.trim(), `${locale}: ${key}`)
    assert.notEqual(messages["providerUsage.estimated"], "(estimation)")
  }
})
