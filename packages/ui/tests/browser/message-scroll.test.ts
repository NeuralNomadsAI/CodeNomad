import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

// Scroll ownership regressions over the real SessionView/VirtualFollowList:
// a manual reader is never repinned by proximity and is restored exactly, a
// restored anchor has one imperative target, and only an opposite gesture
// supersedes pending history paging.
const fixtures = {
  // SessionView with a held history request (session.tsx bootstrap).
  session: "message-scroll",
  // Two retained SessionView panes, fenced by isActive like the app shell.
  switch: "message-scroll-switch",
  // Bare VirtualFollowList whose remount restores its captured snapshot.
  list: "navigation",
  // Tool-output-style follow-scroll container nested in a VirtualFollowList.
  nested: "nested-scroll",
} as const
type FixtureName = keyof typeof fixtures

let server: ViteDevServer, browser: Browser, url: string
let fixtureCache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  fixtureCache = await createFixtureCache()
  server = await createServer({ cacheDir: fixtureCache.cacheDir, configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", plugins: [solid(), {
    name: "message-scroll-fixture", configureServer(server) {
      server.middlewares.use("/fixture", async (req, res) => {
        const name = new URL(req.url ?? "", "http://fixture").searchParams.get("name") as FixtureName
        res.setHeader("Content-Type", "text/html")
        res.end(await server.transformIndexHtml("/fixture", `<html><body><div id="root" style="display:flex;height:700px;width:1100px"></div><script type="module" src="/tests/browser/fixtures/${fixtures[name]}.tsx"></script></body></html>`))
      })
    },
  }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close(); await fixtureCache?.dispose() })

async function frames(page: Page, count = 30) {
  await page.evaluate(`new Promise(resolve => { let count = ${count}; const next = () => --count ? requestAnimationFrame(next) : resolve(); requestAnimationFrame(next) })`)
}

async function open(run: (page: Page) => Promise<void>, { name = "session", history = 60, hasTouch = false }: { name?: FixtureName; history?: number; hasTouch?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: "en-US", hasTouch })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  // tsx preserves callback names with this helper when Playwright serializes them.
  await page.addInitScript("window.__name = (value) => value")
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname.endsWith("/permission-receipts")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ receipts: [] }) })
    return route.fulfill({ contentType: route.request().url().includes("events") ? "text/event-stream" : "application/json", body: "" })
  })
  // Native scroll events report post-layout positions that RAF samples taken
  // before layout can miss; a restore cycle is visible only here.
  await page.addInitScript(() => {
    ;(window as any).scrollObservations = []
    document.addEventListener("scroll", event => {
      const el = event.target
      if (!(el instanceof Element) || !el.classList.contains("message-stream")) return
      const key = (window as any).traceKey, row = key ? el.querySelector(`[data-virtual-follow-key="${key}"]`) : null
      ;(window as any).scrollObservations.push({ gap: el.scrollHeight - el.clientHeight - el.scrollTop, anchorOffset: row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null, time: performance.now() })
    }, { capture: true, passive: true })
  })
  try {
    await page.goto(`${url}?name=${name}`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(`(async () => { const { applyUiSettings } = await import('/tests/browser/fixtures/ui-settings.ts'); await applyUiSettings({ holdLongAssistantReplies: false, locale: 'en' }) })()`)
    if (name === "session" || name === "switch") {
      await page.evaluate(count => (window as any).fixture.seedHistory(count), history)
      await page.waitForFunction(last => document.querySelector(".message-stream")?.textContent?.includes(`History ${last}`), name === "switch" ? 59 : history - 1)
    }
    await frames(page, 60)
    await run(page)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
}

const latestButton = (page: Page, scope = "") => page.locator(`${scope} .message-scroll-controls`).getByRole("button", { name: "Scroll to latest message", exact: true })

async function bottom(page: Page, scope = "") {
  await page.locator(`${scope} .message-scroll-controls`).hover()
  const button = latestButton(page, scope)
  if (await button.count()) await button.click()
  await frames(page)
}

async function readerState(page: Page, scope = "") {
  const gap = await page.locator(`${scope} .message-stream`).evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
  const followModeType = await page.evaluate(() => (window as any).fixture.snapshot().scroll.followModeType)
  return { gap, followModeType, latestButton: await latestButton(page, scope).count() }
}

async function traceAnchor(page: Page, key: string) {
  await page.evaluate(key => { (window as any).traceKey = key; (window as any).scrollObservations = [] }, key)
}

/** Samples the anchor's viewport offset for `count` frames, running `step(frame)` first in each. */
async function sampleAnchor(page: Page, args: { key: string; stream: string; count: number; step?: string }) {
  return page.evaluate(({ key, stream, count, step }) => new Promise<Array<{ time: number; anchorOffset: number | null }>>(resolve => {
    const run = step ? new Function("frame", step) : undefined
    const samples: Array<{ time: number; anchorOffset: number | null }> = []
    const next = () => {
      run?.(samples.length)
      const el = document.querySelector(stream)!, row = el.querySelector(`[data-virtual-follow-key="${key}"]`)
      samples.push({ time: performance.now(), anchorOffset: row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null })
      if (samples.length === count) resolve(samples); else requestAnimationFrame(next)
    }
    requestAnimationFrame(next)
  }), args)
}

/** After `settle` frames, neither RAF samples nor post-layout scroll events may move the anchor. */
async function assertAnchorHeld(page: Page, samples: Array<{ time: number; anchorOffset: number | null }>, expected: number, tolerance: number, settle: number) {
  const settled = samples.slice(settle)
  assert.ok(settled.every(sample => sample.anchorOffset !== null && Math.abs(sample.anchorOffset - expected) < tolerance), `Restored anchor moved: expected=${expected}; ${JSON.stringify(settled)}`)
  const late = await page.evaluate(time => (window as any).scrollObservations.filter((sample: any) => sample.time >= time && sample.anchorOffset !== null), samples[settle].time)
  assert.ok(late.every((sample: any) => Math.abs(sample.anchorOffset - expected) < tolerance), `Post-layout restore cycle: expected=${expected}; ${JSON.stringify(late)}`)
}

for (const targetGap of [64, 32]) test(`manual reading ${targetGap}px from bottom does not resume follow`, async () => {
  await open(async page => {
    await bottom(page)
    await page.locator(".message-stream").hover()
    await page.mouse.wheel(0, -80)
    await frames(page, 45)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().scroll.followModeType), "escaped")
    const gap = await page.locator(".message-stream").evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
    await page.evaluate(() => { (window as any).scrollObservations = [] })
    await page.mouse.wheel(0, gap - targetGap)
    await frames(page, 45)
    const observations = await page.evaluate(() => (window as any).scrollObservations)
    assert.ok(observations.some((sample: any) => Math.abs(sample.gap - targetGap) < 2), `The native wheel must stop at ${targetGap}px: ${JSON.stringify(observations)}`)
    const state = await page.evaluate(() => (window as any).fixture.snapshot().scroll)
    assert.equal(state.followModeType, "escaped", `Proximity to the bottom is not explicit follow: ${JSON.stringify(state)}`)
    assert.equal(await latestButton(page).count(), 1, "A manual reader above the true bottom keeps the latest button")
  })
})

test("manual reading resumes follow once the wheel reaches the true bottom", async () => {
  await open(async page => {
    await bottom(page)
    await page.locator(".message-stream").hover()
    await page.mouse.wheel(0, -80)
    await frames(page, 45)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().scroll.followModeType), "escaped")
    await page.mouse.wheel(0, 400)
    await frames(page, 45)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().scroll.followModeType), "following")
  })
})

test("nested follow-scroll output resumes only at its true bottom", async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.bottom())
    const output = page.locator("[data-nested-output]")
    await output.waitFor({ state: "visible" })
    await page.evaluate(() => (window as any).fixture.renderOutput())
    await page.waitForFunction(() => (document.querySelector("[data-nested-output]")?.scrollTop ?? 0) > 1000)
    await output.hover()
    const innerFollow = () => page.evaluate(() => (window as any).fixture.snapshot().innerFollow)
    const gap = () => output.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
    await page.mouse.wheel(0, -100)
    await frames(page, 10)
    assert.equal(await innerFollow(), false)
    await page.mouse.wheel(0, await gap() - 32)
    await frames(page, 10)
    assert.ok(Math.abs(await gap() - 32) < 2)
    assert.equal(await innerFollow(), false, "Proximity inside nested output is not explicit follow")
    await page.mouse.wheel(0, 100)
    await frames(page, 10)
    assert.equal(await innerFollow(), true, "Reaching the output's true bottom resumes follow")
  }, { name: "nested" })
})

for (const grow of [false, true]) test(`mounted anchor restoration holds during row resize (grow=${grow})`, async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.nearTail())
    await frames(page, 20)
    await page.evaluate(() => (window as any).fixture.roll())
    await frames(page, 20)
    await page.locator(".message-stream").hover()
    await page.mouse.wheel(0, 25)
    await frames(page, 30)
    const before = await page.evaluate(() => (window as any).fixture.snapshot())
    await traceAnchor(page, before.anchorKey)
    await page.evaluate(() => { (window as any).fixture.switchAway(); (window as any).fixture.return() })
    const samples = await sampleAnchor(page, { key: before.anchorKey, stream: ".message-stream", count: 90, step: grow ? "window.fixture.growTail(48 + frame * 20)" : undefined })
    await assertAnchorHeld(page, samples, before.anchorOffset, 2, 15)
  }, { name: "list" })
})

for (const reader of ["manual-32", "following"] as const) for (const transition of ["remount", "switch"] as const) test(`a ${reader} reader is restored exactly after ${transition}`, async () => {
  const scope = transition === "switch" ? '[data-session-id="A"]' : ""
  await open(async page => {
    await bottom(page, scope)
    await page.locator(`${scope} .message-stream`).hover()
    await page.mouse.wheel(0, -80)
    await frames(page, 45)
    if (reader === "manual-32") {
      const { gap } = await readerState(page, scope)
      await page.mouse.wheel(0, gap - 32)
      await frames(page, 45)
    } else {
      await bottom(page, scope)
    }
    const before = await readerState(page, scope)
    const expected = reader === "manual-32"
      ? { followModeType: "escaped", latestButton: 1 }
      : { followModeType: "following", latestButton: 0 }
    assert.deepEqual({ followModeType: before.followModeType, latestButton: before.latestButton }, expected, JSON.stringify(before))
    if (transition === "switch") {
      await page.evaluate(() => (window as any).fixture.switchTo("B"))
      await frames(page, 30)
      await page.evaluate(() => (window as any).fixture.switchTo("A"))
    } else {
      await page.evaluate(() => { (window as any).fixture.switchAway(); (window as any).fixture.return() })
    }
    await frames(page, 90)
    const after = await readerState(page, scope)
    assert.deepEqual({ followModeType: after.followModeType, latestButton: after.latestButton }, expected, JSON.stringify({ before, after }))
    assert.ok(Math.abs(after.gap - before.gap) < 2, `Reader moved from ${before.gap}px to ${after.gap}px above the bottom`)
    if (reader === "following") assert.ok(after.gap <= 1, `Following reader left the bottom: ${after.gap}px`)
  }, { name: transition === "switch" ? "switch" : "session" })
})

for (const streamingSession of ["none", "A", "B"]) test(`retained A-B-A switch restores the reader (streaming=${streamingSession})`, async () => {
  await open(async page => {
    await page.locator('[data-session-id="A"] .message-stream').hover()
    await page.mouse.wheel(0, -1800)
    await frames(page, 45)
    const before = await page.evaluate(() => (window as any).fixture.snapshot().scroll)
    assert.equal(before.followModeType, "escaped")
    await traceAnchor(page, before.anchorKey)
    await page.evaluate(() => (window as any).fixture.switchTo("B"))
    await page.locator('[data-session-id="B"] .message-stream').waitFor({ state: "visible" })
    if (streamingSession !== "none") {
      await page.evaluate(id => { (window as any).fixture.start(id); (window as any).fixture.delta(id, "Initial B/A response.\n\n".repeat(10)) }, streamingSession)
    }
    await frames(page, 30)
    await page.evaluate(() => (window as any).fixture.switchTo("A"))
    const step = streamingSession === "none" ? undefined : `if (frame % 2 === 0) window.fixture.delta(${JSON.stringify(streamingSession)}, "Native continued response.\\n\\n".repeat(3))`
    const samples = await sampleAnchor(page, { key: before.anchorKey, stream: '[data-session-id="A"] .message-stream', count: 180, step })
    await assertAnchorHeld(page, samples, before.anchorOffset, 4, 30)
  }, { name: "switch" })
})

test("streaming at the tail never paints a backward jump", async () => {
  await open(async page => {
    await bottom(page)
    await page.evaluate(() => (window as any).fixture.start())
    await frames(page, 12)
    const samples = await sampleAnchor(page, { key: "msg_0059", stream: ".message-stream", count: 120, step: 'if (frame % 4 === 0) window.fixture.delta(`Chunk ${frame}\\n\\n` + "Variable response content.\\n\\n".repeat(frame % 5 + 1))' })
    const backwards = samples.slice(1).filter((sample, i) => sample.anchorOffset !== null && samples[i].anchorOffset !== null && sample.anchorOffset > samples[i].anchorOffset! + 2)
    assert.deepEqual(backwards, [], "Streaming moved a following reader backward")
  })
})

for (const streaming of [false, true]) test(`remount retains an intra-message anchor without oscillating (streaming=${streaming})`, async () => {
  await open(async page => {
    if (streaming) {
      await page.evaluate(() => { (window as any).fixture.start(); (window as any).fixture.delta("Initial response.\n\n".repeat(10)) })
      await frames(page, 45)
    }
    await page.locator(".message-stream").hover()
    await page.mouse.wheel(0, -1800)
    await frames(page, 45)
    const before = await page.evaluate(() => (window as any).fixture.snapshot().scroll)
    await traceAnchor(page, before.anchorKey)
    await page.evaluate(() => { (window as any).fixture.switchAway(); (window as any).fixture.return() })
    await page.waitForFunction(() => document.querySelector(".message-stream"))
    const samples = await sampleAnchor(page, { key: before.anchorKey, stream: ".message-stream", count: streaming ? 120 : 180, step: streaming ? 'if (frame % 2 === 0) window.fixture.delta("More streamed text.\\n\\n".repeat(3))' : undefined })
    await assertAnchorHeld(page, samples, before.anchorOffset, 4, 30)
  })
})

function topReader() {
  const el = document.querySelector(".message-stream")!, bounds = el.getBoundingClientRect()
  const row = Array.from(el.querySelectorAll("[data-virtual-follow-key]")).find(row => { const rect = row.getBoundingClientRect(); return rect.top <= bounds.top && rect.bottom > bounds.top })
  return { anchorKey: row?.getAttribute("data-virtual-follow-key"), state: (window as any).fixture.snapshot().scroll }
}

// Only "newer" is an opposite directional gesture; the others must not cancel:
// a touch tap (directionless touchstart intent), a primary click on message
// content (pointerdown), and a horizontal wheel.
for (const gesture of ["none", "same", "tap", "click", "horizontal", "newer"] as const) test(`delayed older-history positioning (gesture during load=${gesture})`, async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.delayNextHistory())
    const box = (await page.locator(".message-stream").boundingBox())!
    const [x, y] = [box.x + 10, box.y + box.height / 2]
    await page.mouse.move(x, y)
    await page.mouse.wheel(0, -1000000)
    await page.waitForFunction(() => (window as any).fixture.historyPending(), undefined, { timeout: 5000 })
    if (gesture === "same") await page.mouse.wheel(0, -1000)
    if (gesture === "tap") await page.touchscreen.tap(x, y)
    if (gesture === "click") await page.mouse.click(x, y)
    if (gesture === "horizontal") await page.mouse.wheel(200, 0)
    if (gesture === "newer") await page.mouse.wheel(0, 1000)
    await frames(page, 45)
    const before = await page.evaluate(topReader)
    await page.evaluate(() => (window as any).fixture.releaseHistory())
    await frames(page, 90)
    const after = await page.evaluate(topReader)
    if (gesture === "newer") {
      assert.ok(before.anchorKey, "The newer gesture must establish a visible reader anchor")
      assert.equal(after.anchorKey, before.anchorKey, `Late older history stole the newer reader: ${JSON.stringify({ before, after })}`)
      return
    }
    assert.equal(after.state.windowIsLatest, false, `The older page must commit: ${JSON.stringify(after)}`)
    assert.equal(after.state.followModeType, "escaped", "Entering older history must not retain follow")
    assert.equal(after.state.atBottom, true, "An older page is entered at its bottom")
  }, { history: 620, hasTouch: gesture === "tap" })
})
