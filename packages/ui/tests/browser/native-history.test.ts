import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "native-history", routes: [{ path: "/fixture", html:
    '<html><body><div id="root" class="session-center-column" style="display:flex;width:850px;height:650px"></div><input id="elsewhere" aria-label="Elsewhere"/><script type="module" src="/tests/browser/fixtures/native-history.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

function assertQualifiedReads(reads: string[]) {
  // Shared shell imports bootstrap independently of mounting the transcript.
  const bootstrap = new Set(["/api/storage/config/ui", "/api/storage/config/server", "/api/storage/state/ui",
    "/api/workspaces", "/api/events", "/api/auth/status", "/api/speech/capabilities", "/api/meta"])
  assert.deepEqual(reads.filter(path => !bootstrap.has(path)), [],
    "no enriched history/RPC, host filesystem, Git, recovery or automation read")
}

async function fixture(query = "", deviceScaleFactor = 1) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor })
  const errors: string[] = [], reads: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: "globalThis.__name = value => value" })
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    reads.push(path)
    if (path.endsWith("permission-receipts")) return route.fulfill({ status: 403, json: {
      error: "explicit_capability_unavailable", capability: "historyEnrichment", reason: { code: "deferred" },
    } })
    return route.fulfill({ json: {} })
  })
  await page.goto(url + query)
  try {
    await page.waitForFunction(() => (window as any).fixture?.snapshot().ids.length === 200, undefined, { timeout: 10000 })
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({ text: document.body.innerText, snapshot: (window as any).fixture?.snapshot() }))
    await page.close()
    throw new Error(JSON.stringify({ errors, reads, diagnostics }), { cause: error })
  }
  return { page, errors, reads, close: () => page.close() }
}

test("native pages, resident timeline and history shortcut mount without enrichment, host files, Git or pending recovery", async () => {
  const f = await fixture()
  try {
    await f.page.locator(".message-stream").waitFor()
    // prototype-1236: native history pages carry no explanatory banner.
    assert.equal(await f.page.locator(".history-native-notice").count(), 0)
    await f.page.evaluate(() => (window as any).fixture.oldest())
    assert.equal(await f.page.evaluate(() => (window as any).fixture.snapshot().ids[0]), "msg_0000")
    await f.page.evaluate(() => (window as any).fixture.newer())
    assert.equal(await f.page.evaluate(() => (window as any).fixture.snapshot().ids[0]), "msg_0200")
    await f.page.evaluate(() => (window as any).fixture.older())
    assert.equal(await f.page.evaluate(() => (window as any).fixture.snapshot().ids[0]), "msg_0000")
    await f.page.keyboard.press("Control+f")
    assert.equal(await f.page.getByRole("searchbox").count(), 0)
    assert.equal(await f.page.locator(".message-search-popover").count(), 0)
    await f.page.evaluate(() => (window as any).fixture.latest())
    await f.page.locator(".message-timeline").hover()
    assert.ok(await f.page.locator(".message-timeline-segment").count() > 0)
    const readsBeforeMarker = await f.page.evaluate(() => (window as any).fixture.snapshot().calls.length)
    await f.page.locator(".message-timeline-segment[data-message-id]").first().click()
    assert.equal(await f.page.evaluate(() => (window as any).fixture.snapshot().calls.length), readsBeforeMarker,
      "resident timeline selection stays local")
    const snapshot = await f.page.evaluate(() => (window as any).fixture.snapshot())
    assert.ok(snapshot.calls.every((call: any) => !call.cursor || !call.order))
    assert.ok(snapshot.calls.every((call: any) => !call.cursor?.startsWith("codenomad:")))
    assertQualifiedReads(f.reads)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("missing restored passage retains selection and offers an explicit latest-page recovery without a seek", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.hide())
    await f.page.evaluate(() => { (window as any).fixture.saveMissing(); (window as any).fixture.show() })
    await f.page.getByText("This passage is not loaded.", { exact: false }).first().waitFor()
    let snapshot = await f.page.evaluate(() => (window as any).fixture.snapshot())
    assert.equal(snapshot.calls.length, 1)
    assert.equal(snapshot.scroll.anchorKey, "msg_saved_elsewhere")
    assert.equal(snapshot.session.id, "s")
    await f.page.getByRole("button", { name: "Scroll to latest message", exact: true }).first().click()
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().calls.length === 2)
    snapshot = await f.page.evaluate(() => (window as any).fixture.snapshot())
    assert.equal(snapshot.calls.at(-1).order, "desc")
    assertQualifiedReads(f.reads)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("latest load merges a new native event without any notice, also zoomed in RTL", async () => {
  const f = await fixture("?rtl")
  try {
    await f.page.setViewportSize({ width: 520, height: 800 })
    await f.page.evaluate(() => {
      document.documentElement.dir = "rtl"
      document.body.style.zoom = "2"
      document.getElementById("root")!.style.width = "230px"
    })
    await f.page.evaluate(() => { (window as any).fixture.hold(); void (window as any).fixture.latest() })
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().calls.length === 2)
    await f.page.evaluate(() => { (window as any).fixture.stream(); (window as any).fixture.release() })
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().ids.includes("msg_0451"))
    assert.equal(await f.page.locator(".history-native-notice, .history-native-feedback").count(), 0)
    assertQualifiedReads(f.reads)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

const frames = (page: Page) => page.evaluate(async () => { for (let i = 0; i < 40; i++) await new Promise(requestAnimationFrame) })
const snapshot = (page: Page) => page.evaluate(() => (window as any).fixture.snapshot())
async function outcome(page: Page, mode: "fail" | "empty" | "restore") {
  await page.evaluate(async mode => {
    const { instances } = await import("/src/stores/instances.ts")
    const client = instances().get("native-history")!.client as any
    ;(window as any).originalList ??= client.message.list
    client.message.list = mode === "restore" ? (window as any).originalList : async () => {
      if (mode === "fail") throw new Error("Native page offline")
      ;(window as any).emptyReads = ((window as any).emptyReads ?? 0) + 1
      return { data: [], cursor: {} }
    }
  }, mode)
}
const readingPosition = (page: Page) => page.locator(".message-stream").evaluate(element => {
  const bounds = element.getBoundingClientRect()
  const row = [...element.querySelectorAll<HTMLElement>("[data-virtual-follow-key]")]
    .find(row => row.getBoundingClientRect().bottom > bounds.top && row.getBoundingClientRect().top < bounds.bottom)
  return { key: row?.dataset.virtualFollowKey, offset: row ? row.getBoundingClientRect().top - bounds.top : 0 }
})

for (const direction of ["oldest", "latest"] as const) test(`pending native ${direction} announces politely without replacing the passage`, async () => {
  const f = await fixture()
  try {
    if (direction === "latest") await f.page.evaluate(() => (window as any).fixture.oldest())
    await frames(f.page)
    const before = await snapshot(f.page)
    await f.page.evaluate(() => (window as any).fixture.hold())
    await f.page.getByRole("button", { name: direction === "oldest" ? "Scroll to first message" : "Scroll to latest message", exact: true }).focus()
    await f.page.keyboard.press("Enter")
    await f.page.waitForFunction(count => (window as any).fixture.snapshot().calls.length === count, before.calls.length + 1)
    const pending = f.page.locator('.history-native-feedback[role="status"]')
    await pending.getByText("Loading passage…", { exact: true }).waitFor()
    assert.equal(await pending.getAttribute("aria-live"), "polite")
    assert.deepEqual((await snapshot(f.page)).ids, before.ids)
    if (direction === "oldest") {
      await f.page.keyboard.press("Enter")
      assert.equal((await snapshot(f.page)).calls.length, before.calls.length + 1)
    }
    await f.page.evaluate(() => (window as any).fixture.release())
    await pending.waitFor({ state: "detached" })
    assertQualifiedReads(f.reads)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.evaluate(() => (window as any).fixture.release()).catch(() => {}); await f.close() }
})

// prototype-1236 (R7): an empty native reply beside visible rows is never a failed page.
test("an empty newer reply reaches the latest page without a false empty-page state", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.oldest())
    await frames(f.page)
    await outcome(f.page, "empty")
    const ids = (await snapshot(f.page)).ids
    await f.page.evaluate(() => (window as any).fixture.newer())
    await frames(f.page)
    assert.deepEqual((await snapshot(f.page)).ids, ids)
    assert.equal(await f.page.locator(".history-native-feedback").count(), 0)
    assert.equal(await f.page.getByRole("button", { name: "Reload messages", exact: true }).count(), 0)
    assert.equal(await f.page.evaluate(() => (window as any).emptyReads), 1)
    await f.page.evaluate(() => (window as any).fixture.newer())
    assert.equal(await f.page.evaluate(() => (window as any).emptyReads), 1, "the reached latest page asks for nothing newer")
    assertQualifiedReads(f.reads)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("an empty latest reply racing visible rows retries, then keeps the rows without an error", async () => {
  const f = await fixture()
  try {
    await frames(f.page)
    await outcome(f.page, "empty")
    const before = await snapshot(f.page)
    await f.page.evaluate(() => (window as any).fixture.latest())
    await frames(f.page)
    const after = await snapshot(f.page)
    assert.equal(await f.page.evaluate(() => (window as any).emptyReads), 4, "one read and three bounded retries")
    assert.ok(after.ids.includes(before.ids.at(-1)))
    assert.equal(await f.page.locator(".history-native-feedback").count(), 0)
    assert.equal(await f.page.getByRole("button", { name: "Reload messages", exact: true }).count(), 0)
    assertQualifiedReads(f.reads)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

for (const direction of ["oldest"] as const) test(`${direction} retry is unique, visible and politely reported, then restores owned focus`, async () => {
  const f = await fixture()
  try {
    await frames(f.page)
    await outcome(f.page, "fail")
    const ids = (await snapshot(f.page)).ids
    const before = await readingPosition(f.page)
    await f.page.getByRole("button", { name: "Scroll to first message", exact: true }).focus()
    await f.page.keyboard.press("Enter")
    const retry = f.page.getByRole("button", { name: "Reload messages", exact: true })
    await retry.waitFor()
    await frames(f.page)
    const failed = await readingPosition(f.page)
    assert.equal(failed.key, before.key)
    assert.ok(Math.abs(failed.offset - before.offset) <= 2, "feedback preserves the reading line instead of growing a virtualized header")
    assert.equal(await retry.count(), 1)
    assert.equal(await f.page.getByRole("alert").count(), 0)
    assert.equal(await f.page.locator('.history-native-feedback[role="status"]').count(), 1)
    const bounds = await retry.boundingBox()
    assert.ok(bounds && bounds.y >= 0 && bounds.y < 200, "retry is next to the current notice, outside virtualized rows")
    assert.deepEqual((await snapshot(f.page)).ids, ids)
    await outcome(f.page, "restore")
    await retry.focus(); await f.page.keyboard.press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().ids[0] === "msg_0000")
    await frames(f.page)
    assert.equal(await f.page.locator(".message-stream").evaluate(element => document.activeElement === element), true)
    assertQualifiedReads(f.reads)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("missing-anchor recovery uses one polite message and restores focus to the transcript", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.hide())
    await f.page.evaluate(() => { (window as any).fixture.saveMissing(); (window as any).fixture.show() })
    await f.page.locator(".history-native-feedback").getByText("This passage is not loaded.", { exact: false }).waitFor()
    assert.equal(await f.page.getByText("This passage is not loaded.", { exact: false }).count(), 1)
    assert.equal(await f.page.getByRole("alert").count(), 0)
    const recover = f.page.locator(".history-native-feedback").getByRole("button")
    await recover.focus(); await f.page.keyboard.press("Enter")
    await recover.waitFor({ state: "detached" }); await frames(f.page)
    assert.equal(await f.page.locator(".message-stream").evaluate(element => document.activeElement === element), true)
    assertQualifiedReads(f.reads)
  } finally { await f.close() }
})

for (const change of ["focus", "hide", "rebind"] as const) test(`retry cannot reclaim focus after ${change}`, async () => {
  const f = await fixture()
  try {
    await outcome(f.page, "fail")
    await f.page.getByRole("button", { name: "Scroll to first message", exact: true }).click()
    const retry = f.page.getByRole("button", { name: "Reload messages", exact: true })
    await retry.waitFor(); await outcome(f.page, "restore")
    await f.page.evaluate(() => (window as any).fixture.hold())
    await retry.focus(); await f.page.keyboard.press("Enter")
    await f.page.getByRole("textbox", { name: "Elsewhere" }).focus()
    await f.page.evaluate(async change => {
      if (change === "hide") (window as any).fixture.hide()
      if (change === "rebind") {
        const { updateInstance } = await import("/src/stores/instances.ts")
        updateInstance("native-history", { binding: { serverId: "B", directory: "/Work/" } })
      }
      ;(window as any).fixture.release()
    }, change)
    await frames(f.page)
    assert.equal(await f.page.getByRole("textbox", { name: "Elsewhere" }).evaluate(element => document.activeElement === element), true)
    assertQualifiedReads(f.reads)
  } finally { await f.page.evaluate(() => (window as any).fixture.release()).catch(() => {}); await f.close() }
})

test("explicit pruning controls are absent and receipt readers never mount", async () => {
  const f = await fixture("?technical")
  try {
    await f.page.getByText("Native completed answer with technical cleanup", { exact: true }).waitFor()
    const actions = f.page.getByRole("button", { name: /Delete|Remove tools and reasoning from this response/ })
    assert.equal(await actions.count(), 0)
    assert.equal(await f.page.getByRole("dialog").count(), 0)
    assert.equal(await f.page.locator(".permission-receipts").count(), 0)
    assert.equal(await f.page.getByText("Permission decisions", { exact: true }).count(), 0)
    assertQualifiedReads(f.reads)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})

test("forced unavailable search in RTL creates neither a reader nor a popup", async () => {
  const f = await fixture("?rtl", 2)
  try {
    const before = await f.page.evaluate(() => (window as any).fixture.snapshot().calls.length)
    await f.page.evaluate(() => (window as any).fixture.search())
    assert.equal(await f.page.getByRole("dialog").count(), 0)
    assert.equal(await f.page.locator(".message-search-popover").count(), 0)
    assert.equal(await f.page.evaluate(() => (window as any).fixture.snapshot().calls.length), before)
    assertQualifiedReads(f.reads)
  } finally { await f.close() }
})

test("leaving the view cancels a held native first-page navigation and retains the latest passage", async () => {
  const f = await fixture()
  try {
    await f.page.evaluate(() => (window as any).fixture.hold())
    await f.page.locator(".message-stream").hover()
    await f.page.getByRole("button", { name: "Scroll to first message", exact: true }).click()
    await f.page.waitForFunction(() => (window as any).fixture.snapshot().calls.length === 2)
    await f.page.evaluate(() => (window as any).fixture.hide())
    await f.page.evaluate(() => { (window as any).fixture.release(); (window as any).fixture.show() })
    await f.page.locator(".message-stream").waitFor()
    assert.equal(await f.page.evaluate(() => (window as any).fixture.snapshot().ids.at(-1)), "msg_0450")
    assertQualifiedReads(f.reads)
    assert.deepEqual(f.errors, [])
  } finally { await f.close() }
})
