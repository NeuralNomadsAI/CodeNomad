import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type Browser } from "playwright"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "markdown-bare-paths",
    routes: [
      { path: "/markdown-bare-paths", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/markdown-bare-paths.tsx\"></script></body></html>" },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("bare paths link exactly the files that exist", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.waitForFunction(() => (window as any).fixture.rendered() > 0)

    // Existing files convert: prose, bare file name, absolute-inside-root and CJK-adjacent.
    await page.waitForFunction(() => (window as any).fixture.count("src/app.ts") === 2)
    await page.waitForFunction(() => (window as any).fixture.count("README.md") === 1)
    await page.waitForFunction(() => (window as any).fixture.count("/fixture-root/README.md") === 1)

    // Missing files, directories, worktree escapes and prose false positives never convert.
    assert.equal(await page.evaluate(() => (window as any).fixture.count("src/gone.ts")), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("src/inner")), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("/etc/passwd")), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("and/or")), 0)

    // The hand-written markdown link keeps its own anchor; code spans gain none.
    assert.equal(await page.evaluate(() => (window as any).fixture.count("./README.md")), 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.codeLinks()), 0)

    // Wrapped anchors route like hand-written ones and carry the same hint.
    await page.click('#main-root a[href="src/app.ts"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "src/app.ts")
    await page.click('#main-root a[href="README.md"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "README.md")
    assert.equal(await page.evaluate(() => (window as any).fixture.title("README.md")),
      await page.evaluate(() => (window as any).fixture.label("markdown.link.fileOpens")))
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})

test("on the local desktop, bare folder paths link too", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript("window.electronAPI = { openLocalPath: async () => ({ opened: true }) }")
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).fixture?.count("src/inner") === 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.title("src/inner")),
      `/fixture-root/src/inner\n${await page.evaluate(() => (window as any).fixture.label("markdown.link.pathOpens"))}`)
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})

test("a listing that resolves after a re-render wraps the new DOM only", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(`${url}?held=1`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.waitForFunction(() => (window as any).fixture.rendered() > 0)

    // Re-render while the first pass's listing is still held.
    const initial = await page.evaluate(() => (window as any).fixture.initialText)
    await page.evaluate(text => (window as any).fixture.rerender(`${text}\n\nAnother look at src/app.ts.`), initial)
    await page.waitForFunction(() => (window as any).fixture.rendered() > 1)
    await page.evaluate(() => (window as any).fixture.release())

    // The replaced DOM gets its links; the detached first pass stays silent.
    await page.waitForFunction(() => (window as any).fixture.count("src/app.ts") === 3)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("src/gone.ts")), 0)
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})

test("a file that appears later converts once the cache revalidates", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.waitForFunction(() => (window as any).fixture.count("src/app.ts") === 2)

    await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.addGone()
      fixture.clearCache()
      fixture.rerender(`${fixture.initialText}\n\nStill missing: src/gone.ts.`)
    })
    // The initial text already mentions src/gone.ts once; the suffix adds a
    // second mention, and both convert once the fresh listing admits it.
    await page.waitForFunction(() => (window as any).fixture.count("src/gone.ts") === 2)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("src/app.ts")), 2)
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})
