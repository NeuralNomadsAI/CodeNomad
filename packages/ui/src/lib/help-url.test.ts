import assert from "node:assert/strict"
import { test } from "node:test"
import { HELP_BASE_URL, helpUrl } from "./help-url"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

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
  for (const page of ["", "../index", "Sponsor", "sponsor.html", "sponsor#channels", "sponsor?x=1", "https://example.com", "a/b", "-", "--index"]) {
    assert.equal(helpUrl("he", page), `${HELP_BASE_URL}he/`, page)
  }
})

test("section anchors stay inside the selected localized article", () => {
  assert.equal(helpUrl("zh-Hans", "opencode", "login-start"), `${HELP_BASE_URL}zh-Hans/opencode.html#login-start`)
  assert.equal(helpUrl("fr", "settings", "agent-memory"), `${HELP_BASE_URL}fr/settings.html#agent-memory`)
  for (const anchor of ["", "#login-start", "../", "x?y=1", "x/y", "https://example.com", "x%0a", "x\n"]) {
    assert.equal(helpUrl("fr", "opencode", anchor), `${HELP_BASE_URL}fr/opencode.html`)
  }
  assert.equal(helpUrl("fr", "../settings", "agent-memory"), `${HELP_BASE_URL}fr/`)
})

test("every literal contextual destination exists with its section in all published locales", async () => {
  const root = fileURLToPath(new URL("../../../..", import.meta.url))
  const components = path.join(root, "packages/ui/src/components")
  const files = (await readdir(components, { recursive: true })).filter(file => /\.tsx?$/.test(file)).map(file => path.join(components, file))
  files.push(path.join(root, "packages/ui/src/lib/settings/behavior-registry.ts"))
  let destinations = 0
  for (const file of files) {
    const source = await readFile(file, "utf8")
    for (const match of source.matchAll(/help(?:=\{|:)\s*\{\s*page:\s*"([a-z0-9-]+)"(?:,\s*anchor:\s*"([a-z0-9-]+)")?\s*\}/g)) {
      destinations++
      for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
        const article = await readFile(path.join(root, `docs/help/${locale}/${match[1]}.md`), "utf8")
        if (match[2]) assert.ok(article.includes(`{#${match[2]}}`), `${locale}/${match[1]}#${match[2]} in ${file}`)
      }
    }
  }
  assert.ok(destinations >= 15, "contextual links are checked, including registry and field helpers")
})
