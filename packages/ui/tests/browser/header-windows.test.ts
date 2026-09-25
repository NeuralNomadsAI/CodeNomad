import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "header-windows-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/header-windows.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

for (const kind of ["command-palette", "session-search"]) test(`${kind} stays open outside, marks its toggle, and closes explicitly`, async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const trigger = page.locator(`button[aria-controls^="${kind}-"]`)
    await trigger.waitFor()
    const id = await trigger.getAttribute("aria-controls")
    const panel = page.locator(`[id="${id}"]`)
    await trigger.click()
    await panel.waitFor()
    assert.equal(await trigger.getAttribute("aria-expanded"), "true")
    assert.notEqual(await trigger.evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)")
    assert.equal(await page.locator(".modal-overlay").count(), 0)
    assert.notEqual(await panel.getAttribute("aria-modal"), "true")
    await trigger.click()
    await panel.waitFor({ state: "hidden" })
    assert.equal(await trigger.getAttribute("aria-expanded"), "false")
    await trigger.click()
    await panel.waitFor()
    await page.locator("#outside").click()
    assert.equal(await panel.isVisible(), true)
    assert.equal(await page.locator("#outside").evaluate(el => el === document.activeElement), true)
    await trigger.click()
    await panel.waitFor({ state: "hidden" })
    await trigger.focus()
    await page.keyboard.press("Enter")
    await panel.waitFor()
    await page.keyboard.press("Escape")
    await panel.waitFor({ state: "hidden" })
    assert.equal(await trigger.getAttribute("aria-expanded"), "false")
    await page.waitForFunction(id => document.querySelector(`button[aria-controls="${id}"]`) === document.activeElement, id)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, body: await page.locator("body").innerText() })
    throw error
  } finally { await page.close() }
})

test("search shortcut, session changes and palette execution keep their own authority", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const search = page.locator('button[aria-controls^="session-search-"]')
    await page.keyboard.press("Control+f")
    await page.getByRole("searchbox").waitFor()
    assert.equal(await search.getAttribute("aria-expanded"), "true")
    await page.getByRole("searchbox").fill("fixture")
    await page.locator("#outside").click()
    assert.equal(await page.getByRole("searchbox").inputValue(), "fixture")
    await page.evaluate(() => (window as any).fixture.showInfo())
    await page.getByRole("searchbox").waitFor({ state: "hidden" })
    await page.locator('button[aria-controls^="command-palette-"]').click()
    const palette = page.locator('[role="dialog"][id^="command-palette-"]')
    await palette.waitFor()
    await palette.getByRole("textbox").fill("Fixture command")
    await page.keyboard.press("Enter")
    await palette.waitFor({ state: "hidden" })
    assert.equal(await page.evaluate(() => (window as any).fixture.executions()), 1)
  } finally { await page.close() }
})

test("compact touch controls can reopen their menu and explicitly toggle a persistent window", async () => {
  const context = await browser.newContext({ viewport: { width: 320, height: 900 }, hasTouch: true })
  const page = await context.newPage()
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const menu = page.locator(".session-header-actions-menu")
    // Exercise the real overflow controls independently of the shell's density
    // measurement (the fixture has no runtime status indicators).
    await page.addStyleTag({ content: ".session-header-expanded-actions { display: none !important; } .session-header-actions-menu.action-overflow-trigger { display: inline-flex !important; }" })
    for (const kind of ["command-palette", "session-search"]) {
      await menu.tap()
      const action = page.getByRole("menuitemcheckbox").nth(kind === "command-palette" ? 0 : 1)
      await action.tap()
      const panel = page.locator(`[role="dialog"][id^="${kind}-"]`)
      await panel.waitFor()
      await page.locator("#outside").tap()
      assert.equal(await panel.isVisible(), true)
      await menu.tap()
      await action.tap()
      await panel.waitFor({ state: "hidden" })
    }
  } finally { await context.close() }
})

test("utility windows remain visible and keyboard accessible in RTL", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.setLocale("he"))
    await page.waitForFunction(() => document.documentElement.dir === "rtl")
    for (const kind of ["command-palette", "session-search"]) {
      await page.locator(".session-header-actions-menu").click()
      await page.getByRole("menuitemcheckbox").nth(kind === "command-palette" ? 0 : 1).click()
      const panel = page.locator(`[role="dialog"][id^="${kind}-"]`)
      await panel.waitFor()
      const bounds = await panel.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 1800, `${kind} fits the viewport`)
      if (kind === "session-search") {
        const host = await page.locator(".session-center-column").boundingBox()
        assert.ok(host && bounds.x >= host.x && bounds.x + bounds.width <= host.x + host.width, "search is not clipped by the transcript")
      }
      await page.waitForFunction(({ id, selector }) => document.querySelector(`[id="${id}"] ${selector}`) === document.activeElement,
        { id: await panel.getAttribute("id"), selector: kind === "session-search" ? 'input[type="search"]' : "input" })
      if (process.env.CODENOMAD_HEADER_CAPTURE_DIR) await page.screenshot({ path: `${process.env.CODENOMAD_HEADER_CAPTURE_DIR}/${kind}-rtl.png` })
      await page.keyboard.press("Escape")
      await panel.waitFor({ state: "hidden" })
    }
  } finally { await page.close() }
})

test("Escape consumes only the top utility window before the global Stop shortcut", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.setWorking())
    await page.keyboard.press("Control+Shift+p")
    const palette = page.locator('[role="dialog"][id^="command-palette-"]')
    await palette.waitFor()
    await page.keyboard.press("Control+f")
    const search = page.getByRole("searchbox")
    await search.waitFor()
    await page.locator("#outside").click()
    await page.keyboard.press("Escape")
    await search.waitFor({ state: "hidden" })
    assert.equal(await palette.isVisible(), true, "one Escape must not dismiss both layers")
    await page.keyboard.press("Escape")
    await palette.waitFor({ state: "hidden" })
    assert.equal(await page.evaluate(() => (window as any).fixture.escapeStates().includes(true)), false)
    assert.equal(await page.evaluate(() => (window as any).fixture.interrupts()), 0)
    // After explicit window dismissal, the usual double-Escape still works.
    await page.keyboard.press("Escape")
    assert.equal(await page.evaluate(() => (window as any).fixture.escapeStates().at(-1)), true)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => (window as any).fixture.interrupts() === 1)
  } finally { await page.close() }
})

test("repeated palette shortcut refocuses its input without erasing the query or editing the composer", async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.keyboard.press("Control+Shift+p")
    const input = page.locator('[role="dialog"][id^="command-palette-"] input')
    await input.fill("Fixture")
    const composer = page.locator("textarea.prompt-input")
    await composer.fill("Draft to preserve")
    await page.keyboard.press("Control+Shift+p")
    await page.waitForFunction(() => document.activeElement?.matches('[id^="command-palette-"] input'))
    assert.equal(await input.inputValue(), "Fixture")
    await page.keyboard.press("End")
    await page.keyboard.type(" command")
    assert.equal(await input.inputValue(), "Fixture command")
    assert.equal(await composer.inputValue(), "Draft to preserve")
  } finally { await page.close() }
})
