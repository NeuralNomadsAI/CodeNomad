import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string
let stream: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({
    name: "streaming-projection",
    routes: [
      { path: "/streaming", html: '<html><body><div id="root" style="display:flex;width:1100px;height:740px"></div><script type="module" src="/tests/browser/fixtures/streaming-projection.tsx"></script></body></html>' },
    ],
  })
  url = fixture.url
  stream = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await stream?.close() } })

async function open(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  page.on("requestfailed", request => errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`))
  await page.route("**/*", route => {
    const request = new URL(route.request().url())
    if (request.hostname !== "127.0.0.1") return route.abort()
    if (request.pathname === "/workspaces/streaming-fixture/yolo/sessions/active" && route.request().method() === "GET") {
      return route.fulfill({ json: { enabled: false } })
    }
    if (request.pathname.startsWith("/api/")) return route.fulfill({ json: {} })
    return route.continue()
  })
  try {
    await stream.route(page)
    const opened = page.waitForResponse(response => new URL(response.url()).pathname === "/api/events")
    await page.goto(url, { waitUntil: "domcontentloaded" })
    assert.match((await opened).headers()["content-type"], /text\/event-stream/)
    await page.waitForFunction(() => Boolean((window as any).streamingFixture), undefined, { timeout: 60_000 })
    await page.waitForTimeout(300)
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
}

const snapshot = (page: Page) => page.evaluate(() => (window as any).streamingFixture.snapshot())
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
const joined = (count: number) => Array.from({ length: count }, (_, index) => `[${index}]`).join("")
const spacedText = (count: number) => Array.from({ length: count }, (_, index) => `<${index}>`).join("")
/** Starts a reply and lets its own frame land before counts reset. */
const startSettled = async (page: Page, messageId?: string) => {
  await page.evaluate((id) => (window as any).streamingFixture.startReply(id ?? undefined), messageId)
  await frames(page)
  await page.evaluate(() => (window as any).streamingFixture.resetCounts())
}

test("a same-task delta burst projects once at the next frame without an authoritative read", () => open(async page => {
  await startSettled(page)
  const ingress = await page.evaluate(() => (window as any).streamingFixture.burst(400))
  const during = await snapshot(page)
  console.log("streaming-burst", JSON.stringify({ variant: process.env.CODENOMAD_STREAMING_VARIANT ?? "default", ingress, during: { projections: during.projections, longtasks: during.longtasks } }))
  assert.ok(during.projections <= 1, `a burst dispatched in one task projects at most once before the snapshot (got ${during.projections})`)
  assert.equal(during.messageLists, 0, "streamed deltas must not trigger HTTP message reads")
  assert.ok(during.revision >= 400, "reducer revisions keep streaming per admitted event")
  await page.waitForFunction((text) => (window as any).streamingFixture.snapshot().text === text, joined(400), { timeout: 15_000 })
  const flushed = await snapshot(page)
  assert.equal(flushed.projections, 1, "one frame projects the whole burst once")
  await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("[399]"), undefined, { timeout: 15_000 })
  await page.evaluate(() => { const f = (window as any).streamingFixture; f.resetCounts(); f.endReply("authoritative final") })
  await page.waitForFunction(() => (window as any).streamingFixture.snapshot().text === "authoritative final", undefined, { timeout: 15_000 })
  const final = await snapshot(page)
  assert.equal(final.messageLists, 0, "the terminal events reconcile through the reducer, not a refetch")
}))

test("spaced deltas across tasks stay frame-coalesced and complete", () => open(async page => {
  await startSettled(page)
  const spaced = await page.evaluate(() => (window as any).streamingFixture.spaced(24))
  await frames(page)
  const state = await snapshot(page)
  console.log("streaming-spaced", JSON.stringify({ variant: process.env.CODENOMAD_STREAMING_VARIANT ?? "default", spaced, projections: state.projections }))
  assert.equal(state.text, spacedText(24), "the projected page carries every spaced delta, exactly once, in order")
  assert.ok(state.projections < 24, `frame coalescing projects fewer passes than deltas (got ${state.projections})`)
}))

test("visibility changes and session switches flush pending pages", () => open(async page => {
  await startSettled(page)
  await page.evaluate(() => { const f = (window as any).streamingFixture; f.burst(30); f.visibility() })
  const visible = await snapshot(page)
  assert.equal(visible.projections, 1, "a visibility change flushes the pending projection")
  assert.equal(visible.text, joined(30))
  await page.evaluate(() => { const f = (window as any).streamingFixture; f.startReply("msg_second"); f.burst(60); f.activate("other") })
  const switched = await snapshot(page)
  assert.equal(switched.projections, 2, "a selection change flushes the pending projection")
  assert.equal(switched.text, joined(60), "the second reply's page flushed with its own stream")
}))
