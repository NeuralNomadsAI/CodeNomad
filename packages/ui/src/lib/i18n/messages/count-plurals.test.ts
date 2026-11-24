import assert from "node:assert/strict"
import test from "node:test"
import { deMessages as de } from "./de"
import { enMessages as en } from "./en"
import { esMessages as es } from "./es"
import { frMessages as fr } from "./fr"
import { heMessages as he } from "./he"
import { jaMessages as ja } from "./ja"
import { neMessages as ne } from "./ne"
import { ruMessages as ru } from "./ru"
import { trMessages as tr } from "./tr"
import { zhHansMessages as zhHans } from "./zh-Hans"

const singulars = {
  "toolCall.task.steps.count": "{count} step",
  "promptInput.overlay.attachments": "• {count} file attached",
  "gitPanel.files": "{count} changed file",
  "commands.removeSessionTechnicalParts.failed.message": "Failed to clean {count} response.",
  "sessionList.bulkDelete.ariaLabel": "Delete {count} selected session",
  "sessionList.bulkDelete.confirmMessage": "Delete {count} selected session? This cannot be undone.",
  "sessionList.bulkDelete.error": "Unable to delete {count} session",
}

for (const [locale, messages] of Object.entries({ en, fr, de, es, he, ja, ne, ru, tr, "zh-Hans": zhHans })) {
  test(`${locale}: count labels have explicit singular and plural translations`, () => {
    const translated: Record<string, string> = messages
    for (const [key, singular] of Object.entries(singulars)) {
      assert.equal(translated[key], undefined, `${key} must use an explicit count form`)
      for (const form of ["one", "other"]) {
        assert.match(translated[`${key}.${form}`] ?? "", /\{count\}/, `${key}.${form} keeps the count`)
        assert.doesNotMatch(translated[`${key}.${form}`], /\([^)]*\)|קובץ\/ים|מצורף\/ים/, `${key}.${form} has no combined forms`)
      }
      if (locale === "en") assert.equal(translated[`${key}.one`], singular)
    }
  })
}
