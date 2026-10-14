import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { buildHelp, HELP_BASE_URL, languageRedirectScript, readSite, readChromeStrings, SECTION_IDS, TRANSLATION_PROBLEMS } from "./build-help.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const [value] = args.splice(index, 2).slice(1)
  assert.ok(value, `${name} needs a value`)
  return value
}
const content = resolve(option("--content", resolve(root, "docs/help")))
const onlyLocale = option("--locale", process.env.CODENOMAD_HELP_LOCALE)
assert.deepEqual(args, [], "unknown help test options")
const LOCALES = ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]
const sections = (pages) => SECTION_IDS.map((id, index) => ({ id, pages: index === 0 ? pages : [] }))

async function temporary(ctx) {
  const temporaryRoot = process.platform === "win32" ? join(tmpdir(), "opencode") : tmpdir()
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(join(temporaryRoot, "codenomad-help-"))
  ctx.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function fixture(ctx) {
  const directory = await temporary(ctx)
  const source = join(directory, "source")
  await mkdir(source)
  const manifest = JSON.parse(await readFile(resolve(root, "docs/help/site.json"), "utf8"))
  await writeFile(join(source, "site.json"), JSON.stringify(manifest))
  // A Windows temp directory may be on another drive; a junction keeps the
  // Markdown image relative while still reading the real repository asset.
  await symlink(resolve(root, "images"), join(source, "images"), process.platform === "win32" ? "junction" : "dir")
  const image = "../images/CodeNomad-Icon.png"
  for (const locale of LOCALES) {
    await mkdir(join(source, locale))
    for (const page of manifest.sections.flatMap((section) => section.pages)) {
      await writeFile(join(source, locale, `${page}.md`), `# ${locale} ${page === "index" ? "Guide" : page}\n\n[Conversations](conversations.md#requests) · [Current heading](#start) · [OpenCode](https://opencode.ai/v2/docs/)\n\n## Start {#start}\n\n![Logo](${image})\n\n### Details {#details}\n\nText.\n\n## Requests {#requests}\n\n[Home](index.md#start)\n`)
    }
  }
  return { source, output: join(directory, "output") }
}

const unescape = (value) => value.replace(/&(?:amp|quot|#39|lt|gt);/g, (entity) => ({ "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" })[entity])

async function checkSearch(output, locale) {
  const entries = JSON.parse(await readFile(join(output, locale, "search-index.json"), "utf8"))
  assert.ok(entries.length, "search index must contain headings")
  for (const entry of entries) {
    assert.ok(entry.title && entry.heading && typeof entry.excerpt === "string")
    assert.match(entry.href, /^[a-z0-9-]+\.html#[a-z0-9-]+$/)
    const [page, id] = entry.href.split("#")
    assert.ok((await readFile(join(output, locale, page), "utf8")).includes(`id="${id}"`), `invalid search target: ${entry.href}`)
  }
}

async function checkHtml(output, locale, page, locales) {
  const file = join(output, locale, `${page}.html`)
  const html = await readFile(file, "utf8")
  assert.match(html, new RegExp(`<html lang="${locale}" dir="${locale === "he" ? "rtl" : "ltr"}">`))
  assert.equal((html.match(/<h1(?:\s|>)/g) ?? []).length, 1, file)
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 2, "one current link in each CSS-exclusive navigation")
  assert.match(html, new RegExp(`href="${page}\.html" aria-current="page"`))
  assert.ok(!/\{#[^}]*\}/.test(html), "heading suffixes must not be visible")
  assert.equal((html.match(/<script\b/g) ?? []).length, 1, "only the first-party search script is permitted")
  assert.match(html, /<script src="\.\.\/assets\/help-search\.js" defer><\/script>/)
  assert.ok(!/<(?:iframe|audio|video)\b|\bon\w+\s*=/i.test(html), "page content must be static")
  assert.match(html, /class="help-search" hidden/)
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
  assert.equal(ids.length, new Set(ids).size, `duplicate anchors in ${file}`)
  for (const heading of html.matchAll(/<h[2-6]\b([^>]*)>/g)) assert.match(heading[1], /\bid="[a-z0-9]+(?:-[a-z0-9]+)*"/, file)
  for (const other of locales) {
    const url = `${HELP_BASE_URL}${other}/${page === "index" ? "" : `${page}.html`}`
    assert.ok(html.includes(`<link rel="alternate" hreflang="${other}" href="${url}">`), url)
    assert.ok(html.includes(`href="../${other}/${page}.html" hreflang="${other}" lang="${other}"`), "switching language preserves the page")
  }
  assert.ok(html.includes(`hreflang="x-default" href="${HELP_BASE_URL}en/${page === "index" ? "" : `${page}.html`}"`))
  for (const [, attribute, encoded] of html.matchAll(/\b(href|src)="([^"]+)"/g)) {
    const url = unescape(encoded)
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) {
      assert.equal(attribute, "href", `no remote requests: ${url}`)
      continue
    }
    assert.ok(!url.startsWith("/"), `project Pages links must stay relative: ${url}`)
    assert.ok(!url.includes(".md"), `Markdown link not converted: ${url}`)
    const [path, fragment] = url.split("#")
    const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file
    const bytes = await readFile(target)
    if (fragment) assert.ok(bytes.toString().includes(`id="${decodeURIComponent(fragment)}"`), `broken anchor: ${locale}/${page} → ${url}`)
  }
}

test("declared help pages have translations, stable heading ids, links, images and standalone chrome", async (ctx) => {
  const site = await readSite(content)
  assert.deepEqual(site.locales, LOCALES, "help must support the app's ten locales")
  assert.deepEqual(site.sections.map((section) => section.pages), [
    ["index", "install", "server"], ["projects", "conversations", "history", "files", "permissions", "missions"],
    ["opencode", "providers", "integrations"], ["remote-access", "remote-control", "security", "mobile"],
    ["settings", "shortcuts", "voice"], ["extensions"], ["desktop", "browser-sidecars", "updates"], ["troubleshooting", "support"],
  ], "all approved pages must remain reachable in their eight groups")
  if (onlyLocale) assert.ok(site.locales.includes(onlyLocale), `unsupported locale: ${onlyLocale}`)
  const output = await temporary(ctx)
  const built = await buildHelp({ content, output })
  const problems = built.problems.filter((problem) => !onlyLocale || problem.locale === onlyLocale || problem.locale === "en")
  assert.deepEqual(problems, [], problems.map((problem) => `${problem.locale}/${problem.page}: ${problem.message}`).join("\n"))
  const locales = onlyLocale ? [onlyLocale] : site.locales
  for (const locale of locales) for (const page of built.pages) await checkHtml(output, locale, page, site.locales)
  const chooser = await readFile(join(output, "index.html"), "utf8")
  assert.equal((chooser.match(/<script>/g) ?? []).length, 1, "only the root chooser needs JavaScript")
  for (const locale of site.locales) assert.ok(chooser.includes(`href="${locale}/"`), "chooser works with JavaScript disabled")
  const css = await readFile(join(output, "assets/help.css"), "utf8")
  assert.ok(!/@import|https?:\/\//.test(css), "no remote styles or fonts")
  for (const locale of locales) await checkSearch(output, locale)
  ctx.diagnostic(`Validated ${built.pages.length} pages × ${locales.length} locale(s)`)
})

test("generic media is shared, H1 titles label translated navigation, and Markdown links keep anchors", async (ctx) => {
  const { source, output } = await fixture(ctx)
  const built = await buildHelp({ content: source, output })
  assert.deepEqual(built.problems, [])
  assert.equal((await readdir(join(output, "assets/media"))).length, 1, "ten translations share one image")
  for (const locale of LOCALES) {
    await checkHtml(output, locale, "index", LOCALES)
    const html = await readFile(join(output, locale, "index.html"), "utf8")
    assert.ok(html.includes(`<a href="conversations.html">${locale} conversations</a>`))
    assert.ok(html.includes('href="conversations.html#requests"'))
    assert.ok(html.includes('href="https://opencode.ai/v2/docs/"'))
    assert.ok(html.includes(`<h2 id="start">Start</h2>`))
    assert.ok(html.includes(`<h3 id="details">Details</h3>`))
  }
  const file = join(source, "fr/index.md")
  await writeFile(file, (await readFile(file, "utf8")).replace("fr Guide", "Aide & modèles <i>fr</i>"))
  assert.deepEqual((await buildHelp({ content: source, output })).problems, [], "translated title changes never affect anchor identity")
  const french = await readFile(join(output, "fr/index.html"), "utf8")
  assert.ok(french.includes('<title>Aide &amp; modèles fr - '))
  assert.ok(!french.includes('&amp;amp;'))
})

test("English fallback is visibly marked in the selected language, and strict validation records the missing translation", async (ctx) => {
  const { source, output } = await fixture(ctx)
  await rm(join(source, "he/conversations.md"))
  const built = await buildHelp({ content: source, output })
  assert.deepEqual(built.problems.map(({ kind, locale, page }) => ({ kind, locale, page })), [{ kind: "missing-translation", locale: "he", page: "conversations" }])
  const html = await readFile(join(output, "he/conversations.html"), "utf8")
  assert.match(html, /<article lang="en" dir="ltr">/)
  const hebrew = JSON.parse(await readFile(resolve(root, "docs/help/i18n/he.json"), "utf8"))
  assert.ok(html.includes(hebrew.untranslated))
  assert.ok(html.includes(`${HELP_BASE_URL}he/conversations.html`))
  await checkHtml(output, "he", "conversations", LOCALES)
})

test("validator rejects missing/invalid/duplicate ids, translation drift, missing pages and unresolved links/images", async (ctx) => {
  const { source, output } = await fixture(ctx)
  const original = await readFile(join(source, "en/index.md"), "utf8")
  const cases = [
    ["missing-id", original.replace(" {#start}", "")],
    ["invalid-id", original.replace("{#start}", "{#Not-Stable}")],
    ["duplicate-id", original.replace("{#details}", "{#start}")],
    ["reserved-id", original.replace("{#details}", "{#content}")],
    ["reserved-id", original.replace("{#details}", "{#help-query}")],
    ["broken-link", original.replace("conversations.md#requests", "missing.md#requests")],
    ["broken-anchor", original.replace("conversations.md#requests", "conversations.md#missing")],
    ["h1-id", original.replace("Guide", "Guide {#title}")],
    ["missing-image", `${original}\n![Missing](no-such-file.png)\n`],
    ["remote-image", `${original}\n![Remote](https://example.com/image.png)\n`],
  ]
  for (const [kind, markdown] of cases) {
    await writeFile(join(source, "en/index.md"), markdown)
    const built = await buildHelp({ content: source, output })
    assert.ok(built.problems.some((problem) => problem.kind === kind), `${kind} must fail validation`)
  }
  await writeFile(join(source, "en/index.md"), original)
  await writeFile(join(source, "fr/index.md"), original.replace("{#details}", "{#drift}"))
  assert.ok((await buildHelp({ content: source, output })).problems.some((problem) => problem.kind === "heading-mismatch"))
  await writeFile(join(source, "fr/index.md"), original.replace("### Details", "## Details"))
  assert.ok((await buildHelp({ content: source, output })).problems.some((problem) => problem.kind === "heading-mismatch"))
  assert.ok(!TRANSLATION_PROBLEMS.has("heading-mismatch"), "heading drift must be fatal in the build too")
  await rm(join(source, "en/conversations.md"))
  assert.ok((await buildHelp({ content: source, output })).problems.some((problem) => problem.kind === "missing-page"))
})

test("root chooser finds the best supported language including regions, Chinese tags and legacy Hebrew", () => {
  for (const [languages, expected] of [
    [["pt-BR", "fr-CA", "en"], "fr"], [["zh-TW"], "zh-Hans"], [["zh_Hant_HK"], "zh-Hans"],
    [["HE-il"], "he"], [["iw-IL"], "he"], [["ne-NP"], "ne"], [["tr-TR"], "tr"],
    [["zz", "de-AT"], "de"], [["ja-JP"], "ja"], [["es-MX"], "es"], [["ru-RU"], "ru"],
    [["pt-BR"], "en"], [[], "en"], [["fr-../../"], "en"], [["zh-https://evil.example"], "en"], [["he-_/%"], "en"],
  ]) {
    let redirect
    runInNewContext(languageRedirectScript(LOCALES), { navigator: { languages, language: languages[0] ?? "en" }, location: { replace: (path) => { redirect = path } } })
    assert.equal(redirect, `${expected}/`, languages.join(","))
  }
})

test("chrome rejects missing, empty, non-string and missing-section values", async (ctx) => {
  const directory = await temporary(ctx)
  await mkdir(join(directory, "i18n"))
  const original = JSON.parse(await readFile(resolve(root, "docs/help/i18n/en.json"), "utf8"))
  for (const change of [
    (value) => { delete value.search.label },
    (value) => { value.search.label = "" },
    (value) => { value.search.label = 1 },
    (value) => { value.search = null },
    (value) => { delete value.sections.extensions },
  ]) {
    const value = structuredClone(original); change(value)
    await writeFile(join(directory, "i18n/en.json"), JSON.stringify(value))
    await assert.rejects(readChromeStrings(["en"], directory))
  }
})

test("rebuild removes owned stale pages, locale files and media but preserves unrelated output", async (ctx) => {
  const { source, output } = await fixture(ctx)
  await buildHelp({ content: source, output })
  await writeFile(join(output, "user-file.txt"), "preserve")
  const manifest = JSON.parse(await readFile(join(source, "site.json"), "utf8"))
  manifest.locales = ["en"]
  manifest.sections.at(-1).pages = []
  await writeFile(join(source, "site.json"), JSON.stringify(manifest))
  for (const page of manifest.sections.flatMap((section) => section.pages)) {
    const file = join(source, "en", `${page}.md`)
    await writeFile(file, (await readFile(file, "utf8")).replace(/!\[Logo\]\([^)]*\)/g, ""))
  }
  await buildHelp({ content: source, output })
  await assert.rejects(readFile(join(output, "en/support.html")))
  await assert.rejects(readFile(join(output, "he/index.html")))
  assert.deepEqual(await readdir(join(output, "assets/media")), [])
  assert.equal(await readFile(join(output, "user-file.txt"), "utf8"), "preserve")
})

test("images cannot escape the repository directly or through symlinks; search targets are checked", async (ctx) => {
  const { source, output } = await fixture(ctx)
  const outside = join(source, "outside.png")
  await writeFile(outside, "not repository data")
  await symlink(source, join(source, "escape"), process.platform === "win32" ? "junction" : "dir")
  const file = join(source, "en/index.md"), original = await readFile(file, "utf8")
  for (const image of ["../outside.png", "../escape/outside.png"]) {
    await writeFile(file, `${original}\n![Escaped](${image})`)
    assert.ok((await buildHelp({ content: source, output })).problems.some((problem) => problem.kind === "missing-image"))
  }
  await writeFile(file, original)
  await buildHelp({ content: source, output })
  await checkSearch(output, "en")
  await writeFile(join(output, "en/search-index.json"), JSON.stringify([{ title: "bad", heading: "bad", excerpt: "", href: "index.html#missing" }]))
  await assert.rejects(checkSearch(output, "en"), /invalid search target/)
})
