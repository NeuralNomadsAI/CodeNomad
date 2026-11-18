import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string, events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "session-external-move", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-external-move.tsx"></script></body></html>' }] })
  url = fixture.url; events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

const row = (page: Page, tab: string, id: string) =>
  page.getByRole("region", { name: `Project ${tab}` }).locator(`[data-session-id="${id}"]`)

async function open() {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} })); await events.route(page)
  await page.goto(url); await page.waitForFunction(() => Boolean((window as any).fixture))
  await row(page, "a", "moving").waitFor(); await row(page, "b", "resident").waitFor()
  assert.equal(await page.evaluate(() => (window as any).fixture.selected("a")), "moving")
  return { page, errors }
}

async function settled(page: Page, errors: string[]) {
  await row(page, "a", "moving").waitFor({ state: "detached" })
  assert.equal(await page.evaluate(() => (window as any).fixture.selected("a")), null)
  // The family members left behind keep the old project's ordinary sessions intact.
  await row(page, "a", "staying").waitFor()
  await page.waitForTimeout(300)
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.refused), [], "nothing reads the session through its old project")
  assert.equal(await page.evaluate(() => (window as any).fixture.listError("a")), null)
  assert.deepEqual(errors, [])
}

test("an external move of the selected conversation leaves its old tab and appears in the destination tab", async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(() => (window as any).fixture.move("moving", "/projects/b"))
    await row(page, "b", "moving").waitFor()
    await settled(page, errors)
    assert.equal(await page.evaluate(() => (window as any).fixture.selected("b")), null, "the destination keeps its own selection")
  } finally { await page.close() }
})

test("an external move to a folder open in no tab only leaves the old tab", async () => {
  const { page, errors } = await open()
  try {
    await page.evaluate(() => (window as any).fixture.move("moving", "/projects/elsewhere"))
    await settled(page, errors)
    assert.equal(await row(page, "b", "moving").count(), 0)
    await row(page, "b", "resident").waitFor()
  } finally { await page.close() }
})
