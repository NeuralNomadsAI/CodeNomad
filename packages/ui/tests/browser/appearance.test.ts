import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "appearance-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root" style="height:100vh"></div><script type="module" src="/tests/browser/fixtures/appearance.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

function merge(target: any, patch: any): any {
  const result = structuredClone(target)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = typeof value === "object" && !Array.isArray(value) ? merge(result[key] ?? {}, value) : value
  }
  return result
}
async function open(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: "en-US" })
  let state: any = {}
  await page.route("**/api/**", async route => {
    const request = route.request()
    if (request.url().includes("/storage/state/ui") && request.method() === "PATCH") state = merge(state, request.postDataJSON())
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(request.url().includes("/storage/state/ui") ? state : {}) })
  })
  try { await page.goto(url); await page.waitForFunction(() => Boolean((window as any).appearanceFixture)); await run(page) }
  finally { await page.close() }
}

test("mode filters a flat palette list and retains both choices across reload", async () => open(async page => {
  const picker = page.locator(".theme-scheme-picker")
  const mode = async (name: string) => {
    await page.locator(".theme-scheme-mode").getByRole("button", { name, exact: true }).click()
    await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>(".theme-scheme-picker")?.disabled)
  }
  await mode("Dark")
  await picker.selectOption("builtin:slate")
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "slate")
  assert.equal(await picker.locator('option[value="builtin:linen"]').count(), 0)
  assert.equal(await picker.locator('option[value="builtin:classic"]').textContent(), "Classic")
  assert.equal(await picker.locator("optgroup").count(), 0)
  await mode("Light")
  await picker.selectOption("builtin:linen")
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "linen")
  assert.equal(await picker.locator('option[value="builtin:slate"]').count(), 0)
  await mode("Dark")
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "slate")
  await mode("Auto")
  assert.equal(await page.locator(".theme-scheme-appearance-options").count(), 1)
  await page.emulateMedia({ colorScheme: "light" })
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "linen")
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".theme-scheme-picker")?.value === "builtin:linen")
  assert.equal(await picker.locator('option[value="builtin:slate"]').count(), 0)
  await page.emulateMedia({ colorScheme: "dark" })
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "slate")
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".theme-scheme-picker")?.value === "builtin:slate")
  assert.equal(await picker.locator('option[value="builtin:linen"]').count(), 0)
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "slate")
  await mode("Light")
  await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "linen")
}))

test("Classic and soft palettes preserve local subtle hover on messages, sessions and panels", async () => open(async page => {
  const ids = ["classic", "mist", "slate", "clay", "sage", "porcelain", "dawn", "parchment", "linen", "iris", "sage-light", "light", "basalt", "fjord", "lichen", "velvet", "ember"]
  const targets = [".tool-call-header", ".session-item-inactive", ".session-item-active", ".file-list-item", ".file-list-item-active", ".file-viewer-toolbar-icon-button", ".git-change-section-header", ".status-process-card", ".right-panel-accordion-header-row", '.settings-nav-button[data-selected="true"]', ".right-panel-tab-active", ".right-panel-tab-inactive"]
  const output = process.env.CODENOMAD_PALETTE_SCREENSHOTS
  if (output) await mkdir(output, { recursive: true })
  for (const id of ids) {
    await page.evaluate(id => (window as any).appearanceFixture.apply(id), id)
    await page.mouse.move(1599, 1099)
    await page.waitForTimeout(220)
    const surfaces = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement)
      return Object.fromEntries(["--surface-base", "--surface-secondary", "--surface-code", "--message-assistant-bg", "--message-tool-bg"].map(k => [k, css.getPropertyValue(k)]))
    })
    assert.equal(surfaces["--surface-code"], id === "light" ? "#F1F5F9" : surfaces["--surface-base"], id)
    assert.equal(surfaces["--message-tool-bg"], surfaces["--message-assistant-bg"], id)
    assert.notEqual(surfaces["--message-tool-bg"], surfaces["--surface-secondary"], id)
    assert.equal(await page.locator(".settings-screen-content").evaluate(e => getComputedStyle(e).backgroundColor), await page.locator(".session-sidebar").evaluate(e => getComputedStyle(e).backgroundColor), id)
    for (const selector of targets) {
      const element = page.locator(selector).first()
      await page.mouse.move(1599, 1099); await page.waitForTimeout(220)
      const idle = await element.evaluate(e => [getComputedStyle(e).backgroundColor, getComputedStyle(e).backgroundImage])
      await element.hover(); await page.waitForTimeout(220)
      const hovered = await element.evaluate(e => [getComputedStyle(e).backgroundColor, getComputedStyle(e).backgroundImage])
      assert.notDeepEqual(hovered, idle, `${id} ${selector}: hover must remain visible`)
      if (selector === ".session-item-active" || selector === ".file-list-item-active" || selector.includes("data-selected") || selector.startsWith(".right-panel-tab")) {
        assert.equal(hovered[0], idle[0], `${id} ${selector}: keep the original selected/tab surface`)
      }
      // Each row uses the same translucent 4% layer on its own resting surface,
      // including selected rows (whose selection color must not disappear).
      assert.match(hovered.join(" "), /0\.04/, `${id} ${selector}: local 4% overlay`)
    }
    if (output) await page.screenshot({ path: `${output}/${id}.png` })
  }
}))
