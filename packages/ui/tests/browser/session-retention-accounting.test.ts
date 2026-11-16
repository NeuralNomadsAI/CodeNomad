import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type Browser } from "playwright"

// Transcript retention accounting must deduplicate raw/proxy aliases before
// counting bytes. The raw store walk visits records' data as raw targets while
// display caches reference the same tool state through Solid store proxies;
// the estimator's identity-based deduplication then counts both, and long
// tool transcripts cross the 64 MiB measurement cap, report Infinity, and make
// the LRU evict unrelated inactive transcripts. Runs in the browser rig so the
// client solid-js/store build (real proxies) is active — the server build used
// by plain node tests never creates proxies.
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

test("retention estimate does not double-count tool state aliased by display caches", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} } as any })
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.goto(url, { timeout: 120_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture), undefined, { timeout: 120_000 })
    await page.evaluate(`window.fixture.select("sibling-0")`)
    await page.waitForFunction(`window.fixture.loaded("sibling-0") >= 30`, undefined, { timeout: 60_000 })

    const result = await page.evaluate(`(async () => {
      const fixture = window.fixture
      fixture.hydrateTools("sibling-1", [1_000_000])
      const withoutCache = await fixture.estimate("sibling-1")
      fixture.materializeDisplay("sibling-1")
      const withCache = await fixture.estimate("sibling-1")
      return { withoutCache, withCache, delta: withCache - withoutCache }
    })()`)
    console.log(JSON.stringify({ scenario: "retention-alias-delta", ...result }))
    assert.ok(result.delta < 64_000,
      `display caches added ${result.delta} bytes of duplicate tool state (without=${result.withoutCache}, with=${result.withCache})`)

    // Two ~9.5 MiB counted outputs with materialized display caches: counting
    // the proxy aliases a second time crosses the 64 MiB measurement cap and
    // reports Infinity, which the LRU treats as over-budget.
    const cap = await page.evaluate(`(async () => {
      const fixture = window.fixture
      fixture.hydrateTools("sibling-2", [4_700_000, 4_700_000])
      fixture.materializeDisplay("sibling-2")
      return await fixture.estimate("sibling-2")
    })()`)
    console.log(JSON.stringify({ scenario: "retention-alias-cap", estimate: cap }))
    assert.ok(Number.isFinite(cap), `estimate exceeded the measurement cap: ${cap}`)
    assert.ok(cap < 48_000_000, `estimate double-counted cached tool state: ${cap}`)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
