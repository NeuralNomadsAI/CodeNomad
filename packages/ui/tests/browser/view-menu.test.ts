import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [shutdown.plugin, solid(), { name: "view-menu-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/header-windows.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close() })

for (const host of ["electron", "tauri"]) test(`${host}: native view state follows actual drawers, preferences and active project`, async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `
    const win = window
    const host = ${JSON.stringify(host)}
    win.__CODENOMAD_RUNTIME_HOST__ = host
    win.__CODENOMAD_WINDOW_CONTEXT__ = "local"
    const capture = async (enabled, state) => { win.viewSnapshot = { enabled, state }; return { ok: true } }
    if (host === "electron") win.electronAPI = { setWorkspaceMenuEnabled: capture }
    else win.__TAURI__ = { core: { invoke: async (command, args) => {
      if (command === "set_workspace_menu_enabled") return capture(args.enabled, args.viewState)
    } } }
  ` })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture && (window as any).viewSnapshot?.state.leftPanel.checked))
    // Close with the existing button, reopen through the menu's actual handler.
    // The fixed toggles share the menu's panel labels; aria-expanded carries the state.
    const leftToggle = page.getByRole("button", { name: "Left panel", exact: true })
    const rightToggle = page.getByRole("button", { name: "Right panel", exact: true })
    await leftToggle.click()
    await page.waitForFunction(() => !(window as any).viewSnapshot.state.leftPanel.checked)
    assert.equal(await leftToggle.getAttribute("aria-expanded"), "false")
    await page.evaluate(() => (window as any).fixture.viewAction("view-left-panel"))
    await page.locator('.shell-panel-toggle--left button[aria-expanded="true"]').waitFor()
    await page.waitForFunction(() => (window as any).viewSnapshot.state.leftPanel.checked)
    await page.evaluate(() => (window as any).fixture.viewAction("view-right-panel"))
    await page.waitForFunction(() => !(window as any).viewSnapshot.state.rightPanel.checked)
    assert.equal(await rightToggle.getAttribute("aria-expanded"), "false")
    await rightToggle.click()
    await page.waitForFunction(() => (window as any).viewSnapshot.state.rightPanel.checked)

    // Timeline tool markers follow Message content; the View menu has no separate tools item.
    await page.evaluate(() => (window as any).fixture.setPreferences({ showMessageTimeline: true }))
    await page.waitForFunction(() => (window as any).viewSnapshot.state.timeline.checked)
    assert.equal(await page.evaluate(() => "timelineTools" in (window as any).viewSnapshot.state), false)
    await page.evaluate(() => (window as any).fixture.viewAction("view-timeline"))
    await page.waitForFunction(() => !(window as any).viewSnapshot.state.timeline.checked)
    await page.evaluate(() => (window as any).fixture.viewAction("view-timeline"))
    await page.waitForFunction(() => (window as any).viewSnapshot.state.timeline.checked)

    await page.evaluate(() => (window as any).fixture.setPreferences({ locale: "fr" }))
    await page.waitForFunction(() => (window as any).viewSnapshot.state.leftPanel.label === "Volet gauche")
    await page.evaluate(() => (window as any).fixture.menuInstance("unmounted-project"))
    await page.waitForFunction(() => !(window as any).viewSnapshot.state.leftPanel.enabled)
    await page.evaluate(() => (window as any).fixture.viewAction("view-left-panel"))
    await page.evaluate(() => (window as any).fixture.menuInstance("header-windows"))
    await page.waitForFunction(() => (window as any).viewSnapshot.state.leftPanel.checked)
    await page.setViewportSize({ width: 700, height: 900 })
    await page.evaluate(() => (window as any).fixture.setPreferences({ locale: "he" }))
    await page.waitForFunction(() => document.documentElement.dir === "rtl")
    await page.evaluate(() => (window as any).fixture.viewAction("view-left-panel"))
    await page.waitForFunction(() => !(window as any).viewSnapshot.state.leftPanel.checked)
    await page.evaluate(() => (window as any).fixture.viewAction("view-left-panel"))
    await page.waitForFunction(() => (window as any).viewSnapshot.state.leftPanel.checked)
    await page.evaluate(() => (window as any).fixture.menuInstance(undefined))
    await page.waitForFunction(() => !(window as any).viewSnapshot.enabled && !(window as any).viewSnapshot.state.timeline.enabled)
  } catch (error) {
    console.error({ errors, state: await page.evaluate(() => (window as any).viewSnapshot), body: await page.locator("body").innerText() })
    throw error
  } finally { await page.close() }
})
