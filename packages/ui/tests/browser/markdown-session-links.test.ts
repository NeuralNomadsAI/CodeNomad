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
    await page.click('#main-root a[href="./README.md"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "README.md")
    await page.click('#main-root a[href="docs/guide.md#intro"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "docs/guide.md")
    await page.click('#main-root a[href="/fixture-root/src/app.ts"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "src/app.ts")

    // A session living in a not-yet-inventoried worktree resolves against its
    // own directory, never the instance folder (the repository root).
    await page.click('#sub-root a[href="./README.md"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.targetFull()),
      { path: "README.md", directory: "/fixture-root/wt-a" })

    // An independently moved child keeps its own directory, never the parent's.
    await page.click('#child-root a[href="./README.md"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.targetFull()),
      { path: "README.md", directory: "/fixture-root/wt-b" })

    // Loopback routing: a plain click opens the session preview instead.
    await page.click('#main-root a[href="http://localhost:3000/x"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.previews()),
      [{ sessionId: "ses_link", url: "http://localhost:3000/x" }])
    const loopbackClick = await page.evaluate(() => (window as any).fixture.clicks().at(-1))
    assert.equal(loopbackClick.href, "http://localhost:3000/x")
    assert.equal(loopbackClick.prevented, true)

    // Not intercepted: escapes, external URLs and modified clicks keep default behavior.
    const clicksBefore = await page.evaluate(() => (window as any).fixture.clicks().length)
    const previewsBefore = await page.evaluate(() => (window as any).fixture.previews().length)
    await page.click('#main-root a[href="../outside.md"]')
    await page.click('#main-root a[href="https://example.com/x"]')
    await page.click('#main-root a[href="./README.md"]', { modifiers: ["Control"] })
    await page.click('#main-root a[href="http://localhost:3000/x"]', { modifiers: ["Control"] })
    await page.waitForFunction(count => (window as any).fixture.clicks().length === count, clicksBefore + 4)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.targetFull()),
      { path: "README.md", directory: "/fixture-root/wt-b" })
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

test("a populated but unmatched inventory never captures session links", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(`${url}?inventory=1`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.waitForFunction(() => (window as any).fixture.rendered() > 0)

    // The root inventory entry exists but holds neither session's directory.
    await page.click('#sub-root a[href="./README.md"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.targetFull()),
      { path: "README.md", directory: "/fixture-root/wt-a" })
    await page.click('#child-root a[href="./README.md"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.targetFull()),
      { path: "README.md", directory: "/fixture-root/wt-b" })

    // A session the inventory does contain still resolves through its entry.
    await page.click('#main-root a[href="./README.md"]')
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.targetFull()),
      { path: "README.md", directory: "/fixture-root" })
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})

test("session links retain backend availability, preview scope and revocation fences", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.waitForFunction(() => Boolean(document.querySelector('#remote-A a[href="http://localhost:3000/x"]')?.getAttribute("title")))
    assert.equal(await page.getAttribute('#remote-B a[href="http://localhost:3000/x"]', "title"), null)
    await page.click('#remote-B a[href="http://localhost:3000/x"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.clicks().at(-1).prevented), false)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.remoteCalls()), [])

    await page.click('#main-root a[href="http://localhost:3000/x"]')
    await page.click('#remote-A a[href="http://localhost:3000/x"]')
    await page.waitForFunction(() => (window as any).fixture.previewMode("A") === "preview")
    assert.equal(await page.evaluate(() => (window as any).fixture.previewMode("local")), "preview")
    await page.click('#remote-A a[href="./README.md"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.remoteTarget("A")), "README.md")
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), null)
    assert.equal(await page.evaluate(() => (window as any).fixture.previewMode("A")), "chat")
    assert.equal(await page.evaluate(() => (window as any).fixture.previewMode("local")), "preview")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.remoteCalls()), ["A"])

    await page.evaluate(() => (window as any).fixture.holdPreview())
    await page.click('#remote-A a[href="http://localhost:3000/x"]')
    await page.waitForFunction(() => (window as any).fixture.pending())
    await page.evaluate(() => { (window as any).fixture.detach("A"); (window as any).fixture.rejectPending() })
    await page.waitForFunction(() => !document.querySelector('#remote-A a[href="./README.md"]')?.hasAttribute("title"))
    await page.click('#remote-A a[href="./README.md"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.clicks().at(-1).prevented), false)
    assert.equal(await page.evaluate(() => (window as any).fixture.alert()), null)
    assert.equal(await page.evaluate(() => (window as any).fixture.previewMode("local")), "preview")
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})
