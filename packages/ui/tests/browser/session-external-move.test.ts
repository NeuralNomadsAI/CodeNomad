import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"
import { SESSION_LOCATED_ELSEWHERE_REASON } from "../../../server/src/opencode/session-access-contract"

let browser: Browser, url: string, events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "session-external-move", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-external-move.tsx"></script></body></html>' }] })
  url = fixture.url; events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

const parentRead = "/workspaces/external-move-a/instance/api/session/moving"
const row = (page: Page, tab: string, id: string) =>
  page.getByRole("region", { name: `Project ${tab}` }).locator(`[data-session-id="${id}"]`)

async function open(query = "") {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors: string[] = [], refused: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} })); await events.route(page)
  // The workspace proxy's refusal of a session located outside the workspace.
  await page.route("**/instance/api/session/*", route => {
    refused.push(new URL(route.request().url()).pathname)
    return route.fulfill({ status: 403, json: { error: "Session does not belong to workspace", reason: SESSION_LOCATED_ELSEWHERE_REASON } })
  })
  await page.goto(`${url}${query}`); await page.waitForFunction(() => Boolean((window as any).fixture))
  await row(page, "a", "staying").waitFor(); await row(page, "b", "resident").waitFor()
  return { page, errors, refused }
}

async function settled(page: Page, errors: string[]) {
  await row(page, "a", "moving").waitFor({ state: "detached" })
  assert.equal(await page.evaluate(() => (window as any).fixture.selected("a")), null)
  // The family members left behind keep the old project's ordinary sessions intact.
  await row(page, "a", "staying").waitFor()
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => (window as any).fixture.listError("a")), null)
  assert.deepEqual(errors, [])
}

test("an external move of the selected conversation leaves its old tab and appears in the destination tab", async () => {
  const { page, errors, refused } = await open()
  try {
    assert.equal(await page.evaluate(() => (window as any).fixture.selected("a")), "moving")
    await page.evaluate(() => (window as any).fixture.move("moving", "/projects/b"))
    await row(page, "b", "moving").waitFor()
    await settled(page, errors)
    assert.deepEqual(refused, [parentRead, parentRead], "the move probe and the child’s parent read both see the departure")
    assert.equal(await page.evaluate(() => (window as any).fixture.selected("b")), null, "the destination keeps its own selection")
  } finally { await page.close() }
})

test("an external move to a folder open in no tab only leaves the old tab", async () => {
  const { page, errors, refused } = await open()
  try {
    await page.evaluate(() => (window as any).fixture.move("moving", "/projects/elsewhere"))
    await settled(page, errors)
    assert.deepEqual(refused, [parentRead, parentRead])
    assert.equal(await row(page, "b", "moving").count(), 0)
    await row(page, "b", "resident").waitFor()
  } finally { await page.close() }
})

test("a parent's chevron counts only the subsessions the list shows", async () => {
  const { page, errors } = await open()
  try {
    await row(page, "a", "staying").waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.childActivity("staying")), null)
    await page.evaluate(() => (window as any).fixture.holdChild("/projects/a"))
    await page.waitForFunction(() => (window as any).fixture.childActivity("staying") === "working")
    assert.equal(await page.evaluate(() => (window as any).fixture.indicator("a")), "working")
    await page.evaluate(() => (window as any).fixture.move("busy-child", "/projects/elsewhere"))
    await page.waitForFunction(() => (window as any).fixture.indicator("a") === "idle")
    // A late live event brings it back into the store, still located elsewhere.
    await page.evaluate(() => (window as any).fixture.holdChild("/projects/elsewhere"))
    await page.waitForTimeout(200)
    assert.equal(await row(page, "a", "busy-child").count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.indicator("a")), "idle")
    assert.equal(await page.evaluate(() => (window as any).fixture.childActivity("staying")), null,
      "a working child located elsewhere does not light its parent's chevron")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a reloaded old tab lists its sessions without an error after the move", async () => {
  const { page, errors, refused } = await open("?moved")
  try {
    await row(page, "b", "moving").waitFor()
    await settled(page, errors)
    // Its children's parent is read once, refused as located elsewhere, and treated as absent.
    assert.deepEqual(refused, [parentRead])
  } finally { await page.close() }
})
