import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, webkit, type Browser } from "playwright"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "session-delete",
      routes: [
        { path: "/fixture", html: "<html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/header-windows.tsx\"></script></body></html>" },
      ],
    })
  try {
    url = fixture.url
    browser = await (process.env.CODENOMAD_TEST_BROWSER === "webkit" ? webkit : chromium)
      .launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { throw error }
})
after(async () => { try { await browser?.close() } finally { } })

for (const { touch, width, name } of [
  { touch: true, width: 390, name: "phone tap" },
  { touch: false, width: 390, name: "narrow window mouse" },
  { touch: false, width: 1400, name: "desktop mouse" },
]) {
  test(`session overflow Delete requires confirmation then removes the session (${name})`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 850 },
      hasTouch: touch, isMobile: touch, locale: "en-US" })
    const page = await context.newPage()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    // The fixture owns its session client; no real event stream may reconcile it.
    await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} } as any })
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    try {
      await page.goto(url)
      await page.waitForFunction(() => Boolean((window as any).fixture))
      const sessionId = "a-long-session-title-that-needs-the-action-overflow-menu"
      await page.evaluate(id => {
        ;(window as any).fixture.addSession(id)
        ;(window as any).fixture.selectSession(id)
      }, sessionId)
      const activate = async (locator: ReturnType<typeof page.locator>) => touch ? locator.tap() : locator.click()
      const leftToggle = page.locator(".shell-panel-toggle--left button")
      if (await leftToggle.getAttribute("aria-expanded") === "false") await activate(leftToggle)
      const row = page.locator(`.session-item-base[data-session-id="${sessionId}"]`)
      await row.waitFor()
      const openDelete = async () => {
        if (!touch) await row.hover()
        await activate(row.locator(".action-overflow-trigger"))
        await activate(page.getByRole("menuitem", { name: "Delete session", exact: true }))
        await page.getByRole("dialog", { name: "Delete session", exact: true }).waitFor({ timeout: 5000 })
        assert.deepEqual(await page.evaluate(() => (window as any).fixture.deletedSessions), [], "opening the dialog is not consent")
      }

      await openDelete()
      await activate(page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }))
      await page.getByRole("dialog").waitFor({ state: "detached" })
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.deletedSessions), [])
      assert.equal(await row.count(), 1)

      if (width === 390) {
        // Ordinary outside gestures still close the floating panel.
        const outside = (await page.locator("#outside").boundingBox())!
        if (touch) await page.touchscreen.tap(outside.x + 5, outside.y + 5)
        else await page.mouse.click(outside.x + 5, outside.y + 5)
        await page.waitForFunction(() => document.querySelector('.shell-panel-toggle--left button')?.getAttribute("aria-expanded") === "false")
        await activate(leftToggle)
      }

      await openDelete()
      await activate(page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }))
      await page.waitForFunction(() => (window as any).fixture.deletedSessions.length === 1)
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.deletedSessions), [sessionId])
      await row.waitFor({ state: "detached" })
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })
}
