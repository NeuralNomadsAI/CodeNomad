import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type Browser } from "playwright"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "markdown-session-links",
      routes: [
        { path: "/markdown-session-links", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/markdown-session-links.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("session links route to the preview and the file reader", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.waitForFunction(() => (window as any).fixture.rendered() > 0)

    // Project-file routing: each plain click opens the file reader on the resolved path.
    await page.click('a[href="./README.md"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "README.md")
    await page.click('a[href="docs/guide.md#intro"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "docs/guide.md")
    await page.click('a[href="/fixture-root/src/app.ts"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "src/app.ts")

    // Loopback routing: a plain click opens the session preview instead.
    await page.click('a[href="http://localhost:3000/x"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.previews()),
      [{ sessionId: "ses_link", url: "http://localhost:3000/x" }])
    const loopbackClick = await page.evaluate(() => (window as any).fixture.clicks().at(-1))
    assert.equal(loopbackClick.href, "http://localhost:3000/x")
    assert.equal(loopbackClick.prevented, true)

    // Not intercepted: escapes, external URLs and modified clicks keep default behavior.
    const clicksBefore = await page.evaluate(() => (window as any).fixture.clicks().length)
    const previewsBefore = await page.evaluate(() => (window as any).fixture.previews().length)
    await page.click('a[href="../outside.md"]')
    await page.click('a[href="https://example.com/x"]')
    await page.click('a[href="./README.md"]', { modifiers: ["Control"] })
    await page.click('a[href="http://localhost:3000/x"]', { modifiers: ["Control"] })
    await page.waitForFunction(count => (window as any).fixture.clicks().length === count, clicksBefore + 4)
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "src/app.ts")
    assert.equal(await page.evaluate(() => (window as any).fixture.previews().length), previewsBefore)
    for (const click of await page.evaluate(() => (window as any).fixture.clicks().slice(-4))) {
      assert.equal(click.prevented, false, click.href)
    }

    // Decoration: intercepted anchors carry a hint; untouched anchors keep none.
    await page.waitForFunction(() => {
      const loop = document.querySelector('a[href="http://localhost:3000/x"]')?.getAttribute("title")
      const file = document.querySelector('a[href="./README.md"]')?.getAttribute("title")
      return Boolean(loop && file)
    })
    assert.equal(await page.evaluate(() => (window as any).fixture.title('a[href="http://localhost:3000/x"]')),
      await page.evaluate(() => (window as any).fixture.label("markdown.link.previewOpens")))
    assert.equal(await page.evaluate(() => (window as any).fixture.title('a[href="./README.md"]')),
      await page.evaluate(() => (window as any).fixture.label("markdown.link.fileOpens")))
    assert.equal(await page.evaluate(() => (window as any).fixture.title('a[href="https://example.com/x"]')), null)
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})
