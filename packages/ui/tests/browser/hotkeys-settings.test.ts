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
      configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "hotkeys-settings-fixture", configureServer(s) {
        s.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/fixture", '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/hotkeys-settings.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] },
      optimizeDeps: { entries: ["tests/browser/fixtures/hotkeys-settings.tsx"], exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
}, { timeout: 60000 })
after(async () => { try { await browser?.close() } finally { await server?.close() } })

const row = (page: Page, id: string) => page.locator(`[data-hotkey-id="${id}"]`)
async function open(mac = false) {
  const context = await browser.newContext()
  const page = await context.newPage(), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  if (mac) await page.addInitScript(() => Object.defineProperty(navigator, "platform", { value: "MacIntel" }))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { context, page, errors }
}
async function bind(page: Page, id: string, keys: string) {
  await row(page, id).getByRole("button", { name: "Edit", exact: true }).click()
  const input = row(page, id).getByRole("textbox")
  await input.waitFor()
  await input.press(keys)
  await page.waitForFunction(() => !(window as any).fixture.isRecording())
  await page.waitForFunction(() => !document.querySelector(".hotkeys-toolbar button:disabled"))
}
async function trigger(page: Page, keys: string) {
  await page.locator("#outside").focus()
  await page.keyboard.press(keys)
}

test("rebinds the real dispatcher, updates tooltips, persists and resets with deletion patches", async () => {
  const { context, page, errors } = await open()
  try {
    assert.equal(await page.locator("#outside").getAttribute("title"), "Ctrl+N")
    await trigger(page, "Control+n")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 1)
    await bind(page, "new-instance", "Control+Alt+y")
    assert.equal(await page.locator("#outside").getAttribute("title"), "Ctrl+Alt+Y")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 1, "recording never runs app shortcuts")
    await trigger(page, "Control+n")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 1, "old binding is inert")
    await trigger(page, "Control+Alt+y")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 2)
    const config = await page.evaluate(() => (window as any).fixture.config())
    assert.deepEqual(config.settings.hotkeyOverrides["new-instance"], [{ key: "y", mod: true, alt: true }])
    assert.equal(config.settings.unrelated, "kept")
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.locator("#outside").getAttribute("title"), "Ctrl+Alt+Y")
    await row(page, "new-instance").getByRole("button", { name: "Reset", exact: true }).click()
    await page.waitForFunction(() => document.querySelector("#outside")?.getAttribute("title") === "Ctrl+N")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.patches().at(-1)), { settings: { hotkeyOverrides: { "new-instance": null } } })
    await trigger(page, "Control+Alt+y")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 0)
    await trigger(page, "Control+n")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 1)
    await bind(page, "focus-input", "Control+Alt+i")
    await trigger(page, "Control+p")
    assert.equal(await page.locator("#outside").evaluate(element => document.activeElement === element), true)
    await trigger(page, "Control+Alt+i")
    assert.equal(await page.getByRole("textbox", { name: "Prompt", exact: true }).evaluate(element => document.activeElement === element), true)
    await row(page, "new-instance").getByRole("button", { name: "Disable", exact: true }).click()
    await page.waitForFunction(() => document.querySelector("#outside")?.getAttribute("title") === "")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.config().settings.hotkeyOverrides["new-instance"]), [])
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.locator("#outside").getAttribute("title"), "", "disabled binding survives reload")
    await trigger(page, "Control+n")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 0)
    await page.getByRole("button", { name: "Reset all", exact: true }).click()
    await page.waitForFunction(() => document.querySelector("#outside")?.getAttribute("title") === "Ctrl+N")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.patches().at(-1)), { settings: { hotkeyOverrides: null } })
    assert.equal(await page.evaluate(() => (window as any).fixture.config().settings.hotkeyOverrides), undefined)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("warns on both conflicting actions, ignores composition/modifier keys and releases recording", async () => {
  const { context, page, errors } = await open()
  try {
    await bind(page, "new-instance", "Control+p")
    assert.match(await row(page, "new-instance").getByRole("status").innerText(), /Focus prompt/)
    assert.match(await row(page, "focus-input").getByRole("status").innerText(), /New instance/)
    await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).click()
    const input = row(page, "new-instance").getByRole("textbox")
    await input.focus()
    for (const event of [{ key: "Dead" }, { key: "Unidentified" }, { key: "Process" }, { key: "Control", ctrlKey: true }, { key: "y", ctrlKey: true, isComposing: true }]) {
      await input.dispatchEvent("keydown", event)
    }
    assert.equal(await page.evaluate(() => (window as any).fixture.isRecording()), true)
    assert.equal(await page.evaluate(() => (window as any).fixture.patches().length), 1)
    await input.press("Tab")
    assert.equal(await page.evaluate(() => (window as any).fixture.isRecording()), false, "Tab navigates away without a focus trap")
    await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).click()
    await row(page, "new-instance").getByRole("button", { name: "Cancel", exact: true }).dispatchEvent("click")
    assert.equal(await page.evaluate(() => (window as any).fixture.isRecording()), false)
    await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).click()
    await page.evaluate(() => window.dispatchEvent(new Event("blur")))
    assert.equal(await page.evaluate(() => (window as any).fixture.isRecording()), false, "window blur releases renderer recording")
    await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).click()
    await row(page, "new-instance").getByRole("textbox").dispatchEvent("keydown", { key: "Tab", code: "Tab", ctrlKey: true })
    await page.waitForFunction(() => !(window as any).fixture.isRecording() && !document.querySelector(".hotkeys-toolbar button:disabled"))
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.config().settings.hotkeyOverrides["new-instance"]), [{ key: "tab", mod: true }])
    await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).click()
    await page.evaluate(() => (window as any).fixture.setVisible(false))
    assert.equal(await page.evaluate(() => (window as any).fixture.isRecording()), false, "disposal releases global suppression")
    await page.evaluate(() => (window as any).fixture.setVisible(true))
    await page.getByRole("searchbox", { name: "Filter shortcuts" }).fill("App tab 9")
    assert.equal(await page.locator(".hotkeys-row").count(), 1)
    assert.equal(await row(page, "app-tab-9").count(), 1, "static numbered catalog works without app registration")
    await page.getByRole("searchbox", { name: "Filter shortcuts" }).fill("New instance")
    await page.evaluate(() => (window as any).fixture.failSave(true))
    await bind(page, "new-instance", "Control+Alt+y")
    assert.match(await page.getByRole("alert").innerText(), /Could not save/)
    assert.equal(await page.locator("#outside").getAttribute("title"), "Ctrl+Tab", "failed writes retain old binding")
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("captures portable Mod on macOS and keeps narrow settings controls square and reachable", async () => {
  const { context, page, errors } = await open(true)
  try {
    assert.equal(await page.locator("#outside").getAttribute("title"), "⌘+N")
    await bind(page, "new-instance", "Meta+Alt+y")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.config().settings.hotkeyOverrides["new-instance"]), [{ key: "y", mod: true, alt: true }])
    assert.equal(await page.locator("#outside").getAttribute("title"), "⌘+⌥+Y")
    await trigger(page, "Meta+Alt+y")
    assert.equal(await page.evaluate(() => (window as any).fixture.newInstances()), 1)
    await page.setViewportSize({ width: 390, height: 600 })
    await page.getByRole("searchbox", { name: "Filter shortcuts" }).fill("New instance")
    assert.equal(await page.locator(".hotkeys-settings").evaluate(element => element.scrollWidth <= element.clientWidth), true)
    assert.equal(await row(page, "new-instance").getByRole("button", { name: "Edit", exact: true }).evaluate(element => getComputedStyle(element).borderRadius), "0px")
    await row(page, "new-instance").getByRole("button", { name: "Disable", exact: true }).click()
    await page.waitForFunction(() => document.querySelector("#outside")?.getAttribute("title") === "")
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

for (const [layout, key, code, physical, other] of [
  ["AZERTY", "&", "Digit1", "1", "app-tab-1"],
  ["QWERTZ", "ü", "BracketLeft", "[", "instance-prev"],
]) test(`records ${layout} physical identity, warns on both rows and dispatches the recorded binding`, async () => {
  const { context, page, errors } = await open()
  try {
    await row(page, "focus-input").getByRole("button", { name: "Edit", exact: true }).click()
    const input = row(page, "focus-input").getByRole("textbox")
    await input.waitFor()
    await input.dispatchEvent("keydown", { key, code, ctrlKey: true })
    await page.waitForFunction(() => !(window as any).fixture.isRecording() && !document.querySelector(".hotkeys-toolbar button:disabled"))
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.config().settings.hotkeyOverrides["focus-input"]), [{ key: physical, mod: true }])
    assert.match(await row(page, "focus-input").getByRole("status").innerText(), /also assigned to/)
    assert.match(await row(page, other).getByRole("status").innerText(), /Focus prompt/)
    // Conflicts are advisory, not a silent disable. Remove the competing action
    // explicitly so its dispatcher priority cannot obscure the captured action.
    await row(page, other).getByRole("button", { name: "Disable", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector(".hotkeys-toolbar button:disabled"))
    assert.equal(await row(page, "focus-input").getByRole("status").count(), 0)
    await page.locator("#outside").focus()
    await page.locator("#outside").dispatchEvent("keydown", { key, code, ctrlKey: true })
    assert.equal(await page.getByRole("textbox", { name: "Prompt", exact: true }).evaluate(element => document.activeElement === element), true)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
