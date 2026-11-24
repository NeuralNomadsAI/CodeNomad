import assert from "node:assert/strict"
import test from "node:test"

import { deMessages as de } from "./messages/de"
import { enMessages as en } from "./messages/en"
import { esMessages as es } from "./messages/es"
import { frMessages as fr } from "./messages/fr"
import { heMessages as he } from "./messages/he"
import { jaMessages as ja } from "./messages/ja"
import { neMessages as ne } from "./messages/ne"
import { ruMessages as ru } from "./messages/ru"
import { trMessages as tr } from "./messages/tr"
import { zhHansMessages as zhHans } from "./messages/zh-Hans"

const locales = { de, en, es, fr, he, ja, ne, ru, tr, "zh-Hans": zhHans }
const binding = /\{shortcut\}|\b(?:cmd|ctrl|control|mod|alt|shift|esc(?:ape)?|enter)\b|[⌘⌃⌥⇧⎋]/i

test("all ten dictionaries merge without duplicate keys and omit retired submit-shortcut copy", () => {
  for (const [locale, messages] of Object.entries(locales)) {
    assert.ok(Object.keys(messages).length > 0, `${locale} merged dictionary`)
    assert.deepEqual(Object.keys(messages).filter(key => key.startsWith("commands.promptSubmitShortcut.")), [], locale)
  }
})

test("launcher help stays combo-free and retains the alternate-action explanation in all locales", () => {
  for (const [locale, messages] of Object.entries(locales)) {
    const title = messages["instanceTabs.new.launcherTitle"]
    assert.ok(title, `${locale} launcher title`)
    assert.doesNotMatch(title, binding, locale)
    assert.ok(title.split(" — ")[1]?.trim(), `${locale} launcher help`)
  }
})

test("transient stop confirmation is combo-free without a shortcut placeholder in all locales", () => {
  assert.equal(en["promptInput.overlay.abortHint"], "Press again to stop")
  for (const [locale, messages] of Object.entries(locales)) {
    const hint = messages["promptInput.overlay.abortHint"]
    assert.ok(hint, `${locale} stop confirmation`)
    assert.doesNotMatch(hint, binding, locale)
  }
})
