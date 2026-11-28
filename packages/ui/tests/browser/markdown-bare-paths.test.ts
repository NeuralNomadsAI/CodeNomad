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
    await page.waitForFunction(() => (window as any).fixture.count("src/app.ts") === 4)
    await page.waitForFunction(() => (window as any).fixture.count("README.md") === 3)
    await page.waitForFunction(() => (window as any).fixture.count("/fixture-root/README.md") === 2)

    // An inline code span converts as one exact, unambiguous path candidate:
    // its whole content, including CJK letters and hyphen-glued segments.
    // A prose path whose file name contains CJK letters links as one whole
    // path, a bare CJK file name converts too, a connector glued between two
    // paths falls back to linking both, and both-edges tokens made of
    // segments (`脚本/启动`, `项目/v2/启动`) read as one path.
    await page.waitForFunction(() => (window as any).fixture.count("docs/算法工作台MVP-design.md") === 2)
    await page.waitForFunction(() => (window as any).fixture.count("设计.md") === 1)
    await page.waitForFunction(() => (window as any).fixture.count("脚本/启动") === 1)
    await page.waitForFunction(() => (window as any).fixture.count("项目/v2/启动") === 1)
    await page.waitForFunction(() => (window as any).fixture.count("前端-v2/run-测试") === 1)

    // A missing span, a URL-shaped span, a fragment-bearing span and a
    // percent-escaped span never link — not even a same-named local file that
    // exists (`README.md` at the root, `docs/issue` and `docs/算.md` in the
    // docs directory). A URL with a non-ASCII path stays whole in prose too:
    // its rejected span never falls back to a suffix piece, so the root
    // README.md count above is unchanged.
    assert.equal(await page.evaluate(() => (window as any).fixture.count("docs/不存在README.md")), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("docs/issue#42.md")), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("docs/%E7%AE%97.md")), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("README.md")), 3)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("docs/issue")), 0)

    // Missing files, directories, worktree escapes and prose false positives never convert.
    assert.equal(await page.evaluate(() => (window as any).fixture.count("src/gone.ts")), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("src/inner")), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("/etc/passwd")), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("and/or")), 0)

    // The hand-written markdown link keeps its own anchor; inline code gains
    // a link while fenced code blocks stay plain text.
    assert.equal(await page.evaluate(() => (window as any).fixture.count("./README.md")), 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.codeLinks()), 3)
    assert.equal(await page.locator("#main-root pre a").count(), 0)

    // Wrapped anchors route like hand-written ones and carry the same hint,
    // including the ones wrapped inside inline code. The hint comparison
    // waits for the locale to settle: the provider flips from the default
    // once the environment locale loads, and the decoration pass follows.
    await page.click('#main-root a[href="src/app.ts"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "src/app.ts")
    await page.click('#main-root code a[href="src/app.ts"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "src/app.ts")
    await page.click('#main-root a[href="README.md"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "README.md")
    await page.click('#main-root a:not(code a)[href="docs/算法工作台MVP-design.md"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "docs/算法工作台MVP-design.md")
    await page.click('#main-root a[href="脚本/启动"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "脚本/启动")
    await page.click('#main-root code a[href="docs/算法工作台MVP-design.md"]')
    assert.equal(await page.evaluate(() => (window as any).fixture.target()), "docs/算法工作台MVP-design.md")
    assert.equal(await page.locator('#main-root code a[href="docs/算法工作台MVP-design.md"]').textContent(), "./docs/算法工作台MVP-design.md")
    await page.waitForFunction(() => {
      const anchor = document.querySelector(`#main-root a[href="${CSS.escape("README.md")}"]`)
      return anchor?.getAttribute("title") === (window as any).fixture.label("markdown.link.fileOpens")
    })
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})

test("on the local desktop, bare folder paths link too", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript("window.electronAPI = { openLocalPath: async () => ({ result: 'opened' }) }")
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).fixture?.count("src/inner") === 1)
    // The title comparison waits for the locale to settle rather than
    // sampling the label and the decoration at one possibly-racing instant.
    await page.waitForFunction(() => {
      const anchor = document.querySelector(`#main-root a[href="${CSS.escape("src/inner")}"]`)
      return anchor?.getAttribute("title") ===
        `/fixture-root/src/inner\n${(window as any).fixture.label("markdown.link.pathOpens")}`
    })
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
    await page.waitForFunction(() => (window as any).fixture.count("src/app.ts") === 5)
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
    await page.waitForFunction(() => (window as any).fixture.count("src/app.ts") === 4)

    await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.addGone()
      fixture.clearCache()
      fixture.rerender(`${fixture.initialText}\n\nStill missing: src/gone.ts.`)
    })
    // The initial text already mentions src/gone.ts once; the suffix adds a
    // second mention, and both convert once the fresh listing admits it.
    await page.waitForFunction(() => (window as any).fixture.count("src/gone.ts") === 2)
    assert.equal(await page.evaluate(() => (window as any).fixture.count("src/app.ts")), 4)
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})

test("a glued run of paths cannot multiply directory reads past the cap", { timeout: 60_000 }, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.waitForFunction(() => (window as any).fixture.count("src/app.ts") === 4)

    // Two hundred paths glued into one token by a CJK connector: the warm
    // pass may read at most BARE_PATH_MAX_CANDIDATES directories — the
    // integral probe plus boundary pieces each name one file lookup — so the
    // cap bounds reads, not just tokens.
    const before = await page.evaluate(() => (window as any).fixture.listingCalls().length)
    const glued = Array.from({ length: 200 }, (_, index) => `d${index}/x.md`).join("和")
    await page.evaluate(text => (window as any).fixture.rerender(`看看 ${text} 吧。`), glued)
    await page.waitForFunction(target => (window as any).fixture.listingCalls().length === target, before + 64)
  } finally {
    await page.close()
  }
  assert.deepEqual(errors, [])
})
