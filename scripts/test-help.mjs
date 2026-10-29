import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { parse as parseYaml } from "yaml"
import { buildHelp, HELP_BASE_URL, languageRedirectScript, readDownloads, readSite, readChromeStrings, SECTION_IDS, TOUR_MEDIA, TOUR_URL, TRANSLATION_PROBLEMS, validateRelease } from "./build-help.mjs"
import { fetchReleases, nextPage, run as resolveRelease, selectRelease } from "./resolve-help-release.mjs"
import "./test-help-download.mjs"

// Help builds and checks are offline: any fetch fails the call and the final test.
const fetchCalls = []
globalThis.fetch = async (...request) => { fetchCalls.push(request); throw new Error("help tests must not use the network") }

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
const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'">`

// The one media element of the site: the home page's silent tour, whose source applies only to
// wide screens without reduced motion, with the poster as the image everywhere else.
function checkTour(html, chrome) {
  assert.equal(TOUR_MEDIA, "(prefers-reduced-motion: no-preference) and (min-width: 721px)")
  assert.deepEqual(html.match(/<figure class="tour">[\s\S]*?<\/figure>/g), [`<figure class="tour"><video autoplay muted loop playsinline controls preload="metadata" width="1280" height="720" poster="../assets/media/codenomad-tour-poster.jpg" aria-label="${escapeHtml(chrome.tour.label)}"><source src="../assets/media/codenomad-tour.mp4" type="video/mp4" media="${TOUR_MEDIA}"></video><img src="../assets/media/codenomad-tour-poster.jpg" alt="${escapeHtml(chrome.tour.poster)}" width="1280" height="720"><figcaption><a href="${TOUR_URL}">${escapeHtml(chrome.tour.caption)}</a></figcaption></figure>`])
}

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
  const scripts = ["help-search", ...(page === "download" ? ["help-download"] : [])].map((name) => `<script src="../assets/${name}.js" defer></script>`)
  // HTML tag names are case-insensitive: every script start counts, and only the exact owned tags pass.
  assert.deepEqual(html.match(/<script\b[^>]*>[\s\S]*?<\/script>|<script\b/gi) ?? [], scripts, "only the owned search script, plus the download script on the download page")
  assert.ok(!/<(?:iframe|audio|embed|object|track)\b|\bon\w+\s*=/i.test(html), "page content must be static")
  const media = html.match(/<(?:video|source)\b[^>]*>/gi) ?? []
  if (media.length) {
    assert.equal(page, "index", "only the home page shows media")
    assert.equal(media.length, 2, "one video with one source")
    assert.match(media[0], /^<video autoplay muted loop playsinline controls preload="metadata" width="1280" height="720" poster="\.\.\/assets\/media\/codenomad-tour-poster\.jpg" aria-label="[^"]+">$/)
    assert.equal(media[1], `<source src="../assets/media/codenomad-tour.mp4" type="video/mp4" media="${TOUR_MEDIA}">`)
  }
  assert.ok(html.includes(CSP), "media, like images, scripts and styles, only from the site itself")
  assert.equal(html.split("Content-Security-Policy").length, 2)
  assert.ok(!/<[a-z][^>]*\sstyle\s*=/i.test(html), "no inline styles")
  assert.match(html, /<nav class="site-links" aria-label="[^"]*"><a href="download\.html">/, "the header Download link opens the download page")
  assert.match(html, /class="help-search" hidden/)
  assert.ok(!/id="support-development"|github\.com\/sponsors|opencollective\.com|liberapay\.com|polar\.sh|thanks\.dev|paypal\.|buymeacoffee\.com|ko-fi\.com/i.test(html), "no sponsorship section or URL while funding.json does not exist")
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
  assert.equal(ids.length, new Set(ids).size, `duplicate anchors in ${file}`)
  for (const heading of html.matchAll(/<h[2-6]\b([^>]*)>/g)) assert.match(heading[1], /\bid="[a-z0-9]+(?:-[a-z0-9]+)*"/, file)
  for (const other of locales) {
    const url = `${HELP_BASE_URL}${other}/${page === "index" ? "" : `${page}.html`}`
    assert.ok(html.includes(`<link rel="alternate" hreflang="${other}" href="${url}">`), url)
    assert.ok(html.includes(`href="../${other}/${page}.html" hreflang="${other}" lang="${other}"`), "switching language preserves the page")
  }
  assert.ok(html.includes(`hreflang="x-default" href="${HELP_BASE_URL}en/${page === "index" ? "" : `${page}.html`}"`))
  for (const [, attribute, encoded] of html.matchAll(/\b(href|src|poster)="([^"]+)"/g)) {
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
    ["index", "download", "install", "server"], ["projects", "conversations", "history", "files", "permissions", "missions"],
    ["opencode", "providers", "integrations"], ["remote-control", "remote-access", "security", "mobile"],
    ["settings", "shortcuts", "voice"], ["extensions"], ["desktop", "browser-sidecars", "updates"], ["troubleshooting", "support"],
  ], "all approved pages must remain reachable in their eight groups")
  if (onlyLocale) assert.ok(site.locales.includes(onlyLocale), `unsupported locale: ${onlyLocale}`)
  const output = await temporary(ctx)
  const built = await buildHelp({ content, output })
  const problems = built.problems.filter((problem) => !onlyLocale || problem.locale === onlyLocale || problem.locale === "en")
  assert.deepEqual(problems, [], problems.map((problem) => `${problem.locale}/${problem.page}: ${problem.message}`).join("\n"))
  const locales = onlyLocale ? [onlyLocale] : site.locales
  for (const locale of locales) for (const page of built.pages) await checkHtml(output, locale, page, site.locales)
  for (const locale of locales) {
    const html = await readFile(join(output, locale, "index.html"), "utf8")
    checkTour(html, JSON.parse(await readFile(resolve(root, `docs/help/i18n/${locale}.json`), "utf8")))
    const [lead] = html.split(/<h2\b/)
    assert.match(lead, /<p class="action"><a href="download\.html">[^<]+<\/a><\/p>/, `${locale}: the home page leads to the download page before its first section`)
    for (const [id, targets] of [["missions", ["missions"]], ["phone-access", ["remote-control", "mobile"]], ["large-histories", ["history"]]]) {
      const section = html.split(`<h2 id="${id}">`)[1]?.split(/<h2\b/)[0]
      assert.ok(section, `${locale}: home section #${id}`)
      for (const target of targets) assert.ok(section.includes(`href="${target}.html"`), `${locale}: #${id} links to ${target}.html`)
    }
    for (const page of built.pages.filter((name) => name !== "index")) {
      assert.ok(!(await readFile(join(output, locale, `${page}.html`), "utf8")).includes('class="action"'), `${locale}/${page}: only the home page has a call to action`)
    }
  }
  const chooser = await readFile(join(output, "index.html"), "utf8")
  assert.equal((chooser.match(/<script>/g) ?? []).length, 1, "only the root chooser needs JavaScript")
  for (const locale of site.locales) assert.ok(chooser.includes(`href="${locale}/"`), "chooser works with JavaScript disabled")
  const css = await readFile(join(output, "assets/help.css"), "utf8")
  assert.ok(!/@import|https?:\/\//.test(css), "no remote styles or fonts")
  for (const locale of locales) await checkSearch(output, locale)
  ctx.diagnostic(`Validated ${built.pages.length} pages × ${locales.length} locale(s)`)
})

test("the page check rejects extra, duplicate and inline scripts in any letter case or quoting", async (ctx) => {
  const output = await temporary(ctx)
  await buildHelp({ content, output })
  for (const page of ["install", "download"]) {
    const file = join(output, "en", `${page}.html`)
    const original = await readFile(file, "utf8")
    await checkHtml(output, "en", page, LOCALES)
    for (const extra of [
      '<SCRIPT src="../assets/help-download.js"></SCRIPT>',
      '<Script src="../assets/help-download.js" defer></Script>',
      '<SCRIPT SRC="../assets/help-search.js" DEFER></SCRIPT>',
      '<script src="../assets/help-search.js" defer></script>',
      "<script src='../assets/help-download.js' defer></script>",
      '<script\nsrc="../assets/help-download.js" defer></script >',
      "<sCrIpT>alert(1)</sCrIpT>",
    ]) {
      await writeFile(file, original.replace("</head>", `${extra}\n</head>`))
      await assert.rejects(checkHtml(output, "en", page, LOCALES), /only the owned search script/, `${page}: ${extra}`)
    }
    await writeFile(file, original)
  }
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

test("search excerpts separate table cells, list items and paragraphs without splitting inline text", async (ctx) => {
  const { source, output } = await fixture(ctx)
  for (const locale of LOCALES) {
    const file = join(source, locale, "index.md")
    await writeFile(file, (await readFile(file, "utf8")).replace("Text.", "<table><tr><th>Capability</th><th>Local desktop</th><th>Direct browser</th></tr><tr><td>账户</td><td>本地</td><td>远程</td></tr></table><ul><li>First</li><li>Second</li></ul><p>Third</p><p>Fourth<br>Fifth</p><p>in<strong>line</strong> &amp; text</p>"))
  }
  assert.deepEqual((await buildHelp({ content: source, output })).problems, [])
  for (const locale of LOCALES) {
    const entries = JSON.parse(await readFile(join(output, locale, "search-index.json"), "utf8"))
    assert.equal(entries.find(entry => entry.href === "index.html#details").excerpt, "Capability Local desktop Direct browser 账户 本地 远程 First Second Third Fourth Fifth inline & text", locale)
  }
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
  assert.ok(JSON.parse(await readFile(join(output, ".help-output.json"), "utf8")).includes("assets/help-download.js"), "the owned download script is recorded for cleanup")
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
  assert.ok((await readFile(join(output, "assets/help-download.js"), "utf8")).includes("detectDownloadPlatform"), "the rebuild copies the download script again")
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

test("the home tour renders from shared media in every locale, and a lone page link becomes a call to action", async (ctx) => {
  const { source, output } = await fixture(ctx)
  for (const locale of LOCALES) {
    const file = join(source, locale, "index.md")
    await writeFile(file, (await readFile(file, "utf8")).replace("## Start {#start}", "[Start here](install.md)\n\n{{tour-video}}\n\n[Install](install.md) [Support](support.md)\n\nRead [Install](install.md).\n\n[OpenCode](https://opencode.ai/v2/docs/)\n\n## Start {#start}"))
  }
  assert.deepEqual((await buildHelp({ content: source, output })).problems, [])
  assert.deepEqual((await readdir(join(output, "assets/media"))).sort(), ["CodeNomad-Icon.png", "codenomad-tour-poster.jpg", "codenomad-tour.mp4"], "ten translations share one clip and one poster")
  assert.ok(JSON.parse(await readFile(join(output, ".help-output.json"), "utf8")).includes("assets/media/codenomad-tour.mp4"), "the clip is recorded for cleanup")
  for (const locale of LOCALES) {
    await checkHtml(output, locale, "index", LOCALES)
    const html = await readFile(join(output, locale, "index.html"), "utf8")
    checkTour(html, JSON.parse(await readFile(resolve(root, `docs/help/i18n/${locale}.json`), "utf8")))
    // The fixture's closing "[Home](index.md#start)" paragraph is a lone page link too.
    assert.deepEqual(html.match(/<p class="action">.*?<\/p>/g), ['<p class="action"><a href="install.html">Start here</a></p>', '<p class="action"><a href="index.html#start">Home</a></p>'])
  }
})

// Top-level MP4 boxes of [start, end): { type, start, end } with start at the size field.
function mp4Boxes(bytes, start = 0, end = bytes.length) {
  const boxes = []
  for (let offset = start; offset + 8 <= end;) {
    const size = bytes.readUInt32BE(offset)
    assert.ok(size >= 8 && offset + size <= end, "valid MP4 box size")
    boxes.push({ type: bytes.toString("latin1", offset + 4, offset + 8), start: offset, end: offset + size })
    offset += size
  }
  return boxes
}

test("the tour clip is a silent faststart H.264 4:2:0 loop of 40-50 s at 1280x720 within 3.5 MB, and its poster a 1280x720 JPEG within 200 KB", async () => {
  const video = await readFile(resolve(root, "docs/screenshots/codenomad-tour.mp4"))
  assert.ok(video.length <= 3_500_000, `clip is ${video.length} bytes`)
  const boxes = mp4Boxes(video)
  assert.equal(boxes[0].type, "ftyp")
  const moov = boxes.find((box) => box.type === "moov")
  assert.ok(moov && boxes.indexOf(moov) < boxes.findIndex((box) => box.type === "mdat"), "faststart: metadata before media data")
  const tracks = mp4Boxes(video, moov.start + 8, moov.end).filter((box) => box.type === "trak")
  assert.equal(tracks.length, 1, "one track, no audio")
  const trak = video.subarray(tracks[0].start, tracks[0].end)
  const hdlr = trak.indexOf("hdlr")
  assert.equal(trak.toString("latin1", hdlr + 12, hdlr + 16), "vide")
  const tkhd = trak.indexOf("tkhd") + 4
  const dimensions = tkhd + (trak[tkhd] === 1 ? 88 : 76)
  assert.deepEqual([trak.readUInt32BE(dimensions) / 65536, trak.readUInt32BE(dimensions + 4) / 65536], [1280, 720])
  const avcC = trak.indexOf("avcC") + 4
  assert.ok(trak.indexOf("avc1") > 0 && avcC > 4, "H.264")
  assert.ok([66, 77, 100].includes(trak[avcC + 1]), "Baseline, Main or High profile: 4:2:0 chroma")
  const mvhd = video.indexOf("mvhd", moov.start) + 4
  assert.equal(video[mvhd], 0)
  const seconds = video.readUInt32BE(mvhd + 16) / video.readUInt32BE(mvhd + 12)
  assert.ok(seconds >= 40 && seconds <= 50, `clip lasts ${seconds} s`)

  const poster = await readFile(resolve(root, "docs/screenshots/codenomad-tour-poster.jpg"))
  assert.ok(poster.length <= 200_000, `poster is ${poster.length} bytes`)
  assert.equal(poster.readUInt16BE(0), 0xffd8, "JPEG")
  let offset = 2
  while (offset < poster.length && ![0xc0, 0xc1, 0xc2].includes(poster[offset + 1])) offset += 2 + poster.readUInt16BE(offset + 2)
  assert.deepEqual([poster.readUInt16BE(offset + 7), poster.readUInt16BE(offset + 5)], [1280, 720], "poster matches the 16:9 video box")
})

const LATEST_RELEASE = "https://github.com/NeuralNomadsAI/CodeNomad/releases/latest"
const releaseFixture = JSON.parse(await readFile(resolve(root, "scripts/fixtures/help-release.json"), "utf8"))
const downloads = JSON.parse(await readFile(resolve(root, "docs/help/downloads.json"), "utf8"))
const megabytes = (locale, bytes) => new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", maximumFractionDigits: 0 }).format(Math.round(bytes / 1e6))
const chromeFor = async (locale) => JSON.parse(await readFile(resolve(root, `docs/help/i18n/${locale}.json`), "utf8"))

// The install page of the generic fixture gets a release line and one link per downloads.json asset.
async function releaseFixturePages(ctx) {
  const paths = await fixture(ctx)
  const links = downloads.map((entry) => `[${entry.id}](release:${entry.id})`).join(" · ")
  for (const locale of LOCALES) {
    await writeFile(join(paths.source, locale, "install.md"), `# ${locale} install\n\n{{release}}\n\nLead paragraph.\n\n## Desktop {#desktop}\n\n${links}\n`)
  }
  return paths
}

test("release links use resolved asset URLs with localized sizes, and the latest release page without data", async (ctx) => {
  const { source, output } = await releaseFixturePages(ctx)
  assert.deepEqual((await buildHelp({ content: source, output, release: releaseFixture })).problems, [])
  for (const locale of LOCALES) {
    await checkHtml(output, locale, "install", LOCALES)
    const html = await readFile(join(output, locale, "install.html"), "utf8")
    for (const entry of downloads) {
      const asset = releaseFixture.assets[entry.id]
      assert.ok(html.includes(`<a href="${asset.url}">${entry.id}</a> <span class="download-size">${escapeHtml(megabytes(locale, asset.size))}</span>`), `${locale}: ${entry.id}`)
    }
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(releaseFixture.publishedAt))
    const line = escapeHtml((await chromeFor(locale)).release.published).replace("{version}", releaseFixture.version).replace("{date}", escapeHtml(date))
    assert.equal(html.split(`<p class="release-line">${line}</p>`).length, 2, `${locale}: one release line`)
    assert.equal(html.split(escapeHtml(date)).length, 2, `${locale}: the date appears once`)
    assert.ok(html.includes('<meta name="description" content="Lead paragraph.">'), "the generated line never becomes the description")
  }

  assert.deepEqual((await buildHelp({ content: source, output })).problems, [])
  for (const locale of LOCALES) {
    const html = await readFile(join(output, locale, "install.html"), "utf8")
    for (const entry of downloads) assert.ok(html.includes(`<a href="${LATEST_RELEASE}">${entry.id}</a>`), `${locale}: ${entry.id}`)
    assert.ok(!html.includes("download-size") && !html.includes("/releases/download/"), "no asset URL or size without release data")
    assert.ok(html.includes(`<p class="release-line"><a href="${LATEST_RELEASE}">${escapeHtml((await chromeFor(locale)).release.unavailable)}</a></p>`))
  }
})

test("directive and release-link problems are fatal: unknown, misplaced, duplicate and drifting across locales", async (ctx) => {
  const { source, output } = await releaseFixturePages(ctx)
  const file = join(source, "en/install.md"), original = await readFile(file, "utf8")
  for (const [kind, markdown] of [
    ["unknown-release-asset", original.replace("(release:tauri-windows-x64)", "(release:tauri-windows-arm64)")],
    ["unknown-directive", original.replace("Lead paragraph.", "{{funding}}")],
    ["unknown-directive", original.replace("Lead paragraph.", "{{ release }}")],
    ["unknown-directive", original.replace("Lead paragraph.", "Before {{release}}")],
    ["unknown-directive", original.replace("Lead paragraph.", "{{release")],
    ["unknown-directive", `${original}\n- {{release}}\n\n- loose item\n`],
    ["unknown-directive", `${original}\n| Release |\n| - |\n| {{release}} |\n`],
    ["unknown-directive", `${original}\n> {{release}}\n`],
    ["duplicate-directive", `${original}\n{{release}}\n`],
    ["misplaced-directive", original.replace("Lead paragraph.", "{{download-button}}")],
    ["misplaced-directive", original.replace("Lead paragraph.", "{{tour-video}}")],
  ]) {
    await writeFile(file, markdown)
    const { problems } = await buildHelp({ content: source, output })
    assert.ok(problems.some((problem) => problem.kind === kind && problem.locale === "en" && problem.page === "install"), `${kind}: ${markdown}`)
    assert.ok(!TRANSLATION_PROBLEMS.has(kind))
  }
  await writeFile(file, `${original}\nWrite \`{{release}}\` on a line of its own:\n\n\`\`\`md\n{{release}}\n{{anything}}\n\`\`\`\n\n    {{indented}}\n`)
  const french = join(source, "fr/install.md")
  await writeFile(french, `${await readFile(french, "utf8")}\n\`{{release}}\`\n`)
  assert.deepEqual((await buildHelp({ content: source, output })).problems, [], "code samples are never directives")
  await writeFile(file, original)
  await writeFile(french, original.replace("{{release}}\n\n", ""))
  const { problems } = await buildHelp({ content: source, output })
  assert.deepEqual(problems.map(({ kind, locale, page }) => ({ kind, locale, page })), [{ kind: "directive-mismatch", locale: "fr", page: "install" }])
})

test("release data is revalidated: exact repository download URLs, positive sizes, valid tag and UTC date", async (ctx) => {
  const { source, output } = await fixture(ctx)
  const base = "https://github.com/NeuralNomadsAI/CodeNomad/releases/download/v1.0.0/"
  const name = "CodeNomad-Tauri-windows-x64-1.0.0.exe"
  const changed = (change) => { const value = structuredClone(releaseFixture); change(value.assets["tauri-windows-x64"], value); return value }
  const invalid = [
    {}, [], "v1.0.0",
    ...[
      `http://github.com/NeuralNomadsAI/CodeNomad/releases/download/v1.0.0/${name}`,
      `https://github.com.evil.example/NeuralNomadsAI/CodeNomad/releases/download/v1.0.0/${name}`,
      `https://evil.example/github.com/NeuralNomadsAI/CodeNomad/releases/download/v1.0.0/${name}`,
      `https://user:token@github.com/NeuralNomadsAI/CodeNomad/releases/download/v1.0.0/${name}`,
      `https://github.com:443/NeuralNomadsAI/CodeNomad/releases/download/v1.0.0/${name}`,
      `https://GitHub.com/NeuralNomadsAI/CodeNomad/releases/download/v1.0.0/${name}`,
      `https://github.com/neuralnomadsai/codenomad/releases/download/v1.0.0/${name}`,
      `https://github.com/Other/CodeNomad/releases/download/v1.0.0/${name}`,
      `${base}${name}?download=1`, `${base}${name}#asset`, ` ${base}${name}`,
      `${base}../v0.9.0/${name}`, `${base}..%2Fv0.9.0%2F${name}`, `${base}%43odeNomad-Tauri-windows-x64-1.0.0.exe`,
      `https://github.com/NeuralNomadsAI/CodeNomad/releases/download/v1.0.1/${name}`,
      `${base}CodeNomad-Tauri-windows-x64-1.0.1.exe`, `${base}${name}.sig`, `${base}CodeNomad-Electron-windows-x64-1.0.0.zip`,
      `https://objects.githubusercontent.com/NeuralNomadsAI/CodeNomad/releases/download/v1.0.0/${name}`,
      "javascript:alert(1)", 42,
    ].map((url) => changed((asset) => { asset.url = url })),
    ...[0, -1, 1.5, "60272894", Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, null].map((size) => changed((asset) => { asset.size = size })),
    changed((asset) => { asset.name = name }),
    changed((asset, release) => { delete release.assets["electron-linux-x64"] }),
    changed((asset, release) => { release.assets["tauri-linux-arm64"] = { ...asset } }),
    changed((asset, release) => { release.assets["tauri-macos-x64"] = release.assets["tauri-macos-arm64"] }),
    changed((asset, release) => { release.version = "1.0.1" }),
    changed((asset, release) => { release.tag = "1.0.0" }),
    changed((asset, release) => { release.tag = "v1.0.0-beta.1"; release.version = "1.0.0-beta.1" }),
    changed((asset, release) => { release.tag = "v1.0.0<script>" }),
    changed((asset, release) => { release.publishedAt = "2026-02-30T00:00:00Z" }),
    changed((asset, release) => { release.publishedAt = "2026-10-24T13:58:04+02:00" }),
    changed((asset, release) => { release.publishedAt = "yesterday" }),
    changed((asset, release) => { release.publishedAt = Date.parse(releaseFixture.publishedAt) }),
    changed((asset, release) => { release.body = "<script>alert(1)</script>" }),
  ]
  for (const release of invalid) {
    await assert.rejects(buildHelp({ content: source, output, release }), /release data:/, JSON.stringify(release)?.slice(0, 300))
  }
  const valid = validateRelease(releaseFixture, await readDownloads())
  assert.equal(valid.version, "1.0.0")
  assert.equal([...valid.assets.keys()].join(), downloads.map((entry) => entry.id).join(), "the fixture covers every downloads.json asset")
})

test("downloads.json lists the stable assets in display order and rejects unsafe templates", async (ctx) => {
  assert.deepEqual(downloads.map((entry) => entry.id), ["tauri-windows-x64", "tauri-macos-arm64", "tauri-macos-x64", "tauri-linux-x64", "electron-windows-x64", "electron-macos-arm64", "electron-macos-x64", "electron-linux-x64"], "Tauri is the recommended build and comes first")
  const directory = await temporary(ctx)
  const entry = downloads[0]
  for (const manifest of [
    [], {}, [{ ...entry }, { ...entry }], [{ ...entry, extra: 1 }], [{ ...entry, id: "Tauri Windows" }],
    [{ ...entry, platform: "android" }], [{ ...entry, host: "web" }], [{ ...entry, arch: "ia32" }],
    [{ ...entry, template: "CodeNomad.exe" }], [{ ...entry, template: "{version}-{version}.exe" }],
    [{ ...entry, template: "../CodeNomad-{version}.exe" }], [{ ...entry, template: "CodeNomad {version}.exe" }],
    [entry, { ...entry, id: "other" }],
  ]) {
    await writeFile(join(directory, "downloads.json"), JSON.stringify(manifest))
    await assert.rejects(readDownloads(directory), /downloads\.json/, JSON.stringify(manifest))
  }
})

test("the build CLI accepts --release and fails on invalid release data", async (ctx) => {
  const { source, output } = await releaseFixturePages(ctx)
  const run = promisify(execFile)
  const script = resolve(root, "scripts/build-help.mjs")
  await run(process.execPath, [script, output, "--content", source, "--release", resolve(root, "scripts/fixtures/help-release.json")])
  const html = await readFile(join(output, "en/install.html"), "utf8")
  assert.ok(html.includes(`href="${releaseFixture.assets["tauri-linux-x64"].url}"`))
  const broken = join(await temporary(ctx), "release.json")
  await writeFile(broken, JSON.stringify({ ...releaseFixture, tag: "v9.9.9" }))
  await assert.rejects(run(process.execPath, [script, output, "--content", source, "--release", broken]), /release data:/)
})

// Trimmed recordings of the real GitHub release listing: page 1 holds newer dev prereleases
// around v1.0.0, page 2 two older stable releases whose asset names predate downloads.json
// and an early dev build published without the prerelease flag.
const apiPage1 = JSON.parse(await readFile(resolve(root, "scripts/fixtures/help-release-api-page1.json"), "utf8"))
const apiPage2 = JSON.parse(await readFile(resolve(root, "scripts/fixtures/help-release-api-page2.json"), "utf8"))
const recorded = [...apiPage1, ...apiPage2]
const stable100 = apiPage1.find((release) => release.tag_name === "v1.0.0")
// A copy of v1.0.0 as a newer stable release v1.0.1, published a day later.
function release101(change = () => {}) {
  const release = structuredClone(stable100)
  const rename = (value) => value.replaceAll("1.0.0", "1.0.1")
  Object.assign(release, { id: 1, tag_name: "v1.0.1", name: "v1.0.1", published_at: "2026-10-25T13:58:04Z", html_url: rename(release.html_url) })
  for (const asset of release.assets) Object.assign(asset, { name: rename(asset.name), browser_download_url: rename(asset.browser_download_url) })
  change(release, (name) => release.assets.find((asset) => asset.name === name))
  return release
}
// Serves the given pages with GitHub-style Link headers on the numeric repository path.
function fakeGitHub(pages, { status = 200, link = (page) => page < pages.length ? `<https://api.github.com/repositories/1087925615/releases?per_page=100&page=${page + 1}>; rel="next", <https://api.github.com/repositories/1087925615/releases?per_page=100&page=${pages.length}>; rel="last"` : null } = {}) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    const page = calls.length
    const body = pages[page - 1] ?? []
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: link(page) ? { link: link(page) } : {} })
  }
  return { fetch, calls }
}
const ciEnv = { GITHUB_ACTIONS: "true", GH_TOKEN: "test-token" }

test("the release resolver picks the newest complete stable release and ignores drafts, prereleases and other tags", async () => {
  const { release, skipped } = selectRelease(recorded, downloads)
  assert.deepEqual(release, releaseFixture, "the recorded v1.0.0 listing resolves to the builder fixture")
  assert.deepEqual(skipped, [], "newer complete dev prereleases are ignored")
  assert.ok(apiPage1.slice(0, apiPage1.indexOf(stable100)).every((entry) => entry.prerelease), "the recording lists newer prereleases first")
  assert.equal(selectRelease([...recorded, release101()], downloads).release.tag, "v1.0.1", "order follows published_at, not list position")
  assert.ok(apiPage2.some((entry) => entry.tag_name === "v0.2.8-dev" && !entry.prerelease), "the recording keeps an early non-prerelease dev tag")
  for (const hidden of [{ draft: true, published_at: null }, { prerelease: true }, { tag_name: "v1.0.1-dev" }, { tag_name: "1.0.1" }, { tag_name: "v1.0", published_at: "invalid" }]) {
    const result = selectRelease([release101((entry) => Object.assign(entry, hidden)), ...recorded], downloads)
    assert.equal(result.release.tag, "v1.0.0", JSON.stringify(hidden))
    assert.deepEqual(result.skipped, [])
  }
})

test("the release resolver falls back past an incomplete newest release and reports what it lacks", () => {
  const name = "CodeNomad-Tauri-linux-x64-1.0.1.AppImage"
  for (const change of [
    (release) => { release.assets = release.assets.filter((asset) => asset.name !== name) },
    (release, asset) => { asset(name).state = "starter" },
    (release, asset) => { asset(name).size = 0 },
  ]) {
    const { release, skipped } = selectRelease([release101(change), ...recorded], downloads)
    assert.deepEqual(release, releaseFixture)
    assert.deepEqual(skipped, [{ tag: "v1.0.1", missing: [name] }])
  }
  assert.throws(() => selectRelease(apiPage2, downloads), /no stable release has every downloads\.json asset \(incomplete: v0\.20\.1, v0\.20\.0\)/)
  assert.throws(() => selectRelease([...apiPage1.filter((entry) => entry !== stable100), ...apiPage2], downloads), /no stable release/)
  assert.throws(() => selectRelease([], downloads), /no stable release/)
})

test("the release resolver rejects malformed listings, duplicates and unexpected asset URLs", () => {
  const name = "CodeNomad-Tauri-windows-x64-1.0.1.exe"
  const cases = [
    {}, null, "[]",
    [null], [{ ...stable100, tag_name: undefined }], [{ ...stable100, draft: "false" }], [{ ...stable100, prerelease: null }], [{ ...stable100, assets: null }],
    [release101((release) => { release.assets.push(null) })],
    [release101((release, asset) => { asset(name).size = "60272894" })],
    [release101((release, asset) => { asset(name).size = -1 })],
    [release101((release, asset) => { delete asset(name).state })],
    [release101((release, asset) => { delete asset(name).browser_download_url })],
    [release101((release) => { release.published_at = null })],
    [release101((release) => { release.published_at = "2026-02-30T00:00:00Z" })],
    [release101((release) => { release.published_at = "2026-10-25T13:58:04+02:00" })],
    [stable100, structuredClone(stable100)],
    [release101((release, asset) => { release.assets.push(structuredClone(asset(name))) })],
    [release101((release, asset) => { release.assets.push({ ...structuredClone(asset(name)), state: "starter" }) })],
    [release101((release, asset) => { asset(name).browser_download_url = `https://evil.example/NeuralNomadsAI/CodeNomad/releases/download/v1.0.1/${name}` })],
    [release101((release, asset) => { asset(name).browser_download_url = `https://github.com/NeuralNomadsAI/CodeNomad/releases/download/v1.0.0/${name}` })],
  ]
  for (const releases of cases) assert.throws(() => selectRelease(releases, downloads), /GitHub releases:/, JSON.stringify(releases)?.slice(0, 200))
  assert.throws(() => selectRelease(recorded, []), /downloads\.json/)
})

test("the release resolver follows only this repository's pagination links within bounded pages and time", async () => {
  const github = fakeGitHub([apiPage1, apiPage2])
  assert.deepEqual(await fetchReleases({ fetch: github.fetch, token: "test-token" }), recorded)
  assert.deepEqual(github.calls.map((call) => call.url), [
    "https://api.github.com/repos/NeuralNomadsAI/CodeNomad/releases?per_page=100",
    "https://api.github.com/repositories/1087925615/releases?per_page=100&page=2",
  ])
  for (const { init } of github.calls) {
    assert.equal(init.headers.Authorization, "Bearer test-token")
    assert.equal(init.redirect, "error")
    assert.ok(init.signal instanceof AbortSignal, "every request has a timeout")
  }
  assert.equal(nextPage('<https://api.github.com/repos/NeuralNomadsAI/CodeNomad/releases?per_page=100&page=3>; rel="next"'), "https://api.github.com/repos/NeuralNomadsAI/CodeNomad/releases?per_page=100&page=3")
  assert.equal(nextPage('<https://api.github.com/repositories/1/releases?per_page=100&page=3>; rel="last"'), null)
  assert.equal(nextPage(null), null)
  for (const url of [
    "https://evil.example/repositories/1087925615/releases?per_page=100&page=2",
    "http://api.github.com/repositories/1087925615/releases?per_page=100&page=2",
    "https://token@api.github.com/repositories/1087925615/releases?per_page=100&page=2",
    "https://api.github.com:8443/repositories/1087925615/releases?per_page=100&page=2",
    "https://api.github.com/repos/Other/CodeNomad/releases?per_page=100&page=2",
    "https://api.github.com/repositories/1/releases?per_page=100&page=2",
    "https://api.github.com/repositories/10879256150/releases?per_page=100&page=2",
    "https://api.github.com/repositories/1087925615/releases/assets?per_page=100&page=2",
    "https://api.github.com/repositories/1087925615/releases?per_page=100&page=2&redirect=https://evil.example",
    "https://api.github.com/repositories/1087925615/releases?per_page=100&page=2#next",
    "not a url",
  ]) {
    assert.throws(() => nextPage(`<${url}>; rel="next"`), /pagination link/, url)
    const foreign = fakeGitHub([apiPage1, apiPage2], { link: (page) => page === 1 ? `<${url}>; rel="next"` : null })
    await assert.rejects(fetchReleases({ fetch: foreign.fetch, token: "test-token" }), /pagination link/)
    assert.equal(foreign.calls.length, 1, `the token never reaches ${url}`)
  }
  const endless = fakeGitHub(Array(5).fill([]), { link: (page) => `<https://api.github.com/repositories/1087925615/releases?per_page=100&page=${page + 1}>; rel="next"` })
  await assert.rejects(fetchReleases({ fetch: endless.fetch, token: "test-token", maxPages: 3 }), /more than 3 pages/)
  assert.equal(endless.calls.length, 3)
  for (const [github, pattern] of [
    [fakeGitHub([[]], { status: 401 }), /page 1 request failed: HTTP 401/],
    [fakeGitHub([apiPage1, "{"]), /page 2 request failed/],
    [fakeGitHub([{ message: "Not Found" }]), /page 1 is not a list/],
  ]) await assert.rejects(fetchReleases({ fetch: github.fetch, token: "test-token" }), pattern)
  const hanging = (url, init) => new Promise((resolvePromise, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))
  await assert.rejects(fetchReleases({ fetch: hanging, token: "test-token", timeoutMs: 20 }), /page 1 request failed/)
})

test("the resolver CLI runs only in CI with a token, writes validated release data and notices fallbacks", async (ctx) => {
  const directory = await temporary(ctx)
  const output = join(directory, "release.json")
  const logs = []
  const log = (line) => logs.push(line)
  const github = fakeGitHub([[release101((release) => { release.assets = release.assets.filter((asset) => !asset.name.endsWith(".deb")) }), ...apiPage1], apiPage2])
  await resolveRelease({ argv: [output], env: ciEnv, fetch: github.fetch, log })
  const written = JSON.parse(await readFile(output, "utf8"))
  assert.deepEqual(written, releaseFixture)
  validateRelease(written, await readDownloads())
  assert.deepEqual(logs.filter((line) => line.startsWith("::")), ["::notice title=Help release::Download links use v1.0.0: newer stable release v1.0.1 is missing CodeNomad-Electron-linux-x64-1.0.1.deb"])
  const { source, output: site } = await releaseFixturePages(ctx)
  assert.deepEqual((await buildHelp({ content: source, output: site, release: written })).problems, [], "the builder accepts resolved data")

  const none = join(directory, "none.json")
  await assert.rejects(resolveRelease({ argv: [none], env: ciEnv, fetch: fakeGitHub([apiPage2]).fetch, log }), /no stable release/)
  await assert.rejects(readFile(none), "nothing is written without a complete release")
  for (const [env, argv, pattern] of [
    [{ GH_TOKEN: "test-token" }, [output], /only in GitHub Actions/],
    [{ ...ciEnv, GITHUB_ACTIONS: "1" }, [output], /only in GitHub Actions/],
    [{ GITHUB_ACTIONS: "true" }, [output], /GH_TOKEN/],
    [ciEnv, [], /usage/],
    [ciEnv, [output, "extra"], /usage/],
  ]) {
    const unused = fakeGitHub([])
    await assert.rejects(resolveRelease({ argv, env, fetch: unused.fetch, log }), pattern)
    assert.equal(unused.calls.length, 0, "no request before the CI, usage and token checks pass")
  }
  const script = resolve(root, "scripts/resolve-help-release.mjs")
  const failure = await promisify(execFile)(process.execPath, [script, output], { env: { ...process.env, GITHUB_ACTIONS: "", GH_TOKEN: "" } }).catch((error) => error)
  assert.equal(failure.code, 1, "the CLI exits nonzero outside CI")
  assert.match(failure.stdout, /^::error title=Help release::resolve-help-release runs only in GitHub Actions/)
})

test("the help workflow republishes after successful releases and keeps pull requests away from resolution and deployment", async () => {
  const workflow = parseYaml(await readFile(resolve(root, ".github/workflows/help-pages.yml"), "utf8"))
  const release = parseYaml(await readFile(resolve(root, ".github/workflows/release.yml"), "utf8"))
  assert.deepEqual(workflow.on.workflow_run, { workflows: [release.name], types: ["completed"], branches: ["main"] })
  for (const event of ["push", "pull_request"]) {
    for (const path of ["docs/help/**", "scripts/*help*.mjs", "scripts/fixtures/help-*.json", ".github/workflows/help-pages.yml"]) assert.ok(workflow.on[event].paths.includes(path), `${event}: ${path}`)
  }
  assert.deepEqual(workflow.permissions, { "contents": "read" })
  const { build, deploy } = workflow.jobs
  assert.deepEqual(build.permissions, { "contents": "read" })
  const gate = ["github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.head_branch == 'main'", "github.event.workflow_run.head_repository.full_name == github.repository", "github.event.workflow_run.event == 'push'"]
  for (const condition of gate) {
    assert.ok(build.if.includes(condition), `build gate: ${condition}`)
    assert.ok(workflow.concurrency.group.includes(condition), `rejected release events never join the production group: ${condition}`)
  }
  assert.match(workflow.concurrency.group, /'help-pages-production'/)
  assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}")
  assert.equal(deploy.concurrency, undefined, "the workflow-level group already serializes deployment")
  assert.deepEqual(deploy.permissions, { "pages": "write", "id-token": "write" })
  assert.equal(deploy.if, "github.ref == 'refs/heads/dev' && github.event_name != 'pull_request'")
  const checkout = build.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
  assert.equal(checkout.with.ref, "${{ github.event_name == 'workflow_run' && 'dev' || '' }}")
  assert.equal(checkout.with["persist-credentials"], false)
  const text = JSON.stringify(workflow)
  assert.ok(!/head_sha|download-artifact|workflow_run\.id/.test(text), "release events never use the upstream commit or artifacts")
  const resolver = build.steps.filter((step) => step.run?.includes("resolve-help-release"))
  assert.equal(resolver.length, 1)
  assert.equal(resolver[0].if, "github.event_name != 'pull_request'")
  assert.deepEqual(resolver[0].env, { GH_TOKEN: "${{ github.token }}" })
  assert.equal(text.split("github.token").length, 2, "only the resolver step receives the token")
  const builds = build.steps.filter((step) => step.run?.includes("scripts/build-help.mjs"))
  assert.deepEqual(builds.map((step) => [step.if, step.run.includes("--release")]), [["github.event_name != 'pull_request'", true], ["github.event_name == 'pull_request'", false]])
  const order = (predicate) => build.steps.findIndex(predicate)
  assert.ok(order((step) => step.run === "npm run test:help") < order((step) => step === resolver[0]) && order((step) => step === resolver[0]) < order((step) => step === builds[0]))
})

test("help builds and checks never call fetch", () => {
  assert.deepEqual(fetchCalls, [])
})
