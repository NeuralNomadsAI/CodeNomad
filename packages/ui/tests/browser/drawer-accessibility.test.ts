import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import type {} from "./fixtures/drawer-accessibility"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)),
      logLevel: "error", cacheDir: cache.cacheDir, plugins: [solid(), shutdown.plugin, {
        name: "drawer-accessibility-fixture", configureServer(s) {
          s.middlewares.use("/drawer-accessibility", async (_req, res) => {
            res.setHeader("Content-Type", "text/html")
            res.end(await s.transformIndexHtml("/drawer-accessibility", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/drawer-accessibility.tsx"></script></body></html>'))
          })
        },
      }], resolve: { dedupe: ["solid-js"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
    shutdown.own(server); await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/drawer-accessibility`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
}, { timeout: 60000 })
after(async () => { try { await browser?.close() } finally { await server?.close() } })

async function isolation(page: Page, side: "left" | "right") {
  const action = page.getByRole("button", { name: `${side} action`, exact: true })
  await action.waitFor()
  assert.equal(await page.getByRole("button", { name: "Open left", exact: true }).count(), 0)
  assert.equal(await page.locator("[data-background]").getAttribute("aria-hidden"), "true")
  assert.equal(await page.locator("[data-previously-hidden]").getAttribute("aria-hidden"), "true")
  assert.equal(await page.locator("[data-outside-hidden]").getAttribute("aria-hidden"), "true")
  assert.equal(await page.getByRole("button", { name: "Outside host", exact: true }).count(), 1)
  assert.equal(await page.locator("[data-host]").evaluate(el => el.style.overflow), "hidden")
  const geometry = await action.evaluate(el => {
    const modal = el.closest(".MuiModal-root")!, host = document.querySelector("[data-host]")!
    const [hostBounds, modalBounds, paperBounds] = [host, modal, modal.querySelector(".MuiDrawer-paper")!].map(element => {
      const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    const hiddenAncestors: string[] = []
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("inert")) hiddenAncestors.push(node.tagName)
    }
    return { directChild: modal.parentElement === host, hiddenAncestors, host: hostBounds,
      modal: modalBounds, paper: paperBounds }
  })
  assert(geometry.directChild, "ModalManager's exclusion must identify the actual host child")
  assert.deepEqual(geometry.hiddenAncestors, [])
  assert.deepEqual(geometry.modal, geometry.host, "modal retains host-bounded geometry")
  // Slide is still transitioning on opposite-side switches. Its size is unchanged.
  assert(Math.abs(geometry.paper.width - geometry.host.width) < 0.01, "drawer width stays host-bounded through fractional Slide transforms")
  assert(Math.abs(geometry.paper.height - geometry.host.height) < 0.01, "drawer height stays host-bounded through fractional Slide transforms")
}

async function restored(page: Page) {
  await page.getByRole("button", { name: "Open left", exact: true }).waitFor()
  assert.equal(await page.locator("[data-background]").getAttribute("aria-hidden"), null)
  assert.equal(await page.locator("[data-previously-hidden]").getAttribute("aria-hidden"), "true")
  assert.equal(await page.locator("[data-outside-hidden]").getAttribute("aria-hidden"), "true")
  assert.equal(await page.getByRole("button", { name: "Previously hidden", exact: true }).count(), 0)
  assert.equal(await page.locator("[data-host]").evaluate(el => el.style.overflow), "auto")
}

for (const rtl of [false, true]) test(`${rtl ? "RTL touch" : "LTR"} hosted drawers preserve accessibility and scoped modal restoration across switch/close/reopen`, { timeout: 60000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 600 }, hasTouch: rtl })
  const errors: string[] = [], consoleErrors: string[] = [], failures: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()) })
  page.on("requestfailed", request => failures.push(`${request.url()} ${request.failure()?.errorText}`))
  try {
    await page.goto(url); await page.waitForFunction(() => !!window.drawerAccessibility)
    await page.evaluate(rtl => window.drawerAccessibility.direction(rtl), rtl)
    const click = async (name: string) => {
      const button = page.getByRole("button", { name, exact: true })
      if (rtl) await button.tap(); else await button.click()
    }
    await click("Open left"); await isolation(page, "left")
    await click("Switch to right"); await isolation(page, "right")
    await click("Switch to left"); await isolation(page, "left")
    await click("Open adjacent")
    await page.getByRole("dialog", { name: "Adjacent modal", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "left action", exact: true }).count(), 0, "top modal must still isolate the drawer")
    assert.equal(await page.locator("[data-background]").getAttribute("aria-hidden"), "true")
    await page.getByRole("button", { name: "Adjacent action", exact: true }).focus()
    await page.keyboard.press("Escape")
    await isolation(page, "left")
    const action = page.getByRole("button", { name: "left action", exact: true })
    await action.focus(); await page.keyboard.press("Enter")
    assert.equal(await page.locator("[data-actions]").innerText(), "1", "drawer action remains keyboard-operable")
    await page.keyboard.press("Escape"); await restored(page)
    await click("Open right"); await isolation(page, "right")
    await click("Close right"); await restored(page)
    await click("Open left"); await isolation(page, "left")
    await click("Close left"); await restored(page)
    // Direction changes and drawer owner disposal must not retain hidden ancestors.
    await page.evaluate(rtl => window.drawerAccessibility.direction(!rtl), rtl)
    await click("Open right"); await isolation(page, "right")
    await page.evaluate(() => window.drawerAccessibility.mounted(false)); await restored(page)
    assert.equal(await page.locator("[data-host] .MuiModal-root").count(), 0)
    await page.evaluate(() => window.drawerAccessibility.mounted(true))
    await click("Open left"); await isolation(page, "left")
    await click("Close left"); await restored(page)
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(failures, [])
  } finally { await page.close() }
})
