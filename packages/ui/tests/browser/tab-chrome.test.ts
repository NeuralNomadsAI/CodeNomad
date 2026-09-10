import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, _electron, type Browser, type Page, type ElectronApplication } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "tab-fixture", configureServer(s) {
      s.middlewares.use("/tab-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/tab-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/tab-chrome.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/tab-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function prepare(page: Page) {
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).tabFixture))
  await page.locator(".right-panel-tab").first().waitFor()
}

async function check(page: Page, label: string) {
  await page.waitForTimeout(120)
  const results = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".tab-scroll-frame")].map(frame => {
    const viewport = frame.querySelector<HTMLElement>(".tab-scroll")!
    const scrollbar = frame.querySelector<HTMLElement>(".tab-scrollbar")!
    const bar = frame.closest(".tab-bar-instance,.right-panel-tab-bar")!
    const tabs = [...frame.querySelectorAll<HTMLElement>('[role="tab"]')]
    const reference = getComputedStyle(document.querySelector('[data-fixture="reference"]')!)
    return {
      tabCount: tabs.length,
      seam: Math.abs(tabs[0].getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom),
      gaps: tabs.slice(1).map((tab, i) => Math.min(
        Math.abs(tab.getBoundingClientRect().left - tabs[i].getBoundingClientRect().right),
        Math.abs(tab.getBoundingClientRect().right - tabs[i].getBoundingClientRect().left))),
      transforms: [viewport, ...viewport.querySelectorAll<HTMLElement>(".tab-strip,.tab-draggable")].map(e => getComputedStyle(e).transform),
      scrollbarWidth: getComputedStyle(scrollbar).scrollbarWidth, referenceWidth: reference.scrollbarWidth,
      scrollbarColor: getComputedStyle(scrollbar).scrollbarColor, referenceColor: reference.scrollbarColor,
      overflow: viewport.scrollWidth > viewport.clientWidth,
      ranges: [viewport.scrollWidth - viewport.clientWidth, scrollbar.scrollWidth - scrollbar.clientWidth],
      contentScrollbar: getComputedStyle(viewport).scrollbarWidth,
    }
  }))
  assert.equal(results.length, 2)
  for (const result of results) {
    assert.ok(result.tabCount > 0, label)
    assert.ok(result.seam < 0.1, `${label}: baseline gap ${result.seam}`)
    assert.ok(result.gaps.every(gap => gap < 0.1), `${label}: adjoining tabs ${result.gaps}`)
    assert.ok(result.transforms.every(t => t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)"), `${label}: mirrored layer`)
    assert.equal(result.scrollbarWidth, result.referenceWidth, label)
    assert.equal(result.scrollbarColor, result.referenceColor, label)
    assert.equal(result.contentScrollbar, "none")
    assert.ok(Math.abs(result.ranges[0] - result.ranges[1]) <= 1, `${label}: scroll range`)
  }
  // Exercise bidirectional synchronization without activating application actions.
  for (const selector of [".tab-scrollbar", ".tab-scroll"]) {
    await page.evaluate(selector => {
      document.querySelectorAll<HTMLElement>(selector).forEach(e => { e.scrollLeft = document.dir === "rtl" ? -100 : 100 })
    }, selector)
    await page.waitForTimeout(60)
    const offsets = await page.evaluate(() => [...document.querySelectorAll(".tab-scroll-frame")].map(e => [e.querySelector(".tab-scroll")!.scrollLeft, e.querySelector(".tab-scrollbar")!.scrollLeft]))
    offsets.forEach(([a, b]) => assert.ok(Math.abs(a - b) < 1, `${label}: scroll synchronization`))
  }
  if (process.env.CODENOMAD_TAB_SCREENSHOTS) {
    await mkdir(process.env.CODENOMAD_TAB_SCREENSHOTS, { recursive: true })
    await page.screenshot({ path: join(process.env.CODENOMAD_TAB_SCREENSHOTS, `${label}.png`) })
  }
}

async function checkFittingTabs(page: Page, label: string) {
  await page.evaluate(() => (window as any).tabFixture.count(1))
  await page.waitForTimeout(100)
  const fit = await page.locator('[data-fixture="instances"] .tab-scroll-frame').evaluate(frame => {
    const viewport = frame.querySelector<HTMLElement>(".tab-scroll")!
    const scrollbar = frame.querySelector<HTMLElement>(".tab-scrollbar")!
    return {
      viewportOverflow: viewport.scrollWidth > viewport.clientWidth,
      scrollbarOverflow: scrollbar.scrollWidth > scrollbar.clientWidth,
      overflowX: getComputedStyle(scrollbar).overflowX,
    }
  })
  assert.deepEqual(fit, { viewportOverflow: false, scrollbarOverflow: false, overflowX: "hidden" }, `${label}: no phantom scrollbar`)
  await page.evaluate(() => (window as any).tabFixture.count(9))
}

test("real tab strips retain shared scrollbars and flush seams across zoom/DPI/RTL", async () => {
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: dpr })
    try {
      await prepare(page)
      for (const dir of ["ltr", "rtl"]) for (const zoom of [0.8, 0.9, 1, 1.1, 1.25, 1.5]) {
        await page.evaluate(({ dir, zoom }) => { document.dir = dir; document.body.style.zoom = String(zoom) }, { dir, zoom })
        await check(page, `edge-${dpr}-${dir}-${zoom}`)
        await checkFittingTabs(page, `edge-${dpr}-${dir}-${zoom}`)
      }
      await page.evaluate(() => (window as any).tabFixture.count(1))
      await check(page, `edge-${dpr}-no-overflow`)
      assert.equal(await page.locator('[data-fixture="instances"] .tab-scrollbar').evaluate(e => e.scrollWidth > e.clientWidth), false)
    } finally { await page.close() }
  }
})

test("Electron BrowserWindow native zoom retains tab seams and matching scrollbars", { skip: !process.env.CODENOMAD_TEST_ELECTRON }, async () => {
  let app: ElectronApplication | undefined
  const profile = await mkdtemp(join(process.env.CODENOMAD_TEST_TEMP || tmpdir(), "codenomad-tab-electron-"))
  try {
    const env = { ...process.env, CODENOMAD_TEST_PROFILE: profile }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: process.env.CODENOMAD_TEST_ELECTRON,
      args: [fileURLToPath(new URL("fixtures/tab-chrome-electron.cjs", import.meta.url))], env })
    const page = await app.firstWindow()
    await prepare(page)
    for (const palette of ["classic", "light"]) for (const dir of ["ltr", "rtl"]) for (const zoom of [0.8, 0.9, 1, 1.1, 1.25, 1.5]) {
      await page.evaluate(palette => (window as any).tabFixture.palette(palette), palette)
      await page.evaluate(dir => { document.dir = dir }, dir)
      await app.evaluate(({ BrowserWindow }, zoom) => { BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom) }, zoom)
      await check(page, `electron-${palette}-${dir}-${zoom}`)
      await checkFittingTabs(page, `electron-${palette}-${dir}-${zoom}`)
    }
  } finally { await app?.close() }
})

test("native wheel, keyboard reveal, resize and tab selection keep the two viewports in sync", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  try {
    await prepare(page)
    const frame = page.locator('[data-fixture="instances"] .tab-scroll-frame')
    await frame.locator(".tab-scroll").hover()
    await page.mouse.wheel(240, 0)
    await page.waitForFunction(() => document.querySelector('[data-fixture="instances"] .tab-scroll')!.scrollLeft > 0)
    const last = frame.getByRole("tab").last()
    await last.focus()
    await page.keyboard.press("Enter")
    assert.equal(await last.getAttribute("aria-selected"), "true")
    await check(page, "edge-keyboard-reveal")
    // Resize the real strip while it is scrolled; the scrollbar must clamp too.
    await page.setViewportSize({ width: 720, height: 800 })
    await check(page, "edge-resized")
  } finally { await page.close() }
})

test("upright tabs retain native pointer reordering and sidecar selection", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  try {
    await prepare(page)
    const tabs = page.locator('[data-fixture="instances"] [role="tab"]')
    const firstLabel = await tabs.first().innerText()
    const from = await tabs.first().boundingBox()
    const to = await tabs.nth(1).boundingBox()
    assert.ok(from && to)
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 })
    await page.mouse.up()
    await page.waitForTimeout(200)
    assert.equal(await tabs.nth(1).innerText(), firstLabel)
    const preview = tabs.filter({ hasText: "Preview" })
    await preview.click()
    assert.equal(await preview.getAttribute("aria-selected"), "true")
    await check(page, "edge-reordered-sidecar")
  } finally { await page.close() }
})

test("touch layout retains scrolling without a mirrored tab layer", async () => {
  const page = await browser.newPage({ viewport: { width: 720, height: 800 }, hasTouch: true })
  try {
    await prepare(page)
    await check(page, "edge-touch")
    await page.locator('[data-fixture="instances"] [role="tab"]').nth(1).tap()
    assert.equal(await page.locator('[data-fixture="instances"] [role="tab"]').nth(1).getAttribute("aria-selected"), "true")
  } finally { await page.close() }
})
