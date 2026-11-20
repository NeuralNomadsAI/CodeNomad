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
    if (request.pathname === "/api/workspaces/streaming-fixture/session-history/outline") {
      errors.push("projection fixture attempted an outline HTTP read")
      return route.abort()
    }
    if (request.pathname.startsWith("/api/")) return route.fulfill({ json: {} })
    return route.continue()
  })
  try {
    await stream.route(page)
    await page.addInitScript(() => {
      window.EventSource = class extends EventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options)
          Object.assign(window, { projectionSource: this })
        }
      }
    })
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

async function observeSse(page: Page, id: string) {
  await page.evaluate(id => {
    const view = window as any
    // Attach after CodeNomad's handler: the receipt observes actual EventSource
    // delivery, after the last payload has entered the production queue.
    view.projectionReceived = new Promise<void>(resolve => {
      const source: EventSource = view.projectionSource
      const receipt = new AbortController()
      source.addEventListener("message", message => {
        if (JSON.parse(message.data).event?.id !== id) return
        receipt.abort()
        resolve()
      }, { signal: receipt.signal })
    })
  }, id)
}

const waitForSse = (page: Page) => page.evaluate(() => (window as any).projectionReceived)

async function queueSseReply(page: Page) {
  const time = Date.now()
  await page.clock.install({ time })
  await page.clock.pauseAt(time + 60_000)
  await observeSse(page, "evt_projection_2")
  const assistantMessageID = "msg_live"
  const location = { directory: "/fixture" }
  const base = { sessionID: "active", assistantMessageID }
  const durable = { aggregateID: base.sessionID, version: 1 }
  stream.send({ type: "instance.event", instanceId: "streaming-fixture", event: {
    id: "evt_projection_1", type: "session.step.started", created: 1, location,
    durable: { ...durable, seq: 1 },
    data: { ...base, agent: "build", model: { providerID: "fixture", id: "fixture" }, started: 1 },
  } })
  stream.send({ type: "instance.event", instanceId: "streaming-fixture", event: {
    id: "evt_projection_2", type: "session.text.started", created: 2, location,
    durable: { ...durable, seq: 2 },
    data: { ...base, ordinal: 0 },
  } })
  await waitForSse(page)
  const started = await snapshot(page)
  assert.equal(started.status, "working", "step start is visible before paint")
  assert.ok(started.revision >= 2, "both starts reduce immediately")
  await page.evaluate(() => (window as any).streamingFixture.resetCounts())
  await observeSse(page, "evt_projection_4")
  for (const [seq, delta] of [[3, "first"], [4, " second"]] as const) {
    stream.send({ type: "instance.event", instanceId: "streaming-fixture", event: {
      id: `evt_projection_${seq}`, type: "session.text.delta", created: seq, location,
      data: { ...base, ordinal: 0, delta },
    } })
  }
  await waitForSse(page)
  const queued = await snapshot(page)
  assert.equal(queued.projections, 0, "the deltas wait for paint or a barrier")
  assert.equal(queued.revision, started.revision, "the deltas have not reduced yet")
}

test("SSE deltas project once, in their delivery frame", { timeout: 120_000 }, () => open(async page => {
  await queueSseReply(page)
  await page.clock.runFor(16)
  const firstFrame = await snapshot(page)
  assert.ok(firstFrame.revision >= 4, "the reducer admitted both deltas in the first frame")
  assert.equal(firstFrame.text, "first second", "the first frame publishes every delta in FIFO order")
  assert.equal(firstFrame.projections, 1)
  assert.equal(firstFrame.messageLists, 0)
  await page.clock.runFor(64)
  assert.equal((await snapshot(page)).projections, 1, "there is no later projection frame or fallback replay")
}))

test("a structural SSE event publishes earlier deltas in the same Solid update before paint", { timeout: 120_000 }, () => open(async page => {
  await queueSseReply(page)
  await observeSse(page, "evt_reasoning_started")
  stream.send({ type: "instance.event", instanceId: "streaming-fixture", event: {
    id: "evt_reasoning_started", type: "session.reasoning.started", created: 5, location: { directory: "/fixture" },
    durable: { aggregateID: "active", version: 1, seq: 3 },
    data: { sessionID: "active", assistantMessageID: "msg_live", ordinal: 0 },
  } })
  await waitForSse(page)
  const state = await snapshot(page)
  assert.equal(state.text, "first second")
  assert.equal(state.projections, 1)
  await page.clock.runFor(64)
  assert.equal((await snapshot(page)).projections, 1)
}))

for (const timing of ["before Enter", "during prompt preparation"] as const) {
  test(`Enter honors Queue when execution starts ${timing}`, { timeout: 120_000 }, () => open(async page => {
    await page.evaluate(() => (window as any).streamingFixture.setPreferences({ followUpBehavior: "queue" }))
    const input = page.locator(".session-view textarea").first()
    await input.fill("Follow-up")

    const time = Date.now()
    await page.clock.install({ time })
    await page.clock.pauseAt(time + 60_000)
    const preparing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await page.route("**/api/experimental/session/active/instructions/entries/codenomad.session-placement", async route => {
      preparing.resolve()
      await release.promise
      await route.fulfill({ status: 204 })
    })
    const prompt = page.waitForRequest(request => request.method() === "POST"
      && new URL(request.url()).pathname === "/api/session/active/prompt", { timeout: 15_000 })
    void prompt.catch(() => undefined)

    try {
      if (timing === "during prompt preparation") {
        await input.press("Enter")
        await preparing.promise
      }
      const id = "evt_execution_started"
      await observeSse(page, id)
      stream.send({ type: "instance.event", instanceId: "streaming-fixture", event: {
        id, type: "session.execution.started", created: 1, location: { directory: "/fixture" },
        durable: { aggregateID: "active", seq: 1, version: 1 }, data: { sessionID: "active" },
      } })
      await waitForSse(page)
      assert.equal((await snapshot(page)).status, "working", "execution start is visible before paint")
      if (timing !== "during prompt preparation") {
        await input.press("Enter")
        await preparing.promise
        assert.deepEqual((await snapshot(page)).ids, [], "a follow-up known to be queued has no optimistic transcript row")
      }
      release.resolve()
      const { text, delivery, resume } = (await prompt).postDataJSON()
      assert.deepEqual({ text, delivery, resume }, { text: "Follow-up", delivery: "queue", resume: false })
    } finally {
      release.resolve()
    }
  }))
}

test("switching sessions before the first SSE frame publishes to the session being left", { timeout: 120_000 }, () => open(async page => {
  await queueSseReply(page)
  assert.equal(await page.evaluate(() => (window as any).streamingFixture.activate("other")), "other")
  const switched = await snapshot(page)
  assert.equal(switched.text, "first second", "the selection barrier publishes accepted SSE to the old page")
  assert.equal(switched.projections, 1)
  await page.clock.runFor(64)
  assert.equal((await snapshot(page)).projections, 1, "the retired frame does not replay after selection")

  await observeSse(page, "evt_projection_5")
  stream.send({ type: "instance.event", instanceId: "streaming-fixture", event: {
    id: "evt_projection_5", type: "session.deleted", created: 5, location: { directory: "/fixture" },
    durable: { aggregateID: "active", version: 1, seq: 3 }, data: { sessionID: "active" },
  } })
  await waitForSse(page)
  assert.equal(await page.evaluate(() => (window as any).streamingFixture.activate("active")), "other",
    "the selection does not revive a target deleted by the accepted batch")
}))
