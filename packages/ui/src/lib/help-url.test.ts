import assert from "node:assert/strict"
import { test } from "node:test"
import { HELP_BASE_URL, helpUrl } from "./help-url"

test("help paths follow the UI locales, regions and browser language aliases without accepting arbitrary paths", () => {
  for (const [input, expected] of [
    ["en", "en"], ["fr-FR", "fr"], ["de-AT", "de"], ["es-MX", "es"],
    ["he", "he"], ["iw-IL", "he"], ["ja-JP", "ja"], ["ne-NP", "ne"],
    ["ru-RU", "ru"], ["tr-TR", "tr"], ["zh-Hans", "zh-Hans"], ["zh-TW", "zh-Hans"],
    [" FR_ca ", "fr"], ["pt-BR", "en"], ["../../", "en"], ["https://example.com", "en"],
    ["", "en"], [undefined, "en"],
    ["fr-../../", "en"], ["zh-https://evil.example", "en"], ["he-_/%", "en"], ["ja-", "en"],
  ]) assert.equal(helpUrl(input), `${HELP_BASE_URL}${expected}/`, input)
})
