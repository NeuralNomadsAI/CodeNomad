import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type Browser, type Page } from "playwright"

// Deleting one conversation must not pay for every other conversation resident
// in the instance store. Clearing a session collects its message ids from the
// session record; a scan of every resident message through store proxies made
// each deletion cost O(all resident messages) — a mission cleanup deleting a
// task family then blocked the main thread for seconds, up to the browser's
// page-unresponsive dialog. The control is a scaling comparison, not an
// absolute bound: a scan's cost grows with the unrelated sibling's transcript
// size on any machine, the record-based collection does not.
let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "session-delete-scale",
    routes: [
      { path: "/fixture", html: "<html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/session-delete-scale.tsx\"></script></body></html>" },
    ],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function openPage(): Promise<{ page: Page, errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} } as any })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.goto(url, { timeout: 120_000 })
  await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 120_000 })
  // The viewed session stays a small one; a huge sibling stays resident but
  // not mounted, exactly like inactive mission task transcripts.
  await page.evaluate(`window.fixture.select("sibling-0")`)
  await page.waitForFunction(`window.fixture.loaded("sibling-0") >= 30`, undefined, { timeout: 60_000 })
  return { page, errors }
}

async function loadDeletionTargets(page: Page) {
  for (const sessionId of ["sibling-2", "sibling-3", "sibling-4"]) {
    await page.evaluate(`window.fixture.load("${sessionId}")`)
    await page.waitForFunction(`window.fixture.loaded("${sessionId}") >= 30`, undefined, { timeout: 60_000 })
  }
}

const cheapestOfThreeDispatches = (page: Page) => page.evaluate(`(() => {
  const dispatches = ["sibling-2", "sibling-3", "sibling-4"].map((sessionId) => window.fixture.emitDeleteMeasured(sessionId))
  return Math.min(...dispatches)
})()`)

test("deleting a small session is independent of other sessions' transcript size", async () => {
  const withoutHuge = await openPage()
  const big = await openPage()
  try {
    await loadDeletionTargets(withoutHuge.page)
    const baseline = await cheapestOfThreeDispatches(withoutHuge.page)

    await big.page.evaluate(`window.fixture.hydrateMany("sibling-1", 60000)`)
    await big.page.waitForFunction(`window.fixture.loaded("sibling-1") >= 60000`, undefined, { timeout: 120_000 })
    await loadDeletionTargets(big.page)
    const withHuge = await cheapestOfThreeDispatches(big.page)

    console.log(JSON.stringify({ scenario: "delete-cost-independence", withoutHugeSiblingMs: baseline, withHugeSiblingMs: withHuge }))
    assert.ok(withHuge < 3 * Math.max(baseline, 10) + 30,
      `deleting a small session scaled with an unrelated sibling's transcript size: ${withHuge}ms with a 60k-message sibling vs ${baseline}ms without`)
    assert.equal(await big.page.evaluate(`window.fixture.loaded("sibling-2")`), 0, "the deleted session's transcript leaves the store")
    assert.ok((await big.page.evaluate(`window.fixture.loaded("sibling-1")`)) >= 60000, "other sessions keep their transcripts")
    assert.deepEqual([...withoutHuge.errors, ...big.errors], [])
  } finally {
    await withoutHuge.page.close()
    await big.page.close()
  }
})
