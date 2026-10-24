import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { buildHelp, TRANSLATION_PROBLEMS } from "./build-help.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const args = process.argv.slice(2)
const contentIndex = args.indexOf("--content")
const content = contentIndex === -1 ? resolve(root, "docs/help") : resolve(args[contentIndex + 1])
if (contentIndex !== -1) args.splice(contentIndex, 2)
assert.deepEqual(args, [], "only --content <source-directory> is supported")
const screenshotRoot = join(tmpdir(), "codenomad-help")
let output, server, browser, base, site, screenshots

before(async () => {
  const temporaryRoot = process.platform === "win32" ? join(tmpdir(), "opencode") : tmpdir()
  await mkdir(temporaryRoot, { recursive: true })
  output = await mkdtemp(join(temporaryRoot, "codenomad-help-browser-"))
  await mkdir(screenshotRoot, { recursive: true })
  screenshots = await mkdtemp(join(screenshotRoot, "captures-"))
  const built = await buildHelp({ content, output })
  assert.deepEqual(built.problems.filter((problem) => !TRANSLATION_PROBLEMS.has(problem.kind)), [])
  site = built.site
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp" }
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost")
      if (!url.pathname.startsWith("/CodeNomad/")) throw new Error("not a project-site path")
      let file = resolve(output, decodeURIComponent(url.pathname.slice("/CodeNomad/".length)))
      if (relative(output, file).startsWith("..")) throw new Error("not a help path")
      if ((await stat(file)).isDirectory()) file = join(file, "index.html")
      res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream")
      res.end(await readFile(file))
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready))
  base = `http://127.0.0.1:${server.address().port}/CodeNomad/`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => {
  try { await browser?.close() } finally {
    if (server) await new Promise((done) => server.close(done))
    if (output) await rm(output, { recursive: true, force: true })
  }
})

for (const locale of ["en", "he", "ne", "ja", "zh-Hans"]) for (const colorScheme of ["light", "dark"]) for (const [size, viewport] of [
  ["desktop", { width: 1440, height: 1000 }], ["intermediate", { width: 1024, height: 900 }], ["narrow", { width: 800, height: 900 }], ["mobile", { width: 390, height: 844 }],
]) test(`${locale}: ${size} ${colorScheme} chrome, navigation and keyboard access`, async (ctx) => {
  const page = await browser.newPage({ viewport, colorScheme })
  const errors = [], failedRequests = [], remoteRequests = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("requestfailed", (request) => failedRequests.push(request.url()))
  page.on("request", (request) => { if (!request.url().startsWith(base)) remoteRequests.push(request.url()) })
  try {
    await page.goto(`${base}${locale}/`)
    await page.evaluate(() => document.fonts.ready)
    assert.equal(await page.locator("html").getAttribute("dir"), locale === "he" ? "rtl" : "ltr")
    assert.equal(await page.locator(".sidebar a[aria-current=page]").first().getAttribute("href"), "index.html")
    assert.ok(await page.locator("article h1").isVisible())
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no page-wide horizontal overflow")
    assert.equal(await page.locator(".brand").evaluate((element) => getComputedStyle(element).borderRadius), "0px")
    if (size === "mobile") {
      assert.equal(await page.locator('.topics').getAttribute('open'), null)
      assert.equal(await page.locator('.outline details').getAttribute('open'), null)
      assert.ok(await page.locator('.table-scroll').evaluateAll((elements) => elements.some(element => element.scrollWidth > element.clientWidth)), 'wide tables scroll locally')
      assert.ok(await page.locator('pre').evaluateAll((elements) => elements.some(element => element.scrollWidth > element.clientWidth)), 'long code scrolls locally')
      for (const selector of ['#help-query', '.search-controls button']) assert.ok((await page.locator(selector).boundingBox()).height >= 44)
    }
    assert.ok(await page.locator(size === 'desktop' ? '.outline-wide' : '.outline summary').isVisible(), 'outline remains available at every width')
    if (size !== 'mobile') assert.ok(await page.locator('.topics-wide a').first().isVisible(), 'desktop navigation is expanded without JavaScript')
    const sidebar = await page.locator(".sidebar").boundingBox(), main = await page.locator("main").boundingBox()
    if (size === "desktop") assert.ok(locale === "he" ? sidebar.x > main.x : sidebar.x < main.x, "sidebar mirrors in RTL")
    const path = join(screenshots, `${locale}-${size}-${colorScheme}.png`)
    await page.screenshot({ path, fullPage: true })
    ctx.diagnostic(path)
    await page.keyboard.press("Tab")
    assert.equal(await page.locator(":focus").getAttribute("class"), "skip-link")
    await page.keyboard.press("Enter")
    assert.equal(await page.locator(":focus").getAttribute("id"), "content")
    await page.locator('.brand').focus()
    await page.keyboard.press('Control+k')
    assert.equal(await page.locator(':focus').getAttribute('id'), 'help-query')
    for (const selector of ['#help-query', '.search-controls button']) {
      const indicator = await page.locator(selector).evaluate(element => {
        const style = getComputedStyle(element)
        return { visible: element.matches(':focus-visible'), width: style.outlineWidth, style: style.outlineStyle, offset: style.outlineOffset, color: style.outlineColor }
      })
      assert.equal(indicator.visible, true)
      assert.equal(indicator.width, '2px')
      assert.equal(indicator.style, 'solid')
      assert.equal(indicator.offset, '-3px', 'search focus stays inside the control, away from labels and neighbours')
      assert.notEqual(indicator.color, 'rgba(0, 0, 0, 0)')
      if (selector === '#help-query') await page.keyboard.press('Tab')
    }
    await page.keyboard.press('Shift+Tab')
    const term = (await page.locator('article h2').first().innerText()).slice(0, 3)
    await page.locator('#help-query').fill(term)
    const queryBox = await page.locator('#help-query').boundingBox()
    await page.mouse.click(queryBox.x + queryBox.width - 10, queryBox.y + queryBox.height / 2)
    assert.equal(await page.locator('#help-query').inputValue(), term, 'the native right-edge cancel affordance must not clear the query')
    await page.locator('#help-results a').first().waitFor()
    assert.ok((await page.locator('#help-results a').count()) > 0, 'substring search supports non-Latin languages')
    await page.keyboard.press('ArrowUp')
    assert.equal(await page.locator('#help-results a[data-selected]').getAttribute('href'), await page.locator('#help-results a').last().getAttribute('href'), 'Up starts at the final result')
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.locator('#help-results a[data-selected]').count(), 1)
    const searchPath = join(screenshots, `${locale}-${size}-${colorScheme}-search.png`)
    await page.screenshot({ path: searchPath, fullPage: true })
    assert.equal(await page.locator('#help-query').evaluate((element) => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true, cancelable: true })
      element.dispatchEvent(event); return event.defaultPrevented
    }), false, 'composition is not intercepted')
    assert.equal(await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
      document.dispatchEvent(event); return event.defaultPrevented
    }), false, 'browser find is unchanged')
    await page.keyboard.press('Escape')
    assert.equal(await page.locator(':focus').getAttribute('class'), 'brand')
    assert.equal(await page.locator('.search-results').isVisible(), false)
    await page.keyboard.press('Control+k')
    await page.locator('#help-query').fill('zzzz-no-result-123')
    assert.equal(await page.locator('#help-results a').count(), 0)
    assert.ok((await page.locator('.search-status').innerText()).includes('zzzz-no-result-123'))
    await page.screenshot({ path: join(screenshots, `${locale}-${size}-${colorScheme}-no-results.png`), fullPage: true })
    await page.locator('.search-controls button').click()
    assert.equal(await page.locator('#help-query').inputValue(), '')
    await page.locator('#help-query').fill(term)
    await page.locator('#help-results a').first().waitFor()
    const target = await page.locator('#help-results a').first().getAttribute('href')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await page.waitForURL(`${base}${locale}/${target}`)
    await page.goto(`${base}${locale}/`)
    await page.keyboard.press('Escape')
    await page.locator(".language-menu summary").click()
    assert.equal(await page.locator(".language-menu a").count(), site.locales.length)
    await page.locator('.language-menu a[hreflang="fr"]').click()
    assert.equal(page.url(), `${base}fr/index.html`)
    assert.equal(await page.locator("html").getAttribute("lang"), "fr")
    assert.deepEqual(errors, [])
    assert.deepEqual(failedRequests, [])
    assert.deepEqual(remoteRequests, [], "no third-party runtime requests")
  } finally { await page.close() }
})

test("all English articles fit mobile and desktop widths", async (ctx) => {
  const page = await browser.newPage({ colorScheme: "light" })
  try {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const slug of site.sections.flatMap(section => section.pages)) {
        await page.goto(`${base}en/${slug}.html`)
        assert.equal(await page.locator("article h1").count(), 1, slug)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${slug} overflows at ${width}px`)
        if (slug === "server" && width === 390 || slug === "missions" && width === 1440) {
          const path = join(screenshots, `${slug}-${width}.png`)
          await page.screenshot({ path, fullPage: true })
          ctx.diagnostic(path)
        }
      }
    }
  } finally { await page.close() }
})

test("root redirects to browser language with regional Chinese and legacy Hebrew matching", async () => {
  for (const [language, expected] of [["fr-CA", "fr"], ["zh-TW", "zh-Hans"], ["iw-IL", "he"]]) {
    const context = await browser.newContext()
    await context.addInitScript(`Object.defineProperty(navigator, "languages", { value: [${JSON.stringify(language)}] })`)
    try {
      const page = await context.newPage()
      await page.goto(base)
      await page.waitForURL(`${base}${expected}/`)
      assert.equal(await page.locator("html").getAttribute("lang"), expected)
    } finally { await context.close() }
  }
})

test("root language links and page navigation work without JavaScript", async (ctx) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } })
  try {
    const page = await context.newPage()
    await page.goto(base)
    assert.equal(await page.locator(".language-list a").count(), site.locales.length)
    const path = join(screenshots, "language-chooser-mobile.png")
    await page.screenshot({ path, fullPage: true })
    ctx.diagnostic(path)
    await page.locator('a[hreflang="he"]').click()
    assert.equal(page.url(), `${base}he/`)
    assert.ok(await page.locator("article h1").isVisible())
    assert.equal(await page.locator('.help-search').isVisible(), false)
    await page.locator(".language-menu summary").click()
    await page.locator('.language-menu a[hreflang="en"]').click()
    assert.equal(page.url(), `${base}en/index.html`)
  } finally { await context.close() }
})

test('search failure is actionable and navigation remains usable', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/search-index.json', (route) => route.fulfill({ status: 503, body: '' }))
    await page.goto(`${base}en/`)
    await page.locator('#help-query').focus()
    await page.locator('#help-query').fill('sessions')
    await page.waitForFunction(() => document.querySelector('.search-status').textContent.includes('Reload'))
    assert.ok(await page.locator('.topics-wide a').first().isVisible())
  } finally { await page.close() }
})
