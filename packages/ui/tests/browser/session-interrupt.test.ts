import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { applyMergePatch } from "../../../server/src/settings/merge-patch"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "interrupt-fixture", configureServer(s) {
        s.middlewares.use("/interrupt-fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/interrupt-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-interrupt.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/interrupt-fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

for (const gesture of ["button", "double Escape"] as const) {
  test(`${gesture} interrupts only the selected session using the TUI request`, async () => {
    const page = await browser.newPage({ locale: "en-US" })
    const requests: string[] = [], errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith("/interrupt")) {
        requests.push(url.pathname + url.search)
        return route.fulfill({ json: { interrupted: true } })
      }
      return route.fulfill({ json: {} })
    })
    try {
      await page.goto(url)
      await page.waitForFunction(() => Boolean((window as any).fixture))
      for (const id of ["ses_parent", "ses_child"]) {
        await page.evaluate(id => (window as any).fixture.select(id), id)
        const response = page.waitForResponse(response => response.url().includes(`/api/session/${id}/interrupt`))
        if (gesture === "button") await page.getByRole("button", { name: "Stop session", exact: true }).click()
        else {
          await page.locator("textarea").first().focus()
          await page.keyboard.press("Escape")
          assert.equal(requests.length, id === "ses_parent" ? 0 : 1)
          await page.keyboard.press("Escape")
        }
        await response
      }
      assert.deepEqual(requests, ["ses_parent", "ses_child"].map(id => `/workspaces/interrupt-instance/instance/api/session/${id}/interrupt?resume=true`))
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

for (const rebound of [false, true]) {
  test(`home Escape dismissal stays separate from ${rebound ? "rebound" : "default"} session abort and respects nested dialogs`, async () => {
    const page = await browser.newPage({ locale: "en-US" })
    const interrupts: string[] = [], errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    let config = { settings: { locale: "en" } }
    await page.route("**/api/**", route => {
      if (new URL(route.request().url()).pathname === "/api/storage/config/ui") {
        if (route.request().method() === "PATCH") config = applyMergePatch(config, route.request().postDataJSON())
        return route.fulfill({ json: config })
      }
      if (route.request().url().includes("/interrupt")) interrupts.push(route.request().url())
      return route.fulfill({ json: {} })
    })
    try {
      await page.goto(url)
      await page.waitForFunction(() => Boolean((window as any).fixture))
      const abortKey = rebound ? "Control+Alt+k" : "Escape"
      if (rebound) assert.equal(await page.evaluate(() => (window as any).fixture.setPreferences({ hotkeyOverrides: { "session-abort": [{ key: "k", mod: true, alt: true }] } })), true)
      await page.keyboard.press(abortKey)
      assert.deepEqual(interrupts, [], "one session press only arms abort")
      await page.keyboard.press("Control+n")
      await page.locator(".folder-home-root").waitFor()
      if (rebound) {
        await page.keyboard.press(abortKey)
        await page.keyboard.press(abortKey)
        assert.equal(await page.locator(".folder-home-root").count(), 1, "custom abort never dismisses home")
      }
      await page.evaluate(() => (window as any).fixture.setRecording(true))
      await page.keyboard.press("Escape")
      await page.keyboard.press("Escape")
      await page.evaluate(() => (window as any).fixture.setRecording(false))
      for (const event of [{ key: "Escape", isComposing: true }, { key: "Escape", keyCode: 229 }, { key: "Escape", ctrlKey: true }]) {
        await page.locator(".folder-home-root").dispatchEvent("keydown", event)
      }
      await page.evaluate(() => {
        document.addEventListener("keydown", event => event.preventDefault(), { once: true })
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      })
      await page.keyboard.press("Escape")
      assert.equal(await page.locator(".folder-home-root").count(), 1, "first Escape only arms home dismissal")
      await page.locator(".folder-home-root").dispatchEvent("keydown", { key: "Escape", repeat: true })
      assert.equal(await page.locator(".folder-home-root").count(), 1, "holding Escape never confirms dismissal")
      await page.keyboard.press("Escape")
      assert.equal(await page.locator(".folder-home-root").count(), 0)
      assert.equal(await page.locator("textarea.prompt-input").count(), 1, "existing project composer returns")
      assert.equal(await page.evaluate(() => (window as any).fixture.selected()), "ses_parent")
      assert.deepEqual(interrupts, [], "home dismissal never aborts the hidden session")

      await page.keyboard.press("Control+n")
      await page.locator(".folder-home-root").waitFor()
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "Clone Git Repo", exact: true }).click()
      await page.getByRole("dialog").waitFor()
      await page.keyboard.press("Escape")
      await page.getByRole("dialog").waitFor({ state: "hidden" })
      assert.equal(await page.locator(".folder-home-root").count(), 1, "nested dialog owns its Escape")
      await page.keyboard.press("Escape")
      assert.equal(await page.locator(".folder-home-root").count(), 1, "nested dismissal clears the previous home confirmation")
      await page.keyboard.press("Escape")
      assert.equal(await page.locator(".folder-home-root").count(), 0)
      assert.deepEqual(interrupts, [])

      await page.evaluate(() => (window as any).fixture.select("info"))
      await page.keyboard.press("Control+n")
      await page.locator(".folder-home-root").waitFor()
      await page.keyboard.press("Escape")
      assert.equal(await page.locator(".folder-home-root").count(), 1, "home dismissal does not require an active conversation")
      await page.keyboard.press("Escape")
      assert.equal(await page.locator(".folder-home-root").count(), 0)
      await page.evaluate(() => (window as any).fixture.select("ses_parent"))
      await page.locator("textarea.prompt-input").focus()
      await page.keyboard.press(abortKey)
      assert.deepEqual(interrupts, [], "home presses do not prime session abort")
      const response = page.waitForResponse(response => response.url().includes("/api/session/ses_parent/interrupt"))
      await page.keyboard.press(abortKey)
      await response
      assert.equal(interrupts.length, 1, "selected-session abort retains its configured binding")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}
