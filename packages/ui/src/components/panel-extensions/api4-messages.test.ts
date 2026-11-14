import assert from "node:assert/strict"
import test from "node:test"
import { PANEL_EXTENSION_API4_PERMISSIONS } from "../../../../server/src/panel-extensions/contract"
import { instanceMessages as de } from "../../lib/i18n/messages/de/instance"
import { instanceMessages as en } from "../../lib/i18n/messages/en/instance"
import { instanceMessages as es } from "../../lib/i18n/messages/es/instance"
import { instanceMessages as fr } from "../../lib/i18n/messages/fr/instance"
import { instanceMessages as he } from "../../lib/i18n/messages/he/instance"
import { instanceMessages as ja } from "../../lib/i18n/messages/ja/instance"
import { instanceMessages as ne } from "../../lib/i18n/messages/ne/instance"
import { instanceMessages as ru } from "../../lib/i18n/messages/ru/instance"
import { instanceMessages as tr } from "../../lib/i18n/messages/tr/instance"
import { instanceMessages as zhHans } from "../../lib/i18n/messages/zh-Hans/instance"

test("every API 4 permission has its install sentence in all ten locales", () => {
  const keys = ["panelExtensions.api4.permissions", ...PANEL_EXTENSION_API4_PERMISSIONS.map(permission => `panelExtensions.api4.${permission}`)]
  for (const [locale, messages] of Object.entries({ de, en, es, fr, he, ja, ne, ru, tr, "zh-Hans": zhHans })) {
    for (const key of keys) {
      const value = (messages as Record<string, string | undefined>)[key]
      assert.ok(value?.trim(), `${locale}: ${key}`)
      if (locale !== "en") assert.notEqual(value, (en as Record<string, string>)[key], `${locale}: ${key} is translated`)
    }
  }
})
