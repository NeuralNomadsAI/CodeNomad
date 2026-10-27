import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type Browser, type Page } from "playwright"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "markdown-loopback-link",
      routes: [
        { path: "/markdown-loopback-link-fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/markdown-loopback-link.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

const created = (page: Page) => page.evaluate(() => (window as any).fixture.created()) as Promise<Array<{ sessionId: string; url: string }>>

test("loopback link clicks open the session preview only once availability is known", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    const loopback = page.locator('#markdown-root a[href="http://localhost:3000/"]')
    await loopback.waitFor()

    // Before the server meta answers, availability is unknown: links keep
    // their default behavior, so Remote Control with previews off never
    // opens a dead preview.
    await loopback.click()
    assert.deepEqual(await created(page), [])

    await page.evaluate(() => (window as any).fixture.resolvePreviewsAvailable())

    // The escape hatch is discoverable on intercepted links only; an
    // author-provided title wins and non-loopback links stay untouched.
    assert.match(await loopback.getAttribute("title"), /web preview/)
    assert.equal(await page.locator('#markdown-root a[href="https://example.com/"]').getAttribute("title"), null)
    assert.equal(await page.locator('#markdown-root a[href="https://127.example.com/"]').getAttribute("title"), null)
    assert.equal(await page.locator('#markdown-root a[href="http://localhost:9998/"]').getAttribute("title"), "Custom title")

    await loopback.click()
    assert.deepEqual(await created(page), [{ sessionId: "session-link", url: "http://localhost:3000/" }])

    // External, modifier, middle-button and non-loopback-IPv4 clicks keep
    // browser defaults. Firefox fires `click` for the middle button, so the
    // Firefox behavior is reproduced with a synthetic button=1 click.
    await page.locator('#markdown-root a[href="https://example.com/"]').click()
    await page.locator('#markdown-root a[href="http://localhost:9999/"]').click({ modifiers: ["Meta"] })
    await page.locator('#markdown-root a[href="http://localhost:9999/"]').evaluate((anchor) => {
      anchor.dispatchEvent(new MouseEvent("click", { button: 1, bubbles: true, cancelable: true }))
    })
    await page.locator('#markdown-root a[href="https://127.example.com/"]').click()
    assert.deepEqual(await created(page), [{ sessionId: "session-link", url: "http://localhost:3000/" }])

    // Through Remote Control with the host's web previews off, loopback
    // links keep their default browser behavior and our tooltip clears
    // without touching an author's title.
    await page.evaluate(() => (window as any).fixture.setPreviewsUnavailable())
    await page.waitForFunction(() => (document.querySelector('#markdown-root a[href="http://localhost:3000/"]') as HTMLAnchorElement).title === "")
    assert.equal(await page.locator('#markdown-root a[href="http://localhost:9998/"]').getAttribute("title"), "Custom title")
    await page.locator('#markdown-root a[href="http://localhost:9999/"]').click()
    assert.deepEqual(await created(page), [{ sessionId: "session-link", url: "http://localhost:3000/" }])
  } finally {
    await page.close()
  }
})
