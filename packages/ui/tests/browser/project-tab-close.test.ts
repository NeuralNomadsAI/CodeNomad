import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  const fixture = await borrowFixture({
      name: "project-tab-close",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/project-tab-close.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await cache?.dispose() })

for (const gesture of ["click", "Control+w", "Meta+w"] as const) {
  test(`real project tabs close immediately and delete only their occurrence (${gesture})`, async () => {
    const page = await browser.newPage({ locale: "en-US" })
    const errors: string[] = [], deletes: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.addInitScript(mac => {
      Object.defineProperty(navigator, "platform", { value: mac ? "MacIntel" : "Win32" })
      ;(window as any).__CODENOMAD_RUNTIME_HOST__ = "electron"
      ;(window as any).__CODENOMAD_WINDOW_CONTEXT__ = "local"
      ;(window as any).EventSource = class extends EventTarget { close() {} }
    }, gesture === "Meta+w")
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route("**/api/**", async route => {
      if (route.request().method() === "DELETE") {
        deletes.push(new URL(route.request().url()).pathname)
        await held
      }
      await route.fulfill({ json: {} })
    })
    try {
      await page.goto(url)
      const second = page.getByRole("tab").filter({ hasText: "second" })
      const first = page.getByRole("tab").filter({ hasText: "first" })
      await second.waitFor()
      const deleted = page.waitForRequest(request => request.method() === "DELETE")
      if (gesture === "click") await second.locator(".tab-close").click()
      else await page.keyboard.press(gesture)
      await second.waitFor({ state: "detached" })
      await deleted
      assert.deepEqual(deletes, ["/api/workspaces/second"])
      assert.equal(await first.getAttribute("aria-selected"), "true")
      assert.deepEqual(await page.evaluate(() => (window as any).closeFixture.records()), ["first", "second"])
      await page.evaluate(() => (window as any).closeFixture.stopped("second"))
      release()
      assert.deepEqual(await page.evaluate(() => (window as any).closeFixture.history()), [])
      await page.evaluate(() => (window as any).closeFixture.stopped("first"))
      assert.equal(await page.getByRole("tab").count(), 0)
      assert.equal(await page.evaluate(() => (window as any).closeFixture.history()[0].message),
        "first was closed from another window.")
      assert.deepEqual(errors, [])
    } catch (error) {
      console.error({ errors, body: await page.locator("body").innerText() })
      throw error
    } finally { release(); await page.close() }
  })
}
