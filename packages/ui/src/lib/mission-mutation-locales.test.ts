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
  const keys = ["missions.control.creation.capacity",
    "missions.control.creation.unavailable", "missions.control.creation.worktreeDeleting",
     "missions.control.mutation.requestConflict", "missions.control.mutation.forbidden",
     "missions.cleanup.error.revisionConflict", "missions.cleanup.error.requestConflict", "missions.cleanup.error.controlPending"]
  assert.equal(Object.keys(bundles).length, 10)
  for (const [locale, messages] of Object.entries(bundles)) for (const key of keys) {
    assert.ok(messages[key]?.length, `${locale} owns ${key}`)
    if (locale !== "en") assert.notEqual(messages[key], enMessages[key as keyof typeof enMessages])
  }
  for (const messages of Object.values(bundles)) for (const key of ["uncertain", "uncertainOther", "scopeConflict"])
    assert.equal(`missions.control.creation.${key}` in messages, false)
})
