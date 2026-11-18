import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { settingsMessages as de } from "./de/settings"
import { settingsMessages as en } from "./en/settings"
import { settingsMessages as es } from "./es/settings"
import { settingsMessages as fr } from "./fr/settings"
import { settingsMessages as he } from "./he/settings"
import { settingsMessages as ja } from "./ja/settings"
import { settingsMessages as ne } from "./ne/settings"
import { settingsMessages as ru } from "./ru/settings"
import { settingsMessages as tr } from "./tr/settings"
import { settingsMessages as zhHans } from "./zh-Hans/settings"

for (const [locale, messages] of Object.entries({ de, en, es, fr, he, ja, ne, ru, tr, "zh-Hans": zhHans })) {
  test(`${locale}: Console connection action and help quote the Settings and Providers labels`, () => {
    const path = `${messages["settings.title"]} → ${messages["settings.nav.providers"]}`
    assert.equal(messages["providerUsage.console.settings"], path)

    const help = readFileSync(new URL(`../../../../../../docs/help/${locale}/providers.md`, import.meta.url), "utf8")
    const errors = help.split(/\r?\n\r?\n/).find(paragraph => paragraph.includes("401") && paragraph.includes("403"))
    assert.ok(errors?.includes(`**${path}**`), `${locale}: Console connection errors link to ${path}`)
  })
}
