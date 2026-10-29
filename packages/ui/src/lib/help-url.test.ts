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

test("help pages open in the mapped locale and malformed page names open its home", () => {
  assert.equal(helpUrl("fr-FR", "sponsor"), `${HELP_BASE_URL}fr/sponsor.html`)
  assert.equal(helpUrl("zh-TW", "sponsor"), `${HELP_BASE_URL}zh-Hans/sponsor.html`)
  assert.equal(helpUrl(undefined, "sponsor"), `${HELP_BASE_URL}en/sponsor.html`)
  assert.equal(helpUrl("../", "sponsor"), `${HELP_BASE_URL}en/sponsor.html`)
  for (const page of ["", "../index", "Sponsor", "sponsor.html", "sponsor#channels", "sponsor?x=1", "https://example.com", "a/b"]) {
    assert.equal(helpUrl("he", page), `${HELP_BASE_URL}he/`, page)
  }
})
