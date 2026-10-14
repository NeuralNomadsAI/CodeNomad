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

export async function readChromeStrings(locales, directory = chrome) {
  const strings = {}
  for (const locale of locales) strings[locale] = await readJson(resolve(directory, `i18n/${locale}.json`))
  const expected = ["language", "siteTitle", "brand", "tagline", "onThisPage", "skipToContent", "editPage", "translatePage", "reportProblem", "download", "github", "languageLabel", "projectLinks", "helpTopics", "scope", "findHint", "untranslated", ...SECTION_IDS.map((id) => `sections.${id}`), ...["label", "clear", "empty", "noResults", "failure", "loading", "count"].map((key) => `search.${key}`)].sort().join()
  for (const locale of locales) {
    if (flatKeys(strings[locale]).join() !== expected) throw new Error(`docs/help/i18n/${locale}.json: keys differ from en.json`)
    if (Object.keys(strings[locale].sections).join() !== SECTION_IDS.join()) throw new Error(`docs/help/i18n/${locale}.json: section labels must follow site.json order`)
  }
  return strings
}

function renderMarkdown(markdown, file, media, report) {
  const headings = []
  const links = []
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
      return `<p>${text}</p>\n`
    },
    link(href, linkTitle, text) {
      let target = href
      if (!SCHEME.test(href) && !href.startsWith("//")) {
        const [path, fragment] = href.split("#", 2)
        if (!path) links.push({ page: null, fragment })
        else if (/^(?:\.\/)?[a-z0-9-]+\.md$/.test(path)) {
          const page = path.replace(/^\.\//, "").slice(0, -3)
          links.push({ page, fragment })
          target = `${page}.html${fragment ? `#${fragment}` : ""}`
        } else if (path.startsWith("/")) report("broken-link", `absolute paths do not work on a project site: ${href}`)
        else target = repoLink(path, fragment)
      }
      return `<a href="${escape(target)}"${/^https?:\/\//i.test(stripTags(text)) ? ' dir="ltr"' : ""}${linkTitle ? ` title="${escape(linkTitle)}"` : ""}>${text}</a>`
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
  const html = marked.parse(markdown)
  if (title === null) report("missing-h1", "page has no H1 title")
  return { html: html.replace(/<table>/g, '<div class="table-scroll" tabindex="0"><table>').replace(/<\/table>/g, '</table></div>'), title: title ?? "", description, headings, links }
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'">
  <meta name="description" content="${escape(description)}">
  <meta name="color-scheme" content="light dark">
  <title>${pageTitle}</title>
  <link rel="canonical" href="${pageUrl(locale, page)}">
  ${alternates}
  <link rel="icon" href="../assets/logo.png">
  <link rel="stylesheet" href="../assets/help.css">
  <script src="../assets/help-search.js" defer></script>
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
    <nav class="site-links" aria-label="${escape(t.projectLinks)}"><a href="${repo}/releases/latest">${escape(t.download)}</a><a href="${repo}">${escape(t.github)}</a>${languageMenu(site, strings, locale, (other) => `../${other}/${page}.html`)}</nav>
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
export async function buildHelp({ content = chrome, output = resolve(root, "dist/help") } = {}) {
  const site = await readSite(content)
  const strings = await readChromeStrings(site.locales)
  const problems = []
  const media = new Map()
  const rendered = new Map()
  const pages = site.sections.flatMap((section) => section.pages)
  const render = async (locale, page) => {
    const file = resolve(content, locale, `${page}.md`)
    if (!isFile(file)) return null
    const report = (kind, message) => problems.push({ kind, locale, page, message })
    return renderMarkdown(await readFile(file, "utf8"), file, media, report)
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
      if (!/^(?:[a-zA-Z-]+\/[a-z0-9-]+\.html|assets\/(?:media\/[^/\\]+|help\.css|help-search\.js|logo\.png)|[a-zA-Z-]+\/search-index\.json|index\.html|\.nojekyll)$/.test(name)) throw new Error("invalid help output ownership record")
      const target = resolve(output, name)
      if (isFile(target) && relative(realpathSync(output), realpathSync(target)).startsWith("..")) throw new Error("help output symlink escape")
      await rm(target, { force: true })
    }
  }
  await mkdir(resolve(output, "assets/media"), { recursive: true })
  await Promise.all([
    copyFile(resolve(chrome, "help.css"), resolve(output, "assets/help.css")),
    copyFile(resolve(chrome, "help-search.js"), resolve(output, "assets/help-search.js")),
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
        const section = result.html.split(`id="${heading.id}"`)[1]?.split(/<h[1-6]\b/)[0] ?? ""
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
  await writeFile(ownership, JSON.stringify(["index.html", ".nojekyll", "assets/help.css", "assets/help-search.js", "assets/logo.png", ...[...media.values()].map((name) => `assets/media/${name}`), ...site.locales.flatMap((locale) => [`${locale}/search-index.json`, ...[...available.keys()].map((page) => `${locale}/${page}.html`)])]))
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
  const output = resolve(args[0] ?? resolve(root, "dist/help"))
  const { site, problems, pages } = await buildHelp({ content: content && resolve(content), output })
  for (const problem of problems) {
    const level = TRANSLATION_PROBLEMS.has(problem.kind) ? "warning" : "error"
    console.log(`${level}: ${problem.locale}/${problem.page}: ${problem.message}`)
  }
  console.log(`Built ${pages.length} help pages in ${site.locales.length} languages in ${output}`)
  if (problems.some((problem) => !TRANSLATION_PROBLEMS.has(problem.kind))) process.exitCode = 1
}
