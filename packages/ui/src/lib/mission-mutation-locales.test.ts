import assert from "node:assert/strict"
import test from "node:test"
import type { Locale } from "./i18n"
import { enMessages } from "./i18n/messages/en"
import { deMessages } from "./i18n/messages/de"
import { esMessages } from "./i18n/messages/es"
import { frMessages } from "./i18n/messages/fr"
import { heMessages } from "./i18n/messages/he"
import { jaMessages } from "./i18n/messages/ja"
import { neMessages } from "./i18n/messages/ne"
import { ruMessages } from "./i18n/messages/ru"
import { trMessages } from "./i18n/messages/tr"
import { zhHansMessages } from "./i18n/messages/zh-Hans"

test("all ten registered locale bundles own truthful creation classification keys without fallback", () => {
  const bundles: Record<Locale, Record<string, string>> = { en: enMessages, de: deMessages, es: esMessages, fr: frMessages,
    he: heMessages, ja: jaMessages, ne: neMessages, ru: ruMessages, tr: trMessages, "zh-Hans": zhHansMessages }
  const keys = ["missions.control.creation.uncertain", "missions.control.creation.scopeConflict", "missions.control.creation.capacity",
    "missions.control.mutation.requestConflict", "missions.control.mutation.forbidden"]
  assert.equal(Object.keys(bundles).length, 10)
  for (const [locale, messages] of Object.entries(bundles)) for (const key of keys) {
    assert.ok(messages[key]?.length, `${locale} owns ${key}`)
    if (locale !== "en") assert.notEqual(messages[key], enMessages[key as keyof typeof enMessages])
  }
  assert.match(enMessages[keys[0] as keyof typeof enMessages], /deletion remains blocked/)
  assert.match(enMessages[keys[0] as keyof typeof enMessages], /reopening does not repair/)
  assert.match(enMessages[keys[0] as keyof typeof enMessages], /restart recovery are not yet qualified/)
})
