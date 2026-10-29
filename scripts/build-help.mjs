import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Marked } from "marked"
import { HELP_BASE_URL } from "../packages/ui/src/lib/help-url.ts"

export { HELP_BASE_URL }

const root = fileURLToPath(new URL("../", import.meta.url))
const chrome = resolve(root, "docs/help")
const repo = "https://github.com/NeuralNomadsAI/CodeNomad"
export const SECTION_IDS = ["start", "workflows", "opencode-setup", "remote-access", "customize", "extensions", "desktop", "help"]
// Translation gaps still build (English fallback); every other problem is a broken page.
export const TRANSLATION_PROBLEMS = new Set(["missing-translation"])
const RTL_LOCALES = new Set(["he"])
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESERVED_IDS = new Set(["content", "help-query", "help-results"])
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
// Generated blocks, each written as a top-level paragraph of its own: `{{release}}`.
export const DIRECTIVES = new Set(["release", "download-button", "tour-video"])
// Directives restricted to one page; download-button also makes its page load help-download.js.
const DIRECTIVE_PAGES = new Map([["download-button", "download"], ["tour-video", "index"]])
// The home tour: a silent loop that plays only on wide screens without reduced motion; elsewhere
// the poster image replaces it (help.css) and no video is downloaded.
const TOUR_VIDEO = resolve(root, "docs/screenshots/codenomad-tour.mp4")
const TOUR_POSTER = resolve(root, "docs/screenshots/codenomad-tour-poster.jpg")
export const TOUR_MEDIA = "(prefers-reduced-motion: no-preference) and (min-width: 721px)"
export const TOUR_URL = "https://youtu.be/IGuOApJ6-Kc"
// A paragraph holding nothing but one link to another help page is a call to action.
const ACTION = /^<a href="[a-z0-9-]+\.html(?:#[a-z0-9-]+)?">[^<]+<\/a>$/
const DIRECTIVE = /^\{\{([a-z0-9-]+)\}\}$/
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/
const RELEASE_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const ASSET_NAME = /^[A-Za-z0-9._-]+$/
const LATEST_RELEASE = `${repo}/releases/latest`

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
const stripTags = (html) => html.replace(/<\/(?:p|div|h[1-6]|li|ul|ol|td|th|tr|table|blockquote|pre)\b[^>]*>|<(?:br|hr)\b[^>]*>/gi, " ").replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#39|#\d+|#x[\da-f]+);/gi, (entity) => {
  const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" }[entity.toLowerCase()]
  if (named) return named
  const code = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1))
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�"
}).replace(/\s+/g, " ").trim()
// Chrome strings are plain text; placeholders receive trusted HTML.
const format = (template, values = {}) => escape(template).replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match)
const isFile = (path) => { try { return statSync(path).isFile() } catch { return false } }
const pathExists = (path) => { try { return statSync(path) } catch { return null } }
const pageUrl = (locale, page) => `${HELP_BASE_URL}${locale}/${page === "index" ? "" : `${page}.html`}`
const insideRepo = (path) => { const name = relative(realpathSync(root), realpathSync(path)); return !name.startsWith(`..${sep}`) && name !== ".." && !isAbsolute(name) }
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const exactKeys = (value, keys) => plainObject(value) && Object.keys(value).sort().join() === keys
// Decimal megabytes and UTC calendar dates, formatted for the page locale at build time.
const formatSize = (locale, bytes) => new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", maximumFractionDigits: 0 }).format(Math.round(bytes / 1e6))
const formatDate = (locale, date) => new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(date)

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"))
}

export async function readSite(content) {
  const site = await readJson(resolve(content, "site.json"))
  const locales = site.locales
  if (!Array.isArray(locales) || locales[0] !== "en" || new Set(locales).size !== locales.length) {
    throw new Error("site.json: locales must be unique and start with en")
  }
  if (locales.some((locale) => !["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"].includes(locale))) throw new Error("site.json: unsupported locale")
  const ids = (site.sections ?? []).map((section) => section.id)
  if (ids.join() !== SECTION_IDS.join()) throw new Error(`site.json: sections must be ${SECTION_IDS.join(", ")}`)
  const pages = site.sections.flatMap((section) => section.pages)
  if (pages[0] !== "index") throw new Error("site.json: the start section must begin with index")
  for (const page of pages) {
    if (!ID_PATTERN.test(page)) throw new Error(`site.json: invalid page name ${page}`)
  }
  if (new Set(pages).size !== pages.length) throw new Error("site.json: a page is listed twice")
  return site
}

function flatKeys(value, prefix = "") {
  return Object.entries(value).flatMap(([key, entry]) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) return flatKeys(entry, `${prefix}${key}.`)
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`empty or non-string chrome value: ${prefix}${key}`)
    return [`${prefix}${key}`]
  }).sort()
}

const DOWNLOAD_KEYS = ["label", "windows", "windowsDetail", "macos", "macosDetail", "intel", "linux", "linuxDetail", "mobile", "mobileDetail"]

export async function readChromeStrings(locales, directory = chrome) {
  const strings = {}
  for (const locale of locales) strings[locale] = await readJson(resolve(directory, `i18n/${locale}.json`))
  const expected = ["language", "siteTitle", "brand", "tagline", "onThisPage", "skipToContent", "editPage", "translatePage", "reportProblem", "github", ...DOWNLOAD_KEYS.map((key) => `download.${key}`), "languageLabel", "projectLinks", "helpTopics", "scope", "findHint", "untranslated", ...SECTION_IDS.map((id) => `sections.${id}`), ...["label", "clear", "empty", "noResults", "failure", "loading", "count"].map((key) => `search.${key}`), ...["published", "unavailable"].map((key) => `release.${key}`), ...["label", "poster", "caption"].map((key) => `tour.${key}`)].sort().join()
  for (const locale of locales) {
    if (flatKeys(strings[locale]).join() !== expected) throw new Error(`docs/help/i18n/${locale}.json: keys differ from en.json`)
    if (Object.keys(strings[locale].sections).join() !== SECTION_IDS.join()) throw new Error(`docs/help/i18n/${locale}.json: section labels must follow site.json order`)
  }
  return strings
}

/** Expected stable release assets in display order; `{version}` is the release tag without its leading v. */
export async function readDownloads(directory = chrome) {
  const downloads = await readJson(resolve(directory, "downloads.json"))
  if (!Array.isArray(downloads) || !downloads.length) throw new Error("downloads.json: expected a non-empty list")
  const ids = new Set()
  const templates = new Set()
  for (const entry of downloads) {
    if (!exactKeys(entry, "arch,host,id,platform,template")) throw new Error("downloads.json: each entry needs exactly id, platform, host, arch and template")
    if (!ID_PATTERN.test(entry.id) || ids.has(entry.id)) throw new Error(`downloads.json: invalid or duplicate id ${entry.id}`)
    if (!["windows", "macos", "linux"].includes(entry.platform) || !["tauri", "electron"].includes(entry.host) || !["x64", "arm64"].includes(entry.arch)) throw new Error(`downloads.json: unsupported platform, host or arch for ${entry.id}`)
    if (typeof entry.template !== "string" || entry.template.split("{version}").length !== 2 || !ASSET_NAME.test(entry.template.replace("{version}", "0")) || templates.has(entry.template)) throw new Error(`downloads.json: ${entry.id} needs a unique asset name with one {version}`)
    ids.add(entry.id)
    templates.add(entry.template)
  }
  return downloads
}

/**
 * Revalidates resolved release data before anything reaches a page: every downloads.json asset
 * must be the exact NeuralNomadsAI/CodeNomad download URL for this tag with a positive size.
 */
export function validateRelease(release, downloads) {
  const fail = (message) => { throw new Error(`release data: ${message}`) }
  if (!exactKeys(release, "assets,publishedAt,tag,version")) fail("expected exactly tag, version, publishedAt and assets")
  const version = typeof release.tag === "string" ? RELEASE_TAG.exec(release.tag)?.[1] : undefined
  if (!version || release.version !== version) fail("tag must be vMAJOR.MINOR.PATCH and version the tag without its v")
  const published = typeof release.publishedAt === "string" && RELEASE_DATE.test(release.publishedAt) ? new Date(release.publishedAt) : null
  if (!published || Number.isNaN(published.getTime()) || published.toISOString().slice(0, 19) !== release.publishedAt.slice(0, 19)) fail("publishedAt must be a valid UTC timestamp")
  if (!exactKeys(release.assets, downloads.map((entry) => entry.id).sort().join())) fail("assets must list exactly the downloads.json ids")
  const assets = new Map()
  for (const entry of downloads) {
    const asset = release.assets[entry.id]
    const url = `${repo}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(entry.template.replace("{version}", version))}`
    if (!exactKeys(asset, "size,url")) fail(`${entry.id} needs exactly url and size`)
    if (asset.url !== url) fail(`${entry.id} must be ${url}`)
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) fail(`${entry.id} size must be a positive integer`)
    assets.set(entry.id, { url, size: asset.size })
  }
  return { version, published, assets }
}

function renderMarkdown(markdown, file, media, report, { locale, page, strings, release, downloads }) {
  const downloadIds = new Set(downloads.map((entry) => entry.id))
  const headings = []
  const links = []
  const directives = []
  let title = null
  let description = ""
  const repoLink = (path, fragment) => {
    const target = resolve(dirname(file), decodeURIComponent(path))
    const found = pathExists(target)
    const inRepo = found ? relative(realpathSync(root), realpathSync(target)) : ""
    if (!found || !insideRepo(target)) {
      report("broken-link", `${path} does not resolve to a repository file`)
      return path
    }
    return `${repo}/${found.isDirectory() ? "tree" : "blob"}/dev/${inRepo.split(sep).join("/")}${fragment ? `#${fragment}` : ""}`
  }
  const marked = new Marked({ renderer: {
    heading(text, level, raw) {
      const id = /\{#([^}]*)\}\s*$/.exec(raw)?.[1]
      const html = text.replace(/\s*\{#[^}]*\}\s*$/, "")
      if (level === 1) {
        if (title !== null) report("extra-h1", `second H1: ${raw}`)
        if (id) report("h1-id", "H1 is the page title and must not carry an explicit id; use ## for linkable sections")
        title ??= stripTags(html)
        return `<h1>${html}</h1>\n`
      }
      if (!id) {
        report("missing-id", `heading without an explicit {#id}: ${raw}`)
        return `<h${level}>${html}</h${level}>\n`
      }
      if (!ID_PATTERN.test(id)) report("invalid-id", `heading id must be ASCII kebab-case: ${id}`)
      else if (RESERVED_IDS.has(id)) report("reserved-id", `heading id is reserved by the site chrome: ${id}`)
      else if (headings.some((heading) => heading.id === id)) report("duplicate-id", `duplicate heading id: ${id}`)
      headings.push({ level, id, text: stripTags(html) })
      return `<h${level} id="${escape(id)}">${html}</h${level}>\n`
    },
    paragraph(text) {
      description ||= stripTags(text)
      return `<p${ACTION.test(text) ? ' class="action"' : ""}>${text}</p>\n`
    },
    link(href, linkTitle, text) {
      let target = href
      let suffix = ""
      if (href.startsWith("release:")) {
        // Without resolved release data (local and pull-request builds) every asset opens the latest release.
        const id = href.slice("release:".length)
        const asset = release?.assets.get(id)
        if (!downloadIds.has(id)) report("unknown-release-asset", `${href} is not listed in docs/help/downloads.json`)
        target = asset?.url ?? LATEST_RELEASE
        if (asset) suffix = ` <span class="download-size">${escape(formatSize(locale, asset.size))}</span>`
      } else if (!SCHEME.test(href) && !href.startsWith("//")) {
        const [path, fragment] = href.split("#", 2)
        if (!path) links.push({ page: null, fragment })
        else if (/^(?:\.\/)?[a-z0-9-]+\.md$/.test(path)) {
          const page = path.replace(/^\.\//, "").slice(0, -3)
          links.push({ page, fragment })
          target = `${page}.html${fragment ? `#${fragment}` : ""}`
        } else if (path.startsWith("/")) report("broken-link", `absolute paths do not work on a project site: ${href}`)
        else target = repoLink(path, fragment)
      }
      return `<a href="${escape(target)}"${/^https?:\/\//i.test(stripTags(text)) ? ' dir="ltr"' : ""}${linkTitle ? ` title="${escape(linkTitle)}"` : ""}>${text}</a>${suffix}`
    },
    image(href, imageTitle, text) {
      let src = href
      if (SCHEME.test(href) || href.startsWith("/")) report("remote-image", `images must be repository files: ${href}`)
      else {
        const path = resolve(dirname(file), decodeURIComponent(href))
        if (!isFile(path) || !insideRepo(path)) report("missing-image", `repository image not found: ${href}`)
        else src = `../assets/media/${mediaName(media, realpathSync(path))}`
      }
      return `<img src="${escape(src)}" alt="${escape(text)}"${imageTitle ? ` title="${escape(imageTitle)}"` : ""}>`
    },
  } })
  // One hidden block per detected platform, each with its final label and target; help-download.js
  // reveals at most one. Without release data every desktop target is the latest release page.
  const downloadButton = () => {
    const t = strings.download
    const tauri = (platform, arch) => {
      const entry = downloads.find((candidate) => candidate.host === "tauri" && candidate.platform === platform && candidate.arch === arch)
      if (!entry) report("unknown-release-asset", `{{download-button}} needs a Tauri ${platform} ${arch} entry in docs/help/downloads.json`)
      return release?.assets.get(entry?.id)
    }
    const detail = (text, asset) => `<p>${escape(text)}${asset ? ` · <span class="download-size">${escape(formatSize(locale, asset.size))}</span>` : ""}</p>`
    const block = (os, href, label, lines) => `<div data-download-os="${os}" hidden><a class="download-main" href="${escape(href)}">${escape(label)}</a>${lines.join("")}</div>`
    const desktop = (os, platform, arch, label, text, extra = "") => {
      const asset = tauri(platform, arch)
      return block(os, asset?.url ?? LATEST_RELEASE, label, [detail(text, asset), extra])
    }
    const intel = tauri("macos", "x64")
    return `<div class="download-primary" hidden>${[
      desktop("windows", "windows", "x64", t.windows, t.windowsDetail),
      desktop("macos", "macos", "arm64", t.macos, t.macosDetail, `<p><a href="${escape(intel?.url ?? LATEST_RELEASE)}">${escape(t.intel)}</a></p>`),
      desktop("linux", "linux", "x64", t.linux, t.linuxDetail),
      block("mobile", "mobile.html", t.mobile, [detail(t.mobileDetail)]),
    ].join("")}</div>\n`
  }
  // The poster doubles as an image for narrow screens, reduced motion and print, where the
  // source's media condition fails, so no player without a video is ever shown.
  const tourVideo = () => {
    const asset = (path) => {
      if (isFile(path)) return `../assets/media/${mediaName(media, realpathSync(path))}`
      report("missing-image", `tour media not found: ${relative(root, path)}`)
      return ""
    }
    const video = asset(TOUR_VIDEO), poster = asset(TOUR_POSTER)
    const t = strings.tour
    return `<figure class="tour"><video autoplay muted loop playsinline controls preload="metadata" width="1280" height="720" poster="${poster}" aria-label="${escape(t.label)}"><source src="${video}" type="video/mp4" media="${TOUR_MEDIA}"></video><img src="${poster}" alt="${escape(t.poster)}" width="1280" height="720"><figcaption><a href="${TOUR_URL}">${escape(t.caption)}</a></figcaption></figure>\n`
  }
  const generate = {
    release: () => release
      ? `<p class="release-line">${format(strings.release.published, { version: escape(release.version), date: escape(formatDate(locale, release.published)) })}</p>\n`
      : `<p class="release-line"><a href="${LATEST_RELEASE}">${escape(strings.release.unavailable)}</a></p>\n`,
    "download-button": downloadButton,
    "tour-video": tourVideo,
  }
  // Directives are replaced at token level so list items, cells and quotes never qualify and the
  // generated block never becomes the meta description; any remaining {{ in rendered text is a problem.
  const tokens = marked.lexer(markdown)
  for (const [index, token] of tokens.entries()) {
    const name = token.type === "paragraph" ? DIRECTIVE.exec(token.text.trim())?.[1] : undefined
    if (!DIRECTIVES.has(name)) continue
    if (directives.includes(name)) report("duplicate-directive", `{{${name}}} appears more than once`)
    if (DIRECTIVE_PAGES.has(name) && DIRECTIVE_PAGES.get(name) !== page) report("misplaced-directive", `{{${name}}} belongs only on ${DIRECTIVE_PAGES.get(name)}.md`)
    directives.push(name)
    tokens[index] = { type: "html", block: true, pre: false, raw: token.raw, text: generate[name]() }
  }
  const html = marked.parser(tokens)
  for (const [match] of html.replace(/<pre\b[\s\S]*?<\/pre>|<code\b[\s\S]*?<\/code>/gi, "").matchAll(/\{\{[^{}<]*(?:\}\})?/g)) {
    report("unknown-directive", `${match} is not a known directive on a paragraph of its own`)
  }
  if (title === null) report("missing-h1", "page has no H1 title")
  return { html: html.replace(/<table>/g, '<div class="table-scroll" tabindex="0"><table>').replace(/<\/table>/g, '</table></div>'), title: title ?? "", description, headings, links, directives }
}

// Shared screenshots are copied once; distinct files with the same name get a suffix.
function mediaName(media, path) {
  if (media.has(path)) return media.get(path)
  const extension = extname(path)
  const stem = basename(path, extension)
  const taken = new Set(media.values())
  let name = `${stem}${extension}`
  for (let count = 2; taken.has(name); count++) name = `${stem}-${count}${extension}`
  media.set(path, name)
  return name
}

function languageMenu(site, strings, locale, href) {
  const items = site.locales.map((other) => `<li><a href="${href(other)}" hreflang="${other}" lang="${other}"${RTL_LOCALES.has(other) ? ' dir="rtl"' : ""}${other === locale ? ' aria-current="true"' : ""}>${escape(strings[other].language)}</a></li>`).join("")
  return `<details class="language-menu"><summary><svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path fill="none" stroke="currentColor" d="M8 .5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM.5 8h15M8 .5c-2 2-3 4.5-3 7.5s1 5.5 3 7.5c2-2 3-4.5 3-7.5S10 2.5 8 .5Z"/></svg><span class="visually-hidden">${escape(strings[locale].languageLabel)}: </span>${escape(strings[locale].language)}</summary><ul>${items}</ul></details>`
}

function pageDocument({ site, strings, locale, page, rendered, fallback, available }) {
  const t = strings[locale]
  const rtl = RTL_LOCALES.has(locale)
   const pageTitle = rendered.title === t.siteTitle ? escape(t.siteTitle) : `${escape(rendered.title)} - ${escape(t.siteTitle)}`
  const description = rendered.description.length > 160 ? `${rendered.description.slice(0, 157).replace(/\s+\S*$|&[^;\s]*$/, "")}...` : rendered.description
  const alternates = [...site.locales.map((other) => [other, other]), ["x-default", "en"]]
    .map(([hreflang, other]) => `<link rel="alternate" hreflang="${hreflang}" href="${pageUrl(other, page)}">`).join("\n  ")
  const nav = site.sections.map((section) => {
    const pages = section.pages.filter((name) => available.has(name))
    if (!pages.length) return ""
    const items = pages.map((name) => `<li><a href="${name}.html"${name === page ? ' aria-current="page"' : ""}>${escape(available.get(name))}</a></li>`).join("")
    return `<p class="nav-section">${escape(t.sections[section.id])}</p><ul>${items}</ul>`
  }).join("")
  const outline = rendered.headings.filter((heading) => heading.level === 2)
    .map((heading) => `<li><a href="#${heading.id}">${escape(heading.text)}</a></li>`).join("")
  const source = fallback ? `${repo}/new/dev/docs/help/${locale}?filename=${page}.md` : `${repo}/edit/dev/docs/help/${locale}/${page}.md`
  const keys = '<span dir="ltr"><kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>F</kbd></span>'
  return `<!doctype html>
<html lang="${locale}" dir="${rtl ? "rtl" : "ltr"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'">
  <meta name="description" content="${escape(description)}">
  <meta name="color-scheme" content="light dark">
  <title>${pageTitle}</title>
  <link rel="canonical" href="${pageUrl(locale, page)}">
  ${alternates}
  <link rel="icon" href="../assets/logo.png">
  <link rel="stylesheet" href="../assets/help.css">
  <script src="../assets/help-search.js" defer></script>${rendered.directives.includes("download-button") ? `\n  <script src="../assets/help-download.js" defer></script>` : ""}
</head>
<body>
  <a class="skip-link" href="#content">${escape(t.skipToContent)}</a>
  <header class="site-header">
    <a class="brand" href="index.html"><img src="../assets/logo.png" alt="" width="36" height="36">CodeNomad <span>${escape(t.brand)}</span></a>
    <div class="help-search" hidden data-strings="${escape(JSON.stringify(t.search))}">
      <label for="help-query">${escape(t.search.label)}</label>
      <div class="search-controls"><input id="help-query" type="search" autocomplete="off" aria-controls="help-results"><button type="button">${escape(t.search.clear)}</button></div>
      <div class="search-results" hidden><p class="search-status" role="status" aria-live="polite"></p><ul id="help-results"></ul></div>
    </div>
    <nav class="site-links" aria-label="${escape(t.projectLinks)}"><a href="download.html">${escape(t.download.label)}</a><a href="${repo}">${escape(t.github)}</a>${languageMenu(site, strings, locale, (other) => `../${other}/${page}.html`)}</nav>
  </header>
  <div class="layout">
    <aside class="sidebar">
      <nav class="topics-wide" aria-label="${escape(t.helpTopics)}">${nav}</nav>
      <details class="topics"><summary>${escape(t.helpTopics)}</summary><nav aria-label="${escape(t.helpTopics)}">${nav}</nav></details>
      <p class="scope">${escape(t.scope)}</p>
    </aside>
    <main id="content" tabindex="-1">
      ${fallback ? `<p class="translation-notice" role="note">${escape(t.untranslated)}</p>` : ""}
      <article${fallback ? ` lang="en" dir="ltr"` : ""}>${rendered.html}</article>
      <footer><a href="${source}">${escape(fallback ? t.translatePage : t.editPage)}</a><a href="${repo}/issues/new/choose">${escape(t.reportProblem)}</a></footer>
    </main>
    <aside class="outline">${outline ? `<nav class="outline-wide" aria-label="${escape(t.onThisPage)}"><strong>${escape(t.onThisPage)}</strong><ul>${outline}</ul></nav><details><summary>${escape(t.onThisPage)}</summary><ul>${outline}</ul></details>` : ""}<p>${format(t.findHint, { keys })}</p></aside>
  </div>
</body>
</html>
`
}

export function languageRedirectScript(locales) {
  const known = Object.fromEntries(locales.map((locale) => [locale.toLowerCase(), locale]))
  return `(()=>{const k=${JSON.stringify(known)};const m=(t)=>{if(typeof t!=="string"||!/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(t))return; t=t.toLowerCase().replace(/_/g,"-");const b=t.split("-")[0];return k[t]||(b==="zh"?k["zh-hans"]:b==="iw"?k.he:k[b])};for(const t of navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language]){const l=m(t);if(l){location.replace(l+"/");return}}location.replace("en/")})()`
}

function chooserDocument(site, strings) {
  const script = languageRedirectScript(site.locales)
  const hash = createHash("sha256").update(script).digest("base64")
  const alternates = [...site.locales.map((locale) => [locale, `${HELP_BASE_URL}${locale}/`]), ["x-default", HELP_BASE_URL]]
    .map(([hreflang, href]) => `<link rel="alternate" hreflang="${hreflang}" href="${href}">`).join("\n  ")
  const items = site.locales.map((locale) => `<li><a href="${locale}/" hreflang="${locale}" lang="${locale}"${RTL_LOCALES.has(locale) ? ' dir="rtl"' : ""}><strong>${escape(strings[locale].language)}</strong><span>${escape(strings[locale].siteTitle)}</span></a></li>`).join("\n      ")
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'">
  <meta name="description" content="${escape(strings.en.tagline)}">
  <meta name="color-scheme" content="light dark">
  <title>${escape(strings.en.siteTitle)}</title>
  ${alternates}
  <link rel="icon" href="assets/logo.png">
  <link rel="stylesheet" href="assets/help.css">
  <script>${script}</script>
</head>
<body class="chooser">
  <main id="content">
    <h1><img src="assets/logo.png" alt="" width="48" height="48">${escape(strings.en.siteTitle)}</h1>
    <p>${escape(strings.en.tagline)}</p>
    <ul class="language-list" aria-label="${escape(strings.en.languageLabel)}">
      ${items}
    </ul>
  </main>
</body>
</html>
`
}

/**
 * Builds every locale listed in site.json. Pages missing from a locale fall back to English.
 * Returns problems instead of throwing so callers decide which kinds are fatal.
 */
export async function buildHelp({ content = chrome, output = resolve(root, "dist/help"), release } = {}) {
  const site = await readSite(content)
  const strings = await readChromeStrings(site.locales)
  const downloads = await readDownloads()
  const releaseData = release == null ? null : validateRelease(release, downloads)
  const problems = []
  const media = new Map()
  const rendered = new Map()
  const pages = site.sections.flatMap((section) => section.pages)
  const render = async (locale, page) => {
    const file = resolve(content, locale, `${page}.md`)
    if (!isFile(file)) return null
    const report = (kind, message) => problems.push({ kind, locale, page, message })
    return renderMarkdown(await readFile(file, "utf8"), file, media, report, { locale, page, strings: strings[locale], release: releaseData, downloads })
  }

  for (const page of pages) {
    const english = await render("en", page)
    if (!english) {
      problems.push({ kind: "missing-page", locale: "en", page, message: `docs/help/en/${page}.md is missing` })
      continue
    }
    rendered.set(`en/${page}`, { ...english, fallback: false })
    for (const locale of site.locales.slice(1)) {
      const translated = await render(locale, page)
      if (!translated) {
        problems.push({ kind: "missing-translation", locale, page, message: `docs/help/${locale}/${page}.md is missing; English is shown` })
        rendered.set(`${locale}/${page}`, { ...english, fallback: true })
        continue
      }
      const ids = (result) => result.headings.map((heading) => `${heading.level}:${heading.id}`).join(" ")
      if (ids(translated) !== ids(english)) {
        problems.push({ kind: "heading-mismatch", locale, page, message: `heading ids differ from English\n  en: ${ids(english)}\n  ${locale}: ${ids(translated)}` })
      }
      const names = (result) => [...result.directives].sort().join(" ")
      if (names(translated) !== names(english)) {
        problems.push({ kind: "directive-mismatch", locale, page, message: `directives differ from English\n  en: ${names(english)}\n  ${locale}: ${names(translated)}` })
      }
      rendered.set(`${locale}/${page}`, { ...translated, fallback: false })
    }
  }

  const available = new Map(pages.filter((page) => rendered.has(`en/${page}`)).map((page) => [page, rendered.get(`en/${page}`).title]))
  for (const locale of site.locales) {
    for (const page of available.keys()) {
      const result = rendered.get(`${locale}/${page}`)
      if (result.fallback) continue
      for (const link of result.links) {
        const target = link.page ?? page
        const label = `${link.page ? `${link.page}.md` : ""}${link.fragment ? `#${link.fragment}` : ""}`
        if (!available.has(target)) problems.push({ kind: "broken-link", locale, page, message: `unknown page: ${label}` })
        else if (link.fragment && !rendered.get(`${locale}/${target}`).headings.some((heading) => heading.id === link.fragment)) {
          problems.push({ kind: "broken-anchor", locale, page, message: `unknown anchor: ${label}` })
        }
      }
    }
  }

  // Only delete files listed by our prior build, never the supplied output directory.
  const ownership = resolve(output, ".help-output.json")
  if (isFile(ownership)) {
    for (const name of await readJson(ownership)) {
      if (!/^(?:[a-zA-Z-]+\/[a-z0-9-]+\.html|assets\/(?:media\/[^/\\]+|help\.css|help-(?:search|download)\.js|logo\.png)|[a-zA-Z-]+\/search-index\.json|index\.html|\.nojekyll)$/.test(name)) throw new Error("invalid help output ownership record")
      const target = resolve(output, name)
      if (isFile(target) && relative(realpathSync(output), realpathSync(target)).startsWith("..")) throw new Error("help output symlink escape")
      await rm(target, { force: true })
    }
  }
  await mkdir(resolve(output, "assets/media"), { recursive: true })
  await Promise.all([
    copyFile(resolve(chrome, "help.css"), resolve(output, "assets/help.css")),
    copyFile(resolve(chrome, "help-search.js"), resolve(output, "assets/help-search.js")),
    copyFile(resolve(chrome, "help-download.js"), resolve(output, "assets/help-download.js")),
    copyFile(resolve(root, "images/CodeNomad-Icon.png"), resolve(output, "assets/logo.png")),
    ...[...media].map(([path, name]) => copyFile(path, resolve(output, "assets/media", name))),
    writeFile(resolve(output, ".nojekyll"), ""),
    writeFile(resolve(output, "index.html"), chooserDocument(site, strings)),
  ])
  for (const locale of site.locales) {
    await mkdir(resolve(output, locale), { recursive: true })
    const index = [...available.keys()].flatMap((page) => {
      const result = rendered.get(`${locale}/${page}`)
      return result.headings.map((heading) => {
        // Hidden per-platform download blocks would repeat every label in the excerpt.
        const section = result.html.split(`id="${heading.id}"`)[1]?.split(/<h[1-6]\b/)[0].replace(/<div class="download-primary" hidden>[\s\S]*?<\/div><\/div>/, "") ?? ""
        return { title: result.title, heading: heading.text, excerpt: stripTags(section.slice(section.indexOf("</h") + 5)).slice(0, 240), href: `${page}.html#${heading.id}` }
      })
    })
    await writeFile(resolve(output, locale, "search-index.json"), JSON.stringify(index))
    const labels = new Map([...available.keys()].map((page) => [page, rendered.get(`${locale}/${page}`).title]))
    for (const page of available.keys()) {
      const result = rendered.get(`${locale}/${page}`)
      const html = pageDocument({ site, strings, locale, page, rendered: result, fallback: result.fallback, available: labels })
      await writeFile(resolve(output, locale, `${page}.html`), html)
    }
  }
  await writeFile(ownership, JSON.stringify(["index.html", ".nojekyll", "assets/help.css", "assets/help-search.js", "assets/help-download.js", "assets/logo.png", ...[...media.values()].map((name) => `assets/media/${name}`), ...site.locales.flatMap((locale) => [`${locale}/search-index.json`, ...[...available.keys()].map((page) => `${locale}/${page}.html`)])]))
  return { site, problems, pages: [...available.keys()] }
}

function option(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const [value] = args.splice(index, 2).slice(1)
  if (!value) throw new Error(`${name} needs a value`)
  return value
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2)
  const content = option(args, "--content")
  const releaseFile = option(args, "--release")
  const output = resolve(args[0] ?? resolve(root, "dist/help"))
  const release = releaseFile ? await readJson(resolve(releaseFile)) : undefined
  const { site, problems, pages } = await buildHelp({ content: content && resolve(content), output, release })
  for (const problem of problems) {
    const level = TRANSLATION_PROBLEMS.has(problem.kind) ? "warning" : "error"
    console.log(`${level}: ${problem.locale}/${problem.page}: ${problem.message}`)
  }
  console.log(`Built ${pages.length} help pages in ${site.locales.length} languages in ${output}`)
  if (problems.some((problem) => !TRANSLATION_PROBLEMS.has(problem.kind))) process.exitCode = 1
}
