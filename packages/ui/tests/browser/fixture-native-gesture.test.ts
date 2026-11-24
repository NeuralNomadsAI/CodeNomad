import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureGesturePoint, withFixtureMiddleDrag } from "./fixture-native-gesture"

let browser: Browser, url: string
before(async () => {
  url = (await borrowFixture({ name: "native-gesture", routes: [{ path: "/fixture", html: '<html><body><div id="root" style="height:700px"></div><script type="module" src="/tests/browser/fixtures/nested-scroll.tsx"></script></body></html>' }] })).url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })
async function open(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.bottom())
    await page.locator("[data-nested-output]").waitFor({ state: "visible" })
    await run(page)
  } finally { await page.close() }
}
test("native middle drag captures the original transcript and releases after a failing body", async () => open(async page => {
  const output = page.locator("[data-nested-output]"), primary = new Error("body sentinel")
  await assert.rejects(withFixtureMiddleDrag(page, output, await fixtureGesturePoint(output), async () => { throw primary }), error => error === primary)
  assert.equal(await page.locator(".message-stream").evaluate(root => (root as HTMLElement).style.cursor), "")
}))
test("an out-of-viewport middle point is refused before any native press", async () => open(async page => {
  await page.evaluate(() => { (window as any).presses = 0; document.addEventListener("pointerdown", () => (window as any).presses++) })
  await assert.rejects(withFixtureMiddleDrag(page, page.locator("[data-nested-output]"), { x: 100, y: 900 }, async () => assert.fail("unreachable body")), /must hit/)
  assert.equal(await page.evaluate(() => (window as any).presses), 0)
}))
test("an occluded middle target is refused by the real browser hit test", async () => open(async page => {
  const output = page.locator("[data-nested-output]"), point = await fixtureGesturePoint(output)
  await page.evaluate(() => { const cover = document.createElement("div"); cover.style.cssText = "position:fixed;inset:0;z-index:999999"; document.body.append(cover) })
  await assert.rejects(withFixtureMiddleDrag(page, output, point, async () => assert.fail("covered body")), /must hit/)
}))
test("a reachable native control without transcript capture stays red", async () => open(async page => {
  const button = page.locator("[data-output-action]")
  await assert.rejects(withFixtureMiddleDrag(page, button, await fixtureGesturePoint(button, { x: 5, y: 5 }), async () => assert.fail("uncaptured body")), /must be captured/)
}))
