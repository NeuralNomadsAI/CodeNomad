import assert from "node:assert/strict"
import test from "node:test"
import { integrationMessages as de } from "../../lib/i18n/messages/de/integrations"
import { integrationMessages as en } from "../../lib/i18n/messages/en/integrations"
import { integrationMessages as es } from "../../lib/i18n/messages/es/integrations"
import { integrationMessages as fr } from "../../lib/i18n/messages/fr/integrations"
import { integrationMessages as he } from "../../lib/i18n/messages/he/integrations"
import { integrationMessages as ja } from "../../lib/i18n/messages/ja/integrations"
import { integrationMessages as ne } from "../../lib/i18n/messages/ne/integrations"
import { integrationMessages as ru } from "../../lib/i18n/messages/ru/integrations"
import { integrationMessages as tr } from "../../lib/i18n/messages/tr/integrations"
import { integrationMessages as zhHans } from "../../lib/i18n/messages/zh-Hans/integrations"

test("host detach banner labels, states and info text exist and are translated in all ten locales", () => {
  const keys = ["integrations.host.region", "integrations.host.detach", "integrations.host.detaching", "integrations.host.detached",
    "integrations.host.info", "integrations.binding.attached", "integrations.binding.unknown"]
  for (const [locale, messages] of Object.entries({ de, en, es, fr, he, ja, ne, ru, tr, "zh-Hans": zhHans })) {
    for (const key of keys) {
      const value = (messages as Record<string, string | undefined>)[key]
      assert.ok(value?.trim(), `${locale}: ${key}`)
      if (locale !== "en") assert.notEqual(value, (en as Record<string, string>)[key], `${locale}: ${key} is translated`)
      if (key.endsWith(".detached") || key.endsWith(".attached")) assert.ok(value!.includes("{label}"), `${locale}: ${key} keeps {label}`)
    }
    // Terse state labels; the one explanatory sentence lives behind the info button.
    for (const key of ["integrations.host.detach", "integrations.host.detaching"]) assert.ok([...(messages as Record<string, string>)[key]!].length <= 24, `${locale}: ${key}`)
  }
})
