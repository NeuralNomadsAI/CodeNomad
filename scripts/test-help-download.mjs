// Download page and OS-detecting button checks, run by scripts/test-help.mjs (npm run test:help).
// They build the repository's real help sources, independent of --content.
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { buildHelp, TRANSLATION_PROBLEMS } from "./build-help.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const script = await readFile(resolve(root, "docs/help/help-download.js"), "utf8")
const release = JSON.parse(await readFile(resolve(root, "scripts/fixtures/help-release.json"), "utf8"))
const LATEST_RELEASE = "https://github.com/NeuralNomadsAI/CodeNomad/releases/latest"
const unescape = (value) => value.replace(/&(?:amp|quot|#39|lt|gt);/g, (entity) => ({ "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" })[entity])
const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
const PRIMARY = /<div class="download-primary" hidden>([\s\S]*?<\/div>)<\/div>/

async function buildSite(ctx, options = {}) {
  const temporaryRoot = process.platform === "win32" ? join(tmpdir(), "opencode") : tmpdir()
  await mkdir(temporaryRoot, { recursive: true })
  const output = await mkdtemp(join(temporaryRoot, "codenomad-help-download-"))
  ctx.after(() => rm(output, { recursive: true, force: true }))
  const built = await buildHelp({ content: resolve(root, "docs/help"), output, ...options })
  // The site-wide check in test-help.mjs covers every other page and locale.
  assert.deepEqual(built.problems.filter((problem) => problem.page === "download" && !TRANSLATION_PROBLEMS.has(problem.kind)), [])
  return { output, site: built.site }
}

// A minimal DOM for the server-rendered block: elements expose only what the script may use.
function fakeDocument(html) {
  const block = PRIMARY.exec(html)
  assert.ok(block, "the download page renders the hidden primary block")
  const choices = [...block[1].matchAll(/<div data-download-os="([a-z]+)" hidden>([\s\S]*?)<\/div>/g)].map(([, os, inner]) => {
    const links = [...inner.matchAll(/<a( class="download-main")? href="([^"]*)">([^<]*)<\/a>/g)].map(([, main, href, text]) => ({
      main: Boolean(main), href: unescape(href), textContent: unescape(text), getAttribute: (name) => name === "href" ? unescape(href) : null,
    }))
    return { os, hidden: true, links, text: unescape(inner.replace(/<[^>]*>/g, " ")), querySelector: (selector) => selector === "a.download-main" ? links.find((link) => link.main) ?? null : null }
  })
  const host = { hidden: true, choices, querySelector: (selector) => choices.find((choice) => selector === `[data-download-os="${choice.os}"]`) ?? null }
  return { host, document: { querySelector: (selector) => selector === ".download-primary" ? host : null } }
}

// Runs the owned script against a page and navigator; returns the revealed block or null.
function reveal(html, navigator) {
  const { host, document } = fakeDocument(html)
  const requests = []
  const trap = function (...request) { requests.push(request); throw new Error("the download script must not use the network") }
  runInNewContext(script, { document, navigator, fetch: trap, XMLHttpRequest: trap, WebSocket: trap, EventSource: trap, Image: trap })
  assert.deepEqual(requests, [])
  const shown = host.choices.filter((choice) => !choice.hidden)
  assert.equal(shown.length, host.hidden ? 0 : 1, "the block is revealed together with exactly one platform")
  return shown[0] ?? null
}

const CHROME = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
const SAFARI = "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
const NAVIGATORS = {
  windows: { userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`, platform: "Win32", maxTouchPoints: 0, userAgentData: { platform: "Windows", mobile: false } },
  windowsTouch: { userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME} Edg/130.0.0.0`, platform: "Win32", maxTouchPoints: 10, userAgentData: { platform: "Windows", mobile: false } },
  windowsArm: { userAgent: "Mozilla/5.0 (Windows NT 10.0; ARM64; rv:131.0) Gecko/20100101 Firefox/131.0", platform: "Win32", maxTouchPoints: 10 },
  macos: { userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}`, platform: "MacIntel", maxTouchPoints: 0, userAgentData: { platform: "macOS", mobile: false } },
  macosSafari: { userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${SAFARI}`, platform: "MacIntel", maxTouchPoints: 0 },
  ipados: { userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${SAFARI}`, platform: "MacIntel", maxTouchPoints: 5 },
  iphone: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", platform: "iPhone", maxTouchPoints: 5 },
  android: { userAgent: `Mozilla/5.0 (Linux; Android 10; K) ${CHROME.replace("Safari", "Mobile Safari")}`, platform: "Linux armv81", maxTouchPoints: 5, userAgentData: { platform: "Android", mobile: true } },
  androidTablet: { userAgent: `Mozilla/5.0 (Linux; Android 10; K) ${CHROME}`, platform: "Linux armv81", maxTouchPoints: 10, userAgentData: { platform: "Android", mobile: false } },
  androidFirefox: { userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0", platform: "Linux aarch64", maxTouchPoints: 5 },
  linux: { userAgent: `Mozilla/5.0 (X11; Linux x86_64) ${CHROME}`, platform: "Linux x86_64", maxTouchPoints: 0, userAgentData: { platform: "Linux", mobile: false } },
  linuxFirefox: { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", platform: "Linux x86_64", maxTouchPoints: 0 },
  linuxArmChrome: { userAgent: `Mozilla/5.0 (X11; Linux x86_64) ${CHROME}`, platform: "Linux aarch64", maxTouchPoints: 0, userAgentData: { platform: "Linux", mobile: false } },
  linuxArmFirefox: { userAgent: "Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0", platform: "Linux aarch64", maxTouchPoints: 0 },
  raspberryPi: { userAgent: `Mozilla/5.0 (X11; Linux armv7l) ${CHROME}`, platform: "Linux armv7l", maxTouchPoints: 0 },
  chromeos: { userAgent: `Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) ${CHROME}`, platform: "Linux x86_64", maxTouchPoints: 0, userAgentData: { platform: "Chrome OS", mobile: false } },
  chromeosFallback: { userAgent: `Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) ${CHROME}`, platform: "Linux x86_64", maxTouchPoints: 0 },
  freebsd: { userAgent: "Mozilla/5.0 (X11; FreeBSD amd64; rv:131.0) Gecko/20100101 Firefox/131.0", platform: "FreeBSD amd64", maxTouchPoints: 0 },
  empty: {},
  hintsFallback: { userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`, platform: "Win32", userAgentData: { platform: "", mobile: false } },
  hintsUnknown: { userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`, platform: "Win32", userAgentData: { platform: "Unknown", mobile: false } },
  hintsPrototypeKey: { userAgent: "", platform: "", userAgentData: { platform: "toString", mobile: false } },
}

test("the download platform detector checks mobile first, then client hints, then user agent and platform fallbacks", () => {
  const context = { document: { querySelector: () => null }, navigator: {} }
  runInNewContext(script, context)
  assert.equal(typeof context.detectDownloadPlatform, "function", "the detector is a named pure function")
  for (const [name, expected] of [
    ["windows", "windows"], ["windowsTouch", "windows"], ["windowsArm", "windows"],
    ["macos", "macos"], ["macosSafari", "macos"],
    ["ipados", "mobile"], ["iphone", "mobile"], ["android", "mobile"], ["androidTablet", "mobile"], ["androidFirefox", "mobile"],
    ["linux", "linux"], ["linuxFirefox", "linux"],
    ["linuxArmChrome", null], ["linuxArmFirefox", null], ["raspberryPi", null], ["chromeos", null], ["chromeosFallback", null],
    ["freebsd", null], ["empty", null], ["hintsFallback", "windows"], ["hintsUnknown", null], ["hintsPrototypeKey", null],
  ]) assert.equal(context.detectDownloadPlatform(NAVIGATORS[name]), expected, name)
  assert.ok(!/\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import|innerHTML|outerHTML|insertAdjacentHTML|eval|Function|getHighEntropyValues)\b/.test(script), "no requests, HTML injection or architecture probing")
})

test("the download button reveals the Tauri build for the visitor's platform, the Mobile page on phones, and nothing elsewhere", async (ctx) => {
  const { output } = await buildSite(ctx, { release })
  const html = await readFile(join(output, "en/download.html"), "utf8")
  const t = JSON.parse(await readFile(resolve(root, "docs/help/i18n/en.json"), "utf8")).download
  const main = (choice) => choice.links.find((link) => link.main)
  for (const [name, os, asset, label] of [
    ["windows", "windows", "tauri-windows-x64", t.windows], ["windowsArm", "windows", "tauri-windows-x64", t.windows],
    ["macos", "macos", "tauri-macos-arm64", t.macos], ["macosSafari", "macos", "tauri-macos-arm64", t.macos],
    ["linux", "linux", "tauri-linux-x64", t.linux],
  ]) {
    const choice = reveal(html, NAVIGATORS[name])
    assert.equal(choice?.os, os, name)
    assert.equal(main(choice).href, release.assets[asset].url, name)
    assert.equal(main(choice).textContent, label)
    assert.match(choice.text, /\d MB/, `${name}: the detail line shows the size`)
  }
  const mac = reveal(html, NAVIGATORS.macos)
  assert.deepEqual(mac.links.filter((link) => !link.main).map((link) => [link.href, link.textContent]), [[release.assets["tauri-macos-x64"].url, t.intel]], "Intel Macs get a secondary link")
  for (const name of ["iphone", "ipados", "android", "androidFirefox"]) {
    const choice = reveal(html, NAVIGATORS[name])
    assert.equal(choice?.os, "mobile", name)
    assert.equal(main(choice).href, "mobile.html")
    assert.equal(main(choice).textContent, t.mobile)
  }
  for (const name of ["linuxArmChrome", "linuxArmFirefox", "chromeos", "freebsd", "empty", "hintsUnknown"]) assert.equal(reveal(html, NAVIGATORS[name]), null, name)
  const throwing = { get userAgentData() { throw new Error("blocked") } }
  assert.equal(reveal(html, throwing), null, "a script failure leaves the button hidden")
  assert.equal(reveal(html.replace(`href="${release.assets["tauri-windows-x64"].url}"`, 'href=""'), NAVIGATORS.windows), null, "never reveal a button without a target")
  assert.equal(reveal(html.replace(`>${t.windows}</a>`, "> </a>"), NAVIGATORS.windows), null, "never reveal a button without a label")
})

test("the download page shows the release line once and links every asset in the static table", async (ctx) => {
  const downloads = JSON.parse(await readFile(resolve(root, "docs/help/downloads.json"), "utf8"))
  const { output, site } = await buildSite(ctx, { release })
  assert.equal(site.sections[0].pages[1], "download", "the download page follows the home page")
  for (const locale of site.locales) {
    const html = await readFile(join(output, locale, "download.html"), "utf8")
    const lang = /<article lang="en"/.test(html) ? "en" : locale
    const strings = JSON.parse(await readFile(resolve(root, `docs/help/i18n/${lang}.json`), "utf8"))
    const date = escapeHtml(new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" }).format(new Date(release.publishedAt)))
    assert.equal(html.split(date).length, 2, `${locale}: the date appears once`)
    assert.equal(html.split(`<p class="release-line">${escapeHtml(strings.release.published).replace("{version}", release.version).replace("{date}", date)}</p>`).length, 2, `${locale}: one release line`)
    const table = html.replace(PRIMARY, "")
    assert.match(table, /<table>/)
    for (const entry of downloads) assert.equal(table.split(`href="${release.assets[entry.id].url}"`).length, 2, `${locale}: the table links ${entry.id} once`)
    assert.equal((html.match(/<div data-download-os="[a-z]+" hidden>/g) ?? []).length, 4, "every platform block is hidden until the script selects one")
    const index = JSON.parse(await readFile(join(output, locale, "search-index.json"), "utf8"))
    const desktop = index.find((entry) => entry.href === "download.html#desktop")
    assert.ok(desktop && !desktop.excerpt.includes(strings.download.windows), "hidden button labels stay out of search excerpts")
  }
})

test("without release data the download button and table open the latest release page", async (ctx) => {
  const { output } = await buildSite(ctx)
  const html = await readFile(join(output, "en/download.html"), "utf8")
  const block = PRIMARY.exec(html)[1]
  assert.deepEqual([...block.matchAll(/href="([^"]*)"/g)].map((match) => match[1]), [LATEST_RELEASE, LATEST_RELEASE, LATEST_RELEASE, LATEST_RELEASE, "mobile.html"])
  assert.ok(!html.includes("download-size") && !html.includes("/releases/download/"), "no asset URL or size without release data")
  assert.equal(reveal(html, NAVIGATORS.linux).links[0].href, LATEST_RELEASE)
})
