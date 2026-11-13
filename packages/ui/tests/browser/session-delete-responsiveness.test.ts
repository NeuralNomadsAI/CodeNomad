import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser } from "playwright"

// Deleting one conversation must not pay for every other conversation resident
// in the instance store. Clearing a session collects its message ids from the
// session record; a scan of every resident message through store proxies made
// each deletion cost O(all resident messages) — a mission cleanup deleting a
// task family then blocked the main thread for seconds, up to the browser's
// page-unresponsive dialog. Here a 20k-message conversation stays resident
// while one small conversation is deleted; the dispatch must stay cheap.
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
})
after(async () => { await browser?.close() })

test("deleting a small session is independent of other sessions' transcript size", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} } as any })
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.goto(url, { timeout: 120_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 120_000 })

    // The viewed session stays a small one; the huge sibling is resident but
    // not mounted, exactly like inactive mission task transcripts.
    await page.evaluate(`window.fixture.select("sibling-0")`)
    await page.waitForFunction(`window.fixture.loaded("sibling-0") >= 30`, undefined, { timeout: 60_000 })
    await page.evaluate(`window.fixture.hydrateMany("sibling-1", 60000)`)
    await page.waitForFunction(`window.fixture.loaded("sibling-1") >= 60000`, undefined, { timeout: 120_000 })
    // The deletion targets: ordinary loaded sessions, unrelated to the huge one.
    for (const sessionId of ["sibling-2", "sibling-3", "sibling-4"]) {
      await page.evaluate(`window.fixture.load("${sessionId}")`)
      await page.waitForFunction(`window.fixture.loaded("${sessionId}") >= 30`, undefined, { timeout: 60_000 })
    }

    // The cheapest of three dispatches: GC and scheduler noise from the huge
    // sibling's heap must not mask the algorithmic cost of one deletion.
    const result = await page.evaluate(`(() => {
      const fixture = window.fixture
      const dispatches = ["sibling-2", "sibling-3", "sibling-4"].map((sessionId) => fixture.emitDeleteMeasured(sessionId))
      return { dispatchMs: Math.min(...dispatches), dispatches, hugeResident: fixture.loaded("sibling-1") }
    })()`)

    console.log(JSON.stringify({ scenario: "delete-cost-independence", ...result }))
    // A resident-60k-message sibling may not tax deleting one ordinary session;
    // the scan-based implementation walked every resident record per deletion.
    assert.ok(result.dispatchMs < 120, `deleting a small session with a 60k-message sibling resident took ${result.dispatchMs}ms (best of three)`)
    assert.equal(await page.evaluate(`window.fixture.loaded("sibling-2")`), 0, "the deleted session's transcript leaves the store")
    assert.ok(result.hugeResident >= 60000, "other sessions keep their transcripts")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
