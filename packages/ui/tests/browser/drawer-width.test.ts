import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({
    configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: cache.cacheDir,
    plugins: [shutdown.plugin, solid(), { name: "drawer-width-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/header-windows.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture?drawerWidth=1`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { await browser?.close(); await server?.close() })

const key = "opencode-session-right-drawer-width-v1"
const savedWidth = (page: Page) => page.evaluate(key => Number((window as any).fixture.readLayout(key)), key)
const displayedWidth = async (page: Page) => (await page.locator(".session-right-panel").boundingBox())!.width

async function chooseWidth(page: Page, width: number) {
  const startWidth = await savedWidth(page)
  const handle = (await page.locator(".session-resize-handle--right").boundingBox())!
  const x = handle.x + handle.width / 2, y = handle.y + 160
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + startWidth - width, y, { steps: 16 })
  await page.mouse.up()
  await page.waitForFunction(({ key, width }) => Number((window as any).fixture.readLayout(key)) === width, { key, width }, { timeout: 3000 }).catch(async error => {
    throw new Error(`Drawer resize: desired=${width} saved=${await savedWidth(page)} displayed=${await displayedWidth(page)} start=${startWidth}`, { cause: error })
  })
  assert.ok(Math.abs(await displayedWidth(page) - width) <= 1)
}

test("transient minimized viewport sizes do not overwrite the chosen drawer width", async () => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await chooseWidth(page, 500)
    for (const minimizedWidth of [0, 160, 320]) {
      // Feed the native minimize symptom into the real shell's resize handler;
      // this is a deterministic renderer regression, not a native host test.
      await page.evaluate(width => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
        window.dispatchEvent(new Event("resize"))
      }, minimizedWidth)
      assert.equal(await savedWidth(page), 500, `saved width during transient ${minimizedWidth}px viewport`)
      await page.evaluate(() => {
        delete (window as any).innerWidth
        window.dispatchEvent(new Event("resize"))
      })
      assert.ok(Math.abs(await displayedWidth(page) - 500) <= 1)
      assert.equal(await savedWidth(page), 500)
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

const pinned = (page: Page) => page.evaluate(() => ({
  left: Boolean(document.querySelector(".session-sidebar-container")),
  right: Boolean(document.querySelector(".session-right-panel")),
  floating: document.querySelectorAll(".session-floating-drawer .MuiDrawer-paper").length,
}))
const waitForPinned = (page: Page, left: boolean, right: boolean) => page.waitForFunction(({ left, right }) =>
  Boolean(document.querySelector(".session-sidebar-container")) === left
  && Boolean(document.querySelector(".session-right-panel")) === right, { left, right })

test("touch tablets remember drawers per orientation; portrait opens closed", async () => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 1024 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true)
    await waitForPinned(page, true, true)

    await page.setViewportSize({ width: 1024, height: 1366 })
    await waitForPinned(page, false, false)
    assert.deepEqual(await pinned(page), { left: false, right: false, floating: 0 }, "portrait leaves the conversation uncovered")

    // Opening the sessions drawer in portrait is remembered for portrait only.
    await page.locator(".session-header-drawer-toggle--left button").click()
    await waitForPinned(page, true, false)
    await page.setViewportSize({ width: 1366, height: 1024 })
    await waitForPinned(page, true, true)
    await page.setViewportSize({ width: 1024, height: 1366 })
    await waitForPinned(page, true, false)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("a drawer closed by rotation hands keyboard focus to its toggle", async () => {
  // Tablet sizes on both sides of the 1280 px desktop breakpoint.
  for (const [width, height] of [[1180, 820], [1366, 1024]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true })
    const page = await context.newPage()
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    try {
      await page.goto(url)
      await page.waitForFunction(() => Boolean((window as any).fixture))
      await waitForPinned(page, true, true)
      await page.locator(".session-sidebar-container button").first().focus()
      await page.setViewportSize({ width: height, height: width })
      await waitForPinned(page, false, false)
      await page.waitForFunction(() => document.activeElement?.closest(".session-header-drawer-toggle--left") !== null)
    } finally { await context.close() }
  }
})

test("pointer devices keep drawers open in a tall window", async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1024 } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await waitForPinned(page, true, true)
    await page.setViewportSize({ width: 1024, height: 1366 })
    await page.waitForTimeout(300)
    assert.deepEqual(await pinned(page), { left: true, right: true, floating: 0 })
  } finally { await page.close() }
})

test("real viewport changes constrain only display and restoring space recovers the selected width", async () => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await chooseWidth(page, 600)
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.waitForFunction(() => document.querySelector(".session-right-panel")!.getBoundingClientRect().width < 600)
    assert.equal(await savedWidth(page), 600)
    for (const width of [800, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForFunction(() => !document.querySelector(".session-right-panel"))
      assert.equal(await savedWidth(page), 600)
    }
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.waitForFunction(() => Math.abs((document.querySelector(".session-right-panel")?.getBoundingClientRect().width ?? 0) - 600) <= 1)
    assert.equal(await savedWidth(page), 600)
    await chooseWidth(page, 450)
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.waitForFunction(() => Math.abs((document.querySelector(".session-right-panel")?.getBoundingClientRect().width ?? 0) - 450) <= 1)
    assert.equal(await savedWidth(page), 450, "explicit resizing still replaces the saved preference")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
