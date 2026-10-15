import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { SCROLL_REASONS } from "../../src/components/virtual-scroll-trace"
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
  // Bare VirtualFollowList with one tall, resizable reply row.
  tall: "tall-append",
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

async function open(run: (page: Page) => Promise<void>, { name = "session", history = 60, hasTouch = false, hold = false, deviceScaleFactor = 1, zoom = 1 }: { name?: FixtureName; history?: number; hasTouch?: boolean; hold?: boolean; deviceScaleFactor?: number; zoom?: number } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: "en-US", hasTouch, deviceScaleFactor })
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
    if (zoom !== 1) await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom) }, zoom)
    await page.evaluate(`(async () => { const { applyUiSettings } = await import('/tests/browser/fixtures/ui-settings.ts'); await applyUiSettings({ holdLongAssistantReplies: ${hold}, locale: 'en' }) })()`)
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

// The store records a scroll once it settles (a pinned stream keeps scrolling);
// flush to read the position a state capture would persist now.
async function readerState(page: Page, scope = "") {
  const gap = await page.locator(`${scope} .message-stream`).evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
  const followModeType = await page.evaluate(async () => {
    const { messageStoreBus } = await import("/src/stores/message-v2/bus.ts" as any)
    messageStoreBus.flushScrollSnapshots()
    return (window as any).fixture.snapshot().scroll.followModeType
  })
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

type ScrollTraceEntry = { kind: "write" | "observe" | "mode" } & Record<string, any>

/** Parses the `scroll` logger's JSON lines; the namespace stays disabled until `enable`. */
function collectScrollTrace(page: Page) {
  const entries: ScrollTraceEntry[] = []
  page.on("console", message => {
    // debug's browser output interleaves %c colour directives.
    const match = /scroll (?:%c)?(write|observe|mode) (\{.*\})/.exec(message.text())
    if (match) entries.push({ kind: match[1] as ScrollTraceEntry["kind"], ...JSON.parse(match[2]) })
  })
  return { entries, enable: () => page.evaluate(() => (window as any).codenomadLogger.enableLogger("scroll")) }
}

test("the scroll trace emits coherent labelled writes and detects unclaimed movement", async () => {
  await open(async page => {
    const trace = collectScrollTrace(page)
    const stream = page.locator(".message-stream")
    await bottom(page)
    assert.deepEqual(trace.entries, [], "The trace is silent until enabled")
    assert.equal(await stream.getAttribute("data-scroll-write"), null, "No trace state is published while disabled")
    assert.equal(await stream.getAttribute("data-follow-mode"), "following")
    await trace.enable()
    await stream.hover()
    await page.mouse.wheel(0, -800)
    await frames(page, 45)
    assert.equal(await stream.getAttribute("data-follow-mode"), "escaped")
    const unlabelledStart = trace.entries.length
    const unlabelledOffset = await stream.evaluate(el => { el.scrollTop -= 40; return el.scrollTop })
    await frames(page, 4)
    const unlabelled = trace.entries.slice(unlabelledStart)
    assert.ok(!unlabelled.some(entry => entry.kind === "write"), "An injected outside write must not invent a labelled write")
    assert.ok(unlabelled.some(entry => entry.kind === "observe" && entry.owner === "unowned" && Math.abs(entry.to - unlabelledOffset) < 1), "An unlabelled writer must be visible as unowned")
    await stream.focus()
    await page.keyboard.press("End")
    await frames(page, 30)
    await page.evaluate(() => (window as any).fixture.start())
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => (window as any).fixture.delta("Traced streaming paragraph.\n\n".repeat(3)))
      await frames(page, 4)
    }
    await page.evaluate(() => { (window as any).fixture.switchAway(); (window as any).fixture.return() })
    await frames(page, 60)
    const writes = trace.entries.filter(entry => entry.kind === "write")
    assert.ok(writes.length > 0, "The scenario writes the transcript position")
    for (const write of writes) {
      assert.ok((SCROLL_REASONS as readonly string[]).includes(write.reason), `Unlabelled write: ${JSON.stringify(write)}`)
      assert.equal(write.session, "browser-session")
      assert.equal(typeof write.from, "number")
      if (write.to !== undefined) assert.ok(Math.abs(write.to - write.from) >= 1, `Synchronous no-op noise: ${JSON.stringify(write)}`)
      else {
        assert.equal(typeof write.now, "number", JSON.stringify(write))
        assert.notEqual(write.target, undefined, "An asynchronous request reports a target, not a pre-landing destination")
      }
    }
    const reasons = new Set(writes.map(write => write.reason))
    for (const reason of ["jump-bottom", "content-grew", "explicit-pin"]) assert.ok(reasons.has(reason), `Missing ${reason}: ${[...reasons]}`)
    const modes = trace.entries.filter(entry => entry.kind === "mode").map(({ from, to, source }) => `${from}>${to}:${source}`)
    assert.ok(modes.includes("following>escaped:user-gesture"), JSON.stringify(modes))
    assert.ok(modes.includes("escaped>following:jump-bottom"), JSON.stringify(modes))
    assert.ok(trace.entries.some(entry => entry.kind === "observe" && entry.owner === "unowned" && entry.intent === "up"), "The wheel is observed as an unowned user scroll")
    const live = page.locator(".message-stream")
    assert.equal(await live.getAttribute("data-scroll-write"), writes.at(-1)!.reason)
    assert.equal(await live.getAttribute("data-follow-mode"), (await readerState(page)).followModeType)
    const disabledStart = trace.entries.length
    await page.evaluate(() => (window as any).codenomadLogger.disableLogger("scroll"))
    await live.hover()
    await page.mouse.wheel(0, -80)
    await frames(page, 8)
    await live.focus()
    await page.keyboard.press("End")
    await frames(page, 30)
    assert.equal(await live.getAttribute("data-scroll-write"), null, "Disabling clears diagnostic DOM state on the next action")
    assert.deepEqual(trace.entries.slice(disabledStart), [], "No writes, observations or modes are logged after disabling")
  })
})

test("Virtua releases do not claim a wheel's movement or replace its preceding write", async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.nearTail())
    await frames(page, 30)
    const stream = page.locator(".message-stream")
    await stream.hover()
    const trace = collectScrollTrace(page)
    await trace.enable()
    await page.mouse.wheel(0, -80)
    await frames(page, 8)
    assert.ok(trace.entries.some(entry => entry.kind === "write" && entry.reason === "cancel-virtua"), "The wheel releases the earlier imperative index request")
    assert.ok(trace.entries.some(entry => entry.kind === "observe" && entry.owner === "unowned" && entry.intent === "up"), "The wheel belongs to the user, not its release")
    assert.equal(await stream.getAttribute("data-scroll-write"), null, "A release without a traced position write cannot publish an attribution")

    const start = trace.entries.length
    const moved = await page.evaluate(() => new Promise<{ at: number; offset: number; reason?: string }>(resolve => {
      const w = window as any
      w.fixture.align()
      w.fixture.roll()
      // Run after the rolling-window release in the same RAF batch. This is the
      // routing layer's scrollBy leg of the still-fresh upward wheel, without a
      // second wheel event that would clear the programmatic window first.
      queueMicrotask(() => requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(".message-stream")!
        const reason = el.dataset.scrollWrite
        el.scrollBy({ top: -80, behavior: "instant" })
        el.dispatchEvent(new Event("scroll"))
        resolve({ at: Math.round(performance.now()), offset: el.scrollTop, reason })
      }))
    }))
    await frames(page, 4)
    const entries = trace.entries.slice(start)
    const release = entries.find(entry => entry.kind === "write" && entry.reason === "window-shift")
    const preceding = entries.find(entry => entry.kind === "write" && entry.reason === "align-element")
    assert.ok(release && preceding, JSON.stringify(entries))
    assert.ok(moved.at - preceding.at < 120, "The displacement must occur during the preceding programmatic window")
    assert.equal(moved.reason, "align-element", "A window release preserves the preceding position-write reason")
    assert.ok(entries.some(entry => entry.kind === "observe" && entry.owner === "unowned" && entry.during === "align-element" && entry.intent === "up" && Math.abs(entry.to - moved.offset) < 1), JSON.stringify(entries))
    assert.ok(!entries.some(entry => entry.kind === "observe" && ["cancel-virtua", "window-shift"].includes(entry.owner)), "A release never owns an observation")
  }, { name: "list" })
})

// A gesture's predicted landing (its amplitude) must not overshoot the real
// one: CSS zoom scales wheel pixels by 1/zoom, and a page key moves Chromium's
// page step, so stopping above the bottom stays manual.
for (const [gesture, targetGap, zoom] of [["wheel", 64, 1], ["wheel", 32, 1], ["wheel", 32, 1.25], ["PageDown", 32, 1]] as const) test(`manual reading ${targetGap}px from bottom does not resume follow (${gesture} zoom=${zoom})`, async () => {
  await open(async page => {
    await bottom(page)
    const stream = page.locator(".message-stream")
    await stream.hover()
    await page.mouse.wheel(0, -800)
    await frames(page, 45)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().scroll.followModeType), "escaped")
    const gap = await stream.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
    // Page pixels: the native wheel moves deltaY / zoom scroller pixels.
    if (gesture === "wheel") {
      await page.evaluate(() => { (window as any).scrollObservations = [] })
      await page.mouse.wheel(0, (gap - targetGap) * zoom)
    } else {
      const pageStep = await stream.evaluate(el => Math.floor(el.clientHeight * 0.875))
      await page.mouse.wheel(0, (gap - pageStep - targetGap) * zoom)
      await frames(page, 45)
      await stream.focus()
      await page.evaluate(() => { (window as any).scrollObservations = [] })
      await page.keyboard.press("PageDown")
    }
    await frames(page, 45)
    const observations = await page.evaluate(() => (window as any).scrollObservations)
    assert.ok(observations.some((sample: any) => Math.abs(sample.gap - targetGap) < 2), `The native ${gesture} must stop at ${targetGap}px: ${JSON.stringify(observations)}`)
    const state = await page.evaluate(() => (window as any).fixture.snapshot().scroll)
    assert.equal(state.followModeType, "escaped", `Proximity to the bottom is not explicit follow: ${JSON.stringify(state)}`)
    assert.equal(await latestButton(page).count(), 1, "A manual reader above the true bottom keeps the latest button")
  }, { zoom })
})

// Smoke coverage only: these geometries land within 1px of the reported bottom,
// so they do not pin SCROLL_EDGE_TOLERANCE_PX (rendered geometry depends on the
// installed fonts). The measured CSS-zoom residuals in virtual-follow-behavior.test.ts do.
for (const [deviceScaleFactor, zoom] of [[1, 1], [1.5, 1.1], [1, 0.75]]) test(`the true bottom stays reachable by wheel (smoke, dpr=${deviceScaleFactor} zoom=${zoom})`, async () => {
  await open(async page => {
    await bottom(page)
    await page.locator(".message-stream").hover()
    await page.mouse.wheel(0, -80)
    await frames(page, 45)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().scroll.followModeType), "escaped")
    await page.mouse.wheel(0, 400)
    await frames(page, 45)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().scroll.followModeType), "following")
  }, { deviceScaleFactor, zoom })
})

// A wheel is clamped to the bottom laid out when it was made, and a page key
// animates towards the bottom captured when it starts, so streamed growth
// leaves either landing short of the new bottom. The reply starts short so its
// later outgrowing of the viewport (a separate virtualizer re-estimation)
// cannot coincide with the landing.
for (const [gesture, zoom] of [["wheel 600", 1], ["wheel 5000", 1], ["wheel 600", 1.1], ["PageDown", 1], ["PageDown", 1.25]] as const) test(`a ${gesture} to the growing streaming tail resumes follow (zoom=${zoom})`, async () => {
  await open(async page => {
    await bottom(page)
    await page.evaluate(() => (window as any).fixture.start())
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => (window as any).fixture.delta("Streaming paragraph text.\n\n".repeat(2)))
      await frames(page, 2)
    }
    const stream = page.locator(".message-stream")
    await stream.hover()
    await page.mouse.wheel(0, -300)
    await frames(page, 30)
    assert.equal((await readerState(page)).followModeType, "escaped")
    if (gesture === "PageDown") await stream.focus()
    const pump = page.evaluate(() => new Promise<void>(resolve => {
      let count = 0
      const tick = () => { (window as any).fixture.delta("More streaming text.\n\n"); if (++count < 60) requestAnimationFrame(tick); else resolve() }
      requestAnimationFrame(tick)
    }))
    if (gesture === "PageDown") await page.keyboard.press("PageDown")
    else await page.mouse.wheel(0, gesture === "wheel 600" ? 600 : 5000)
    await pump
    await frames(page, 10)
    // The pinned stream never settles: resuming follow is persisted without a
    // flush, once at the bottom, so it restores as following.
    const resumed = await page.evaluate(() => (window as any).fixture.snapshot().scroll)
    assert.deepEqual({ followModeType: resumed.followModeType, atBottom: resumed.atBottom }, { followModeType: "following", atBottom: true }, JSON.stringify(resumed))
    const state = await readerState(page)
    assert.deepEqual({ followModeType: state.followModeType, latestButton: state.latestButton }, { followModeType: "following", latestButton: 0 }, JSON.stringify(state))
    assert.ok(state.gap <= 2, `The resumed reader must stay at the streaming tail: ${state.gap}px`)
  }, { zoom })
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

// Plain buttons and links do not consume arrows: Chromium scrolls their
// scroller, so an arrow from a focused output action is still scroll intent.
test("an arrow key from a button inside growing nested output escapes its follow", async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.bottom())
    const output = page.locator("[data-nested-output]")
    await output.waitFor({ state: "visible" })
    await page.evaluate(() => (window as any).fixture.renderOutput())
    await page.waitForFunction(() => (document.querySelector("[data-nested-output]")?.scrollTop ?? 0) > 1000)
    await frames(page, 10)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().innerFollow), true)
    await page.locator("[data-output-action]").evaluate(button => (button as HTMLElement).focus({ preventScroll: true }))
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("ArrowUp")
      await frames(page, 10)
    }
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => (window as any).fixture.growOutput(20))
      await frames(page, 4)
    }
    const innerFollow = await page.evaluate(() => (window as any).fixture.snapshot().innerFollow)
    const gap = await output.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
    assert.equal(innerFollow, false, `Arrow keys from a focused button must take ownership (gap ${gap}px)`)
    assert.ok(gap > 100, `The escaped output must not be repinned: ${gap}px`)
  }, { name: "nested" })
})

// Tool/reasoning output shares the transcript's gesture rule: reaching a
// growing output's bottom by wheel or key resumes its follow.
for (const gesture of ["wheel", "PageDown"] as const) test(`a ${gesture} to growing nested output resumes its follow`, async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.bottom())
    const output = page.locator("[data-nested-output]")
    await output.waitFor({ state: "visible" })
    await page.evaluate(() => (window as any).fixture.renderOutput())
    await page.waitForFunction(() => (document.querySelector("[data-nested-output]")?.scrollTop ?? 0) > 1000)
    await output.hover()
    await page.mouse.wheel(0, -150)
    await frames(page, 10)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().innerFollow), false)
    if (gesture === "PageDown") await output.focus()
    const pump = page.evaluate(() => new Promise<void>(resolve => {
      let count = 0
      const tick = () => { (window as any).fixture.growOutput(20); if (++count < 60) requestAnimationFrame(tick); else resolve() }
      requestAnimationFrame(tick)
    }))
    if (gesture === "PageDown") await page.keyboard.press("PageDown")
    else await page.mouse.wheel(0, 600)
    await pump
    await frames(page, 10)
    const innerFollow = await page.evaluate(() => (window as any).fixture.snapshot().innerFollow)
    const gap = await output.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
    assert.equal(innerFollow, true, `The output must follow its growing tail again (gap ${gap}px)`)
    assert.ok(gap <= 2, `The resumed output must stay at its tail: ${gap}px`)
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

// Scrolling persists once settled, without a flush; a session switch or unmount
// (both unmount the section) or a state-capture flush before then records the
// reached position, anchored on the row then at the top of the viewport.
for (const transition of ["switch", "unmount", "flush"] as const) test(`an unsettled scroll is persisted on ${transition}`, async () => {
  const scope = transition === "switch" ? '[data-session-id="A"]' : ""
  // Live reader position: top-row anchor (as selectTopViewportAnchor picks it) and bottom gap.
  const live = (scope: string) => {
    const stream = document.querySelector(`${scope} .message-stream`)!, top = stream.getBoundingClientRect().top
    const rows = Array.from(stream.querySelectorAll<HTMLElement>("[data-virtual-follow-key]"), row => {
      const rect = row.getBoundingClientRect()
      return { key: row.dataset.virtualFollowKey!, top: rect.top - top, bottom: rect.bottom - top }
    }).filter(row => row.bottom > 0 && row.top < stream.clientHeight)
    const anchor = rows.filter(row => row.top <= 0).sort((a, b) => b.top - a.top)[0] ?? rows.sort((a, b) => a.top - b.top)[0]
    return { scrollTop: stream.scrollTop, gap: stream.scrollHeight - stream.clientHeight - stream.scrollTop, anchorKey: anchor?.key, anchorOffset: anchor?.top }
  }
  const assertAnchored = (persisted: any, reached: ReturnType<typeof live>) => {
    assert.ok(Math.abs(persisted.scrollTop - reached.scrollTop) <= 1, JSON.stringify({ persisted, reached }))
    assert.equal(persisted.anchorKey, reached.anchorKey, JSON.stringify({ persisted, reached }))
    assert.ok(Math.abs(persisted.anchorOffset - reached.anchorOffset!) <= 2, JSON.stringify({ persisted, reached }))
  }
  await open(async page => {
    await page.evaluate(scope => document.querySelector(`${scope} .message-stream`)!.addEventListener("scroll", () => { (window as any).lastScrollAt = Date.now() }, { passive: true }), scope)
    await page.locator(`${scope} .message-stream`).hover()
    await page.mouse.wheel(0, -900)
    // Settles without a flush: wait for a write after the last scroll event,
    // not a frame count.
    await page.waitForFunction(`window.fixture.snapshot().scroll.updatedAt > window.lastScrollAt
      && Math.abs(window.fixture.snapshot().scroll.scrollTop - document.querySelector(${JSON.stringify(`${scope} .message-stream`)}).scrollTop) <= 1`, undefined, { timeout: 3000 })
    const settled = await page.evaluate(`({ persisted: window.fixture.snapshot().scroll, reached: (${live})(${JSON.stringify(scope)}) })`) as any
    assertAnchored(settled.persisted, settled.reached)
    // Scroll again and transition in the scroll event's task, before the
    // scroll-end timer can fire, whatever the load.
    const result = await page.evaluate(`(async () => {
      const fixture = window.fixture
      const { messageStoreBus } = await import("/src/stores/message-v2/bus.ts")
      const stream = document.querySelector(${JSON.stringify(`${scope} .message-stream`)})
      await new Promise(resolve => { stream.addEventListener("scroll", resolve, { once: true }); stream.scrollTop -= 600 })
      const reached = (${live})(${JSON.stringify(scope)})
      const pending = fixture.snapshot().scroll.scrollTop
      if (${JSON.stringify(transition)} === "switch") fixture.switchTo("B")
      else if (${JSON.stringify(transition)} === "unmount") fixture.switchAway()
      else messageStoreBus.flushScrollSnapshots()
      return { reached, pending, persisted: fixture.snapshot().scroll }
    })()`) as any
    assert.ok(Math.abs(result.pending - result.reached.scrollTop) > 100, `The scroll had already settled: ${JSON.stringify(result)}`)
    assertAnchored(result.persisted, result.reached)
    assert.equal(result.persisted.followModeType, "escaped")
    if (transition === "flush") return
    await frames(page, 30)
    await page.evaluate(transition => transition === "switch" ? (window as any).fixture.switchTo("A") : (window as any).fixture.return(), transition)
    await frames(page, 90)
    const restored = await page.evaluate(`(${live})(${JSON.stringify(scope)})`) as any
    assert.ok(Math.abs(restored.gap - result.reached.gap) <= 2, `Returned ${restored.gap}px above the bottom, left at ${result.reached.gap}px`)
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

// Unlike Space, a pointer press on a <summary> still starts middle-button
// autoscroll and text-selection drags, so their upward movement must escape a
// streaming follow instead of fighting the pin.
for (const gesture of ["middle-button autoscroll", "selection drag"] as const) test(`a ${gesture} started on a summary escapes a streaming follow`, async () => {
  await open(async page => {
    await bottom(page)
    await page.evaluate(() => (window as any).fixture.start())
    await frames(page, 4)
    const stream = page.locator(".message-stream")
    // Turn an in-flow transcript paragraph, well inside the viewport, into a summary.
    await stream.evaluate(el => {
      const bounds = el.getBoundingClientRect()
      const paragraph = Array.from(el.querySelectorAll<HTMLElement>("[data-virtual-follow-key] p"))
        .find(p => { const rect = p.getBoundingClientRect(); return rect.top >= bounds.top + 150 && rect.bottom <= bounds.bottom - 150 })!
      const details = document.createElement("details")
      details.innerHTML = "<summary data-press-target>Summary text that can be selected</summary><p>Body</p>"
      paragraph.replaceWith(details)
    })
    await frames(page, 10)
    assert.equal((await readerState(page)).followModeType, "following")
    const box = (await page.locator("[data-press-target]").boundingBox())!
    const [x, y] = [box.x + 40, box.y + box.height / 2]
    assert.ok(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest("[data-press-target]")), [x, y]), "The press must hit the summary")
    await page.mouse.move(x, y)
    await page.mouse.down({ button: gesture === "selection drag" ? "left" : "middle" })
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(x, y - i * 10)
      await page.evaluate(() => (window as any).fixture.delta("Streamed while the pointer drags.\n\n"))
      await frames(page, 3)
    }
    await page.mouse.up({ button: gesture === "selection drag" ? "left" : "middle" })
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => (window as any).fixture.delta("Streamed after release.\n\n".repeat(2)))
      await frames(page, 3)
    }
    // The persisted snapshot updates on scroll events, which an escaped reader
    // does not produce while content grows below; assert the visible state.
    const state = await readerState(page)
    assert.equal(state.latestButton, 1, `The ${gesture} must take ownership from the follow pin: ${JSON.stringify(state)}`)
    assert.ok(state.gap > 48, `The reader must not be repinned to the streaming tail: ${JSON.stringify(state)}`)
  })
})

// Space toggles a focused <summary> (like a button) instead of scrolling, so
// it must not carry a page amplitude that "reaches" the bottom.
for (const control of ["summary", "button"] as const) test(`Space on a focused ${control} near the bottom keeps manual reading`, async () => {
  await open(async page => {
    await bottom(page)
    const stream = page.locator(".message-stream")
    await stream.hover()
    await page.mouse.wheel(0, -324)
    await frames(page, 45)
    await stream.evaluate((el, control) => {
      const bounds = el.getBoundingClientRect()
      const row = Array.from(el.querySelectorAll<HTMLElement>("[data-virtual-follow-key]"))
        .find(row => { const rect = row.getBoundingClientRect(); return rect.top >= bounds.top && rect.bottom <= bounds.bottom })!
      const host = control === "summary" ? document.createElement("details") : document.createElement("div")
      host.innerHTML = control === "summary" ? "<summary data-space-target>Details</summary><p style='height:120px'>Body</p>" : "<button type='button' data-space-target>Act</button>"
      row.prepend(host)
    }, control)
    await frames(page, 30)
    const before = await readerState(page)
    assert.equal(before.followModeType, "escaped")
    assert.ok(before.gap > 40 && before.gap < 500, `Space's page amplitude would reach the bottom from here: ${before.gap}px`)
    await page.locator("[data-space-target]").evaluate(target => (target as HTMLElement).focus({ preventScroll: true }))
    await page.keyboard.press(" ")
    await frames(page, 45)
    const after = await readerState(page)
    assert.deepEqual({ followModeType: after.followModeType, latestButton: after.latestButton }, { followModeType: "escaped", latestButton: 1 }, JSON.stringify({ before, after }))
    assert.ok(after.gap >= before.gap - 2, `Space on a ${control} must not move the reader to the bottom: ${JSON.stringify({ before, after })}`)
  })
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

/** Trace moves no write claimed (Virtua, browser or gesture), for failure messages. */
function unownedMoves(entries: ScrollTraceEntry[]) {
  return entries.filter(entry => entry.kind === "observe" && entry.owner === "unowned")
    .map(({ from, to, top, scrollHeight, intent }) => ({ from, to, top, scrollHeight, intent }))
}

// Growth below an escaped reader must not move it. A remounted Virtualizer
// (each short append while following) used to re-estimate its default row size
// once newly measured rows outgrew the viewport, shrinking never-measured history
// rows above the reader; near the bottom the browser clamped before Virtua's
// compensation, landing the reader many rows back.
test("streaming below an escaped reader near the tail never moves it", async () => {
  await open(async page => {
    const trace = collectScrollTrace(page)
    await bottom(page)
    await page.evaluate(() => (window as any).fixture.start())
    await page.evaluate(() => (window as any).fixture.delta("Initial response.\n\n".repeat(3)))
    await frames(page, 12)
    await trace.enable()
    await page.locator(".message-stream").hover()
    await page.mouse.wheel(0, -240)
    await frames(page, 45)
    const before = await page.evaluate(topReader)
    assert.equal(before.state.followModeType, "escaped")
    const anchor = await page.locator(`[data-virtual-follow-key="${before.anchorKey}"]`).evaluate(row => row.getBoundingClientRect().top - row.closest(".message-stream")!.getBoundingClientRect().top)
    await traceAnchor(page, before.anchorKey!)
    const samples = await sampleAnchor(page, { key: before.anchorKey!, stream: ".message-stream", count: 120, step: 'if (frame % 2 === 0) window.fixture.delta("Streamed paragraph below the reader.\\n\\n".repeat(3))' })
    const moved = samples.filter(sample => sample.anchorOffset === null || Math.abs(sample.anchorOffset - anchor) > 2)
    assert.deepEqual(moved, [], `The escaped reader moved (${before.anchorKey} at ${anchor}px): ${JSON.stringify({ moved: moved.slice(0, 3), unowned: unownedMoves(trace.entries) })}`)
  })
})

/** Streams into A from the bottom until the long-reply hold escapes follow; returns the per-frame top row. */
async function streamUntilHold(page: Page, scope: string) {
  await bottom(page, scope)
  await page.evaluate(stream => {
    const w = window as any
    w.topRows = []
    const tick = () => {
      const el = document.querySelector(stream)!, bounds = el.getBoundingClientRect()
      const row = Array.from(el.querySelectorAll("[data-virtual-follow-key]")).find(row => { const rect = row.getBoundingClientRect(); return rect.top <= bounds.top && rect.bottom > bounds.top })
      w.topRows.push(row?.getAttribute("data-virtual-follow-key"))
      if (!w.stopTopRows) requestAnimationFrame(tick)
    }
    w.stopTopRows = false
    requestAnimationFrame(tick)
  }, `${scope} .message-stream`)
  await page.evaluate(() => (window as any).fixture.start("A"))
  const stream = page.locator(`${scope} .message-stream`)
  let held = false
  for (let i = 0; i < 200 && !held; i++) {
    await page.evaluate(() => (window as any).fixture.delta("A", "Long streamed paragraph for the hold.\n\n".repeat(2)))
    await frames(page, 2)
    held = await stream.getAttribute("data-follow-mode") === "escaped"
  }
  assert.ok(held, "A long streamed reply must engage the hold")
  // The hold scrolls nothing, so it must publish the held position itself.
  assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().scroll.followModeType), "escaped", "The hold must persist its escaped position")
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => (window as any).fixture.delta("A", "After hold.\n\n"))
    await frames(page, 2)
  }
  return page.evaluate(() => { (window as any).stopTopRows = true; return (window as any).topRows as Array<string | undefined> })
}

test("the long-reply hold persists while streaming and the latest button resumes", async () => {
  const scope = '[data-session-id="A"]'
  await open(async page => {
    await streamUntilHold(page, scope)
    const held = await readerState(page, scope)
    assert.deepEqual({ followModeType: held.followModeType, latestButton: held.latestButton }, { followModeType: "escaped", latestButton: 1 }, JSON.stringify(held))
    await bottom(page, scope)
    const resumed = await readerState(page, scope)
    assert.deepEqual({ followModeType: resumed.followModeType, latestButton: resumed.latestButton }, { followModeType: "following", latestButton: 0 }, JSON.stringify(resumed))
    assert.ok(resumed.gap <= 1, `The latest button must reach the streaming tail: ${resumed.gap}px`)
  }, { name: "switch", hold: true })
})

// The hold only escapes follow; it must not hand the next default-size
// re-estimate of never-measured history rows a visible clamp (see above).
test("the long-reply hold keeps the streaming reply in view when it escapes", async () => {
  const scope = '[data-session-id="A"]'
  await open(async page => {
    const trace = collectScrollTrace(page)
    await trace.enable()
    const topRows = await streamUntilHold(page, scope)
    // A frame without a row at the viewport top is a blank gap: displaced too.
    // The hold escape does not remount the list, so no blank remount frame is expected.
    const displaced = topRows.filter(key => !key || (key !== "stream-A" && !/^msg_005[5-9]_A$/.test(key)))
    assert.deepEqual(displaced, [], `The hold escape moved the reader away from the streaming tail: ${JSON.stringify({ topRows: [...new Set(topRows)], unowned: unownedMoves(trace.entries) })}`)
  }, { name: "switch", hold: true })
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

// Deactivation abandons a restoration in flight without settling it. Neither its
// `restoring` state nor its armed anchor restart may outlive the inactive view:
// after reactivation, following growth pins the bottom again (no gesture, which
// would cancel the stale restoration and hide it).
test("deactivating during a restoration leaves following intact after reactivation", async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    const target = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.ok(target.anchorKey && !target.atBottom, JSON.stringify(target))
    await page.evaluate(() => (window as any).fixture.bottom())
    await frames(page)
    await page.evaluate(target => (window as any).fixture.deactivateDuringRestore(target), target)
    await frames(page)
    await page.evaluate(() => (window as any).fixture.activate())
    await frames(page)
    await page.evaluate(() => (window as any).fixture.append())
    await frames(page)
    const gap = await page.locator(".message-stream").evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
    assert.deepEqual({ following: await page.evaluate(() => (window as any).fixture.autoScroll()), atBottom: gap <= 1 }, { following: true, atBottom: true }, `gap=${gap}`)
  }, { name: "list" })
})

// A session without a snapshot opens at its bottom once. Persisting the first
// gesture's position must not restart that restore under the reader.
test("the first gesture after a snapshot-less restore is not restored again", async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.switchAway())
    await page.evaluate(`(async () => {
      const { messageStoreBus } = await import('/src/stores/message-v2/bus.ts')
      messageStoreBus.getOrCreate('browser-instance').clearScrollSnapshots()
    })()`)
    await page.evaluate(() => (window as any).fixture.return())
    await page.locator(".message-stream").waitFor()
    await frames(page, 90)
    await traceAnchor(page, "msg_0059")
    await page.locator(".message-stream").hover()
    await page.mouse.wheel(0, -600)
    await frames(page, 60)
    const offsets: number[] = await page.evaluate(() => (window as any).scrollObservations.map((sample: any) => sample.anchorOffset).filter((offset: number | null) => offset !== null))
    assert.ok(offsets.length > 0, "The gesture must scroll the transcript")
    // Scrolling up only moves later rows down; a restore jumps them back.
    const reversals = offsets.slice(1).filter((offset, i) => offset < offsets[i] - 2)
    assert.deepEqual(reversals, [], `A restore moved the reader during its gesture: ${JSON.stringify(offsets)}`)
    assert.equal((await readerState(page)).followModeType, "escaped")
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

type FrameSample = { frame: number; time: number; top: number; gap: number; mode?: string; anchorOffset: number | null }

/**
 * For `count` frames, samples the painted stream (the previous frame's writes
 * and layout) and then runs `step(frame)`. `window.pumpFrame` reports progress
 * so a gesture can be timed against it; `window.traceKey` selects the anchor.
 */
function pump(page: Page, count: number, step = "") {
  return page.evaluate(({ count, step }) => new Promise<FrameSample[]>(resolve => {
    const w = window as any, run = new Function("frame", step), samples: FrameSample[] = []
    w.pumpFrame = 0
    const next = () => {
      const el = document.querySelector<HTMLElement>(".message-stream")!, row = w.traceKey ? el.querySelector(`[data-virtual-follow-key="${w.traceKey}"]`) : null
      samples.push({ frame: w.pumpFrame, time: performance.now(), top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop, mode: el.dataset.followMode, anchorOffset: row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null })
      run(w.pumpFrame)
      if (++w.pumpFrame === count) resolve(samples); else requestAnimationFrame(next)
    }
    requestAnimationFrame(next)
  }), { count, step })
}

/** Writes that move the reader towards the bottom. */
const BOTTOM_WRITES = ["jump-bottom", "explicit-pin", "content-grew", "observe", "viewport-resize"]

/** Index of the last user-gesture escape in the trace, or -1. */
function lastEscape(entries: ScrollTraceEntry[]) {
  return entries.map(entry => entry.kind === "mode" && entry.to === "escaped" && entry.source === "user-gesture").lastIndexOf(true)
}

const SETTLE_STEP = "if (frame === 0) window.fixture.settle().then(s => { window.settlement = { s, frame: window.pumpFrame } });"

async function wheelToTop(page: Page) {
  await page.locator(".message-stream").hover()
  await page.mouse.wheel(0, -100000)
  await page.waitForFunction(() => document.querySelector(".message-stream")!.scrollTop === 0)
  await frames(page)
}

// Bottom pins (settleAtBottom, intent pins) own the bottom until they settle;
// a gesture or a restoration ends that ownership for good.
test("an upward wheel cancels a settling bottom pin and later growth never repins it", async () => {
  await open(async page => {
    const trace = collectScrollTrace(page)
    await wheelToTop(page)
    await trace.enable()
    const pumped = pump(page, 70, `${SETTLE_STEP} window.fixture.resizeReply(3200 + frame * 40)`)
    await page.waitForFunction(() => (window as any).pumpFrame >= 15)
    await page.mouse.wheel(0, -600)
    const samples = await pumped
    await frames(page, 10)
    const settlement = await page.evaluate(() => (window as any).settlement)
    const diagnostics = JSON.stringify({ settlement, samples: samples.map(({ frame, top, gap, mode }) => ({ frame, top, gap, mode })) })
    assert.ok(samples.some(sample => sample.frame < 15 && sample.gap <= 2), `The pin must reach the growing bottom before the wheel: ${diagnostics}`)
    assert.equal(settlement?.s, "cancelled", diagnostics)
    const escape = lastEscape(trace.entries)
    assert.ok(escape >= 0, `The wheel must escape the pin: ${JSON.stringify(trace.entries.filter(entry => entry.kind === "mode"))}`)
    const repins = trace.entries.slice(escape).filter(entry => entry.kind === "write" && BOTTOM_WRITES.includes(entry.reason))
    assert.deepEqual(repins, [], `No bottom write may follow the escape: ${diagnostics}`)
    const escaped = samples.slice(samples.findIndex(sample => sample.frame >= 15 && sample.mode === "escaped"))
    assert.ok(escaped.length > 10 && escaped.every(sample => sample.mode === "escaped"), `The reader must stay escaped: ${diagnostics}`)
    assert.ok(escaped.every((sample, i) => i === 0 || sample.top <= escaped[i - 1].top + 2), `Growth moved the escaped reader down: ${diagnostics}`)
    const final = await page.locator(".message-stream").evaluate(el => ({ gap: el.scrollHeight - el.clientHeight - el.scrollTop, mode: (el as HTMLElement).dataset.followMode }))
    assert.ok(final.mode === "escaped" && final.gap > 300, `The reader was repinned: ${JSON.stringify(final)}; ${diagnostics}`)
  }, { name: "tall" })
})

test("settleAtBottom outlasts late growth and settles following at the true bottom", async () => {
  await open(async page => {
    await wheelToTop(page)
    const samples = await pump(page, 45, `${SETTLE_STEP} if (frame >= 4 && frame <= 9) window.fixture.resizeReply(3200 + (frame - 3) * 150)`)
    await frames(page, 10)
    const settlement = await page.evaluate(() => (window as any).settlement)
    const final = await page.locator(".message-stream").evaluate(el => ({ gap: el.scrollHeight - el.clientHeight - el.scrollTop, mode: (el as HTMLElement).dataset.followMode }))
    const diagnostics = JSON.stringify({ settlement, final, samples: samples.map(({ frame, gap, mode }) => ({ frame, gap, mode })) })
    assert.equal(settlement?.s, "settled", diagnostics)
    assert.ok(settlement.frame > 9, `The pin must settle after the last growth: ${diagnostics}`)
    assert.ok(final.gap <= 2 && final.mode === "following", diagnostics)
    assert.deepEqual(samples.filter(sample => sample.frame >= 12 && sample.gap > 2), [], `The late growth left the bottom: ${diagnostics}`)
  }, { name: "tall" })
})

test("an explicit bottom-pin intent reaches the real bottom, stays cancelled for its token and restarts on a new one", async () => {
  await open(async page => {
    const trace = collectScrollTrace(page)
    const state = () => page.evaluate(() => {
      const w = window as any, el = document.querySelector<HTMLElement>(".message-stream")!
      const last = el.querySelector(`[data-virtual-follow-key="row-${w.fixture.itemCount() - 1}"]`)
      return { items: w.fixture.itemCount(), gap: el.scrollHeight - el.clientHeight - el.scrollTop, mode: el.dataset.followMode, cancelled: w.fixture.pinCancelled(), lastBottom: last ? last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom : null }
    })
    const atBottom = (value: Awaited<ReturnType<typeof state>>) => value.mode === "following" && value.gap <= 2 && value.lastBottom !== null && Math.abs(value.lastBottom) <= 2
    await page.locator(".message-stream").hover()
    await trace.enable()

    // minItemCount above the row count: the pin outlasts progressive appends.
    const first = await pump(page, 40, "if (frame === 0) window.fixture.pin('first', 205); if (frame % 4 === 1 && window.fixture.itemCount() < 205) window.fixture.append()")
    await frames(page, 20)
    const reached = await state()
    assert.ok(reached.items === 205 && reached.cancelled === 0 && atBottom(reached), `The pin must reach the real bottom after the appends: ${JSON.stringify({ reached, first: first.map(({ frame, gap, mode }) => ({ frame, gap, mode })) })}`)

    // A wheel cancels the active pin and notifies once; re-emitting its token is inert.
    await page.evaluate(() => (window as any).fixture.pin("second", 1000))
    await frames(page, 10)
    await page.mouse.wheel(0, -600)
    await frames(page, 30)
    const cancelled = await state()
    assert.deepEqual({ mode: cancelled.mode, cancelled: cancelled.cancelled }, { mode: "escaped", cancelled: 1 }, JSON.stringify(cancelled))
    const escape = lastEscape(trace.entries)
    assert.ok(escape >= 0, JSON.stringify(trace.entries.filter(entry => entry.kind === "mode")))
    const reemitted = await pump(page, 30, "if (frame === 0) window.fixture.pin('second', 1000); if (frame % 3 === 1) window.fixture.append()")
    await frames(page, 10)
    const inert = await state()
    const diagnostics = JSON.stringify({ cancelled, inert, reemitted: reemitted.map(({ frame, gap, mode }) => ({ frame, gap, mode })) })
    assert.deepEqual(trace.entries.slice(escape).filter(entry => entry.kind === "write" && entry.reason === "explicit-pin"), [], `A re-emitted cancelled token must not pin: ${diagnostics}`)
    assert.equal(inert.cancelled, 1, `Cancellation must be notified exactly once: ${diagnostics}`)
    assert.equal(inert.mode, "escaped", diagnostics)
    assert.ok(reemitted.every(sample => sample.gap >= cancelled.gap - 2) && inert.gap > cancelled.gap, `The escaped reader moved towards the bottom: ${diagnostics}`)

    // A new token pins again, through further appends.
    const restartAt = trace.entries.length
    const restarted = await pump(page, 30, "if (frame === 0) window.fixture.pin('third', window.fixture.itemCount() + 3); if (frame % 4 === 1 && frame < 12) window.fixture.append()")
    await frames(page, 20)
    const final = await state()
    const finalDiagnostics = JSON.stringify({ inert, final, restarted: restarted.map(({ frame, gap, mode }) => ({ frame, gap, mode })) })
    assert.ok(trace.entries.slice(restartAt).some(entry => entry.kind === "write" && entry.reason === "explicit-pin"), `A new token must pin again: ${finalDiagnostics}`)
    assert.ok(final.items === inert.items + 3 && final.cancelled === 1 && atBottom(final), `The new pin must reach the real bottom: ${finalDiagnostics}`)
  }, { name: "list" })
})

// Desired behavior: an explicit restoration supersedes an active bottom pin and
// reports itself applied only once its anchor has landed.
test("restoring an escaped anchor during settleAtBottom wins over the pin", async () => {
  await open(async page => {
    const trace = collectScrollTrace(page)
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    await page.locator(".message-stream").hover()
    // Virtua's settled scrollToKey index still reasserts over the first wheel.
    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, 100)
      await frames(page, 45)
    }
    const target = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.ok(target.anchorKey && target.anchorOffset !== 0 && !target.atBottom && target.followModeType === "escaped", JSON.stringify(target))
    await traceAnchor(page, target.anchorKey)
    await trace.enable()
    await page.evaluate(target => { const w = window as any; w.restoreTarget = target; w.applied = []; w.restoreCancelled = 0 }, target)
    // Growth restarts anchor stability, so it stops early enough to observe the finish.
    const samples = await pump(page, 90, `${SETTLE_STEP}
      if (frame % 2 === 1 && frame < 30) window.fixture.append()
      if (frame === 6) {
        window.restoreAt = performance.now()
        window.fixture.restore(window.restoreTarget, {
          onApplied: () => {
            const el = document.querySelector(".message-stream"), row = el.querySelector('[data-virtual-follow-key="' + window.restoreTarget.anchorKey + '"]')
            window.applied.push({ frame: window.pumpFrame, anchorOffset: row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null })
          },
          onCancelled: () => { window.restoreCancelled++ },
        })
      }`)
    await frames(page, 20)
    const result = await page.evaluate(() => { const w = window as any; return { applied: w.applied, cancelled: w.restoreCancelled, settlement: w.settlement, restoreAt: w.restoreAt } })
    const diagnostics = JSON.stringify({ target, result, samples: samples.map(({ frame, gap, mode, anchorOffset }) => ({ frame, gap, mode, anchorOffset })) })
    assert.equal(result.applied.length, 1, diagnostics)
    assert.ok(result.applied[0].anchorOffset !== null && Math.abs(result.applied[0].anchorOffset - target.anchorOffset) <= 2, `onApplied must follow the anchor landing: ${diagnostics}`)
    assert.equal(result.settlement?.s, "interrupted", `The restoration must interrupt the pin: ${diagnostics}`)
    const held = samples.filter(sample => sample.frame > result.applied[0].frame)
    assert.ok(held.length > 0 && held.every(sample => sample.anchorOffset !== null && Math.abs(sample.anchorOffset - target.anchorOffset) <= 2), `The restored anchor must hold: ${diagnostics}`)
    // Trace times are rounded: a same-frame write just before the restoration rounds up to it.
    const pins = trace.entries.filter(entry => entry.kind === "write" && entry.reason === "explicit-pin" && entry.at > Math.ceil(result.restoreAt))
    assert.deepEqual(pins, [], `The pin wrote after the restoration: ${diagnostics}`)
    assert.equal(result.cancelled, 0, diagnostics)
  }, { name: "list" })
})

// An in-place reveal is held for the former 30-frame alignment window, counted
// from the request: growth above and a viewport resize (composer growth) within it
// re-align the target; layout after it is no longer corrected.
test("alignElement holds its target through growth and a viewport resize within its window, then lets go", async () => {
  await open(async page => {
    const trace = collectScrollTrace(page)
    await page.evaluate(() => (window as any).fixture.nearTail())
    await frames(page)
    await traceAnchor(page, "row-180")
    await trace.enable()
    const samples = await pump(page, 70, `if (frame === 0) window.fixture.align('row-180', 8)
      if (frame >= 2 && frame <= 14) window.fixture.resizeRow('row-179', 48 + (frame - 1) * 12)
      if (frame === 18) document.getElementById('root').style.height = '560px'
      if (frame === 45) window.lateAt = performance.now()
      if (frame >= 45 && frame <= 55) window.fixture.resizeRow('row-179', 204 + (frame - 44) * 20)`)
    const lateAt = await page.evaluate(() => (window as any).lateAt)
    const late = trace.entries.filter(entry => entry.kind === "write" && entry.reason === "align-element" && entry.at > Math.ceil(lateAt))
    const diagnostics = JSON.stringify({ late, samples: samples.map(({ frame, top, anchorOffset }) => ({ frame, top, anchorOffset })) })
    assert.deepEqual(samples.filter(sample => sample.frame >= 1 && sample.frame <= 40 && (sample.anchorOffset === null || Math.abs(sample.anchorOffset - 8) > 2)), [], `The aligned target moved within its window: ${diagnostics}`)
    assert.deepEqual(late, [], `Layout after the window must not re-align: ${diagnostics}`)
    await page.evaluate(() => (window as any).fixture.align("row-180", 5000))
    await frames(page, 45)
    const clamped = await page.locator('[data-virtual-follow-key="row-180"]').evaluate(row => {
      const el = row.closest(".message-stream")!, bounds = el.getBoundingClientRect(), rect = row.getBoundingClientRect()
      return { top: rect.top - bounds.top, bottom: rect.bottom - bounds.top, clientHeight: el.clientHeight }
    })
    assert.ok(clamped.top >= 0 && clamped.bottom <= clamped.clientHeight + 1, `An offset beyond the viewport must land in view: ${JSON.stringify(clamped)}`)
  }, { name: "list" })
})

/** Appends a button to the first mounted row entirely below (or above) the viewport; returns its row key. */
function injectOffscreenButton(page: Page, id: string, side: "below" | "above") {
  return page.evaluate(({ id, side }) => {
    const el = document.querySelector<HTMLElement>(".message-stream")!, bounds = el.getBoundingClientRect()
    const rows = [...el.querySelectorAll<HTMLElement>("[data-virtual-follow-key]")]
    const row = side === "below" ? rows.find(r => r.getBoundingClientRect().top > bounds.bottom + 5) : rows.reverse().find(r => r.getBoundingClientRect().bottom < bounds.top - 5)
    if (!row) return null
    const button = document.createElement("button"); button.id = id; button.textContent = id; row.firstElementChild!.appendChild(button)
    return row.dataset.virtualFollowKey!
  }, { id, side })
}

// An in-place reveal holds its revealed part against layout for a bounded window;
// focus moving elsewhere (Tab, assistive technology) releases it at once.
test("alignElement then Tab to an off-screen control keeps it visible and focused", async () => {
  await open(async page => {
    const trace = collectScrollTrace(page)
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    await page.evaluate(() => {
      const row = document.querySelector('[data-virtual-follow-key="row-107"] > div')!, origin = document.createElement("button")
      origin.id = "origin"; origin.textContent = "origin"; row.appendChild(origin)
      ;(window as any).fixture.alignElement("#origin", 400)
      origin.focus({ preventScroll: true })
    })
    // Tab while the hold is still correcting (the old loop ran 30 frames). Let the
    // row's re-render after the alignment write land first, or it removes the control.
    await frames(page, 2)
    assert.ok(await injectOffscreenButton(page, "next", "below"))
    assert.ok(await page.evaluate(() => document.getElementById("next")?.isConnected), "The Tab target must still be mounted")
    await trace.enable()
    await page.keyboard.press("Tab")
    await frames(page, 30)
    // Later layout above the viewport must not pull the reader back either.
    const above = await injectOffscreenButton(page, "spare", "above")
    if (above) await page.evaluate(key => (window as any).fixture.resizeRow(key, 200), above)
    await frames(page, 30)
    const state = await page.evaluate(() => {
      const el = document.querySelector(".message-stream")!, bounds = el.getBoundingClientRect(), next = document.getElementById("next")?.getBoundingClientRect()
      return { focused: document.activeElement?.id, inView: Boolean(next && next.top >= bounds.top && next.bottom <= bounds.bottom) }
    })
    const realigned = trace.entries.filter(entry => entry.kind === "write" && entry.reason === "align-element")
    assert.deepEqual({ ...state, realigned: realigned.length }, { focused: "next", inView: true, realigned: 0 }, JSON.stringify(realigned))
  }, { name: "list" })
})

// Virtua compensating a row above keeps the hold, which within its window still
// corrects layout that Virtua does not compensate (a visible row above the element).
test("a hold survives Virtua's compensation above and corrects visible growth within its window", async () => {
  await open(async page => {
    const trace = collectScrollTrace(page)
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    await traceAnchor(page, "row-108")
    await trace.enable()
    const samples = await pump(page, 40, `if (frame === 0) window.fixture.align('row-108', 300)
      if (frame === 1) {
        const el = document.querySelector('.message-stream'), top = el.getBoundingClientRect().top
        window.aboveKey = [...el.querySelectorAll('[data-virtual-follow-key]')].reverse().find(row => row.getBoundingClientRect().bottom < top - 5)?.dataset.virtualFollowKey
      }
      if (frame >= 2 && frame <= 6) window.fixture.resizeRow(window.aboveKey, 48 + (frame - 1) * 40)
      if (frame === 12) window.fixture.resizeRow('row-106', 160)`)
    const diagnostics = JSON.stringify({ above: await page.evaluate(() => (window as any).aboveKey), samples: samples.map(({ frame, top, anchorOffset }) => ({ frame, top, anchorOffset })) })
    assert.ok(await page.evaluate(() => (window as any).aboveKey), diagnostics)
    assert.deepEqual(samples.filter(sample => sample.frame >= 1 && (sample.frame < 12 || sample.frame > 15) && (sample.anchorOffset === null || Math.abs(sample.anchorOffset - 300) > 2)), [], diagnostics)
    assert.ok(trace.entries.some(entry => entry.kind === "write" && entry.reason === "align-element"), `The hold must correct the visible growth: ${diagnostics}`)
  }, { name: "list" })
})

// The hold exists for a partly scrolled row that grows (message-block reveal):
// here the held row is cut by the viewport top and grows below the held element,
// so Virtua compensates a row that starts above the viewport.
for (const start of [1, 12]) test(`a row cut by the viewport top that grows below the held element keeps it in place (growth from frame ${start})`, async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    await page.evaluate(() => (window as any).fixture.resizeRow("row-105", 600))
    await frames(page)
    await page.evaluate(() => {
      const row = document.querySelector('[data-virtual-follow-key="row-105"] > div')!
      const spacer = document.createElement("div"); spacer.style.height = "300px"
      const held = document.createElement("span"); held.id = "held"; held.textContent = "held"
      row.append(spacer, held)
    })
    await traceAnchor(page, "row-105")
    const samples = await pump(page, 45, `if (frame === 0) window.fixture.alignElement('#held', 100)
      if (frame >= ${start} && frame < ${start + 15}) window.fixture.resizeRow('row-105', 600 + (frame - ${start} + 1) * 30)`)
    const held = await page.evaluate(() => {
      const el = document.querySelector(".message-stream")!, target = document.getElementById("held")!
      return Math.round(target.getBoundingClientRect().top - el.getBoundingClientRect().top)
    })
    const rowTop = samples.find(sample => sample.frame === 1)?.anchorOffset
    const diagnostics = JSON.stringify({ held, samples: samples.map(({ frame, anchorOffset }) => ({ frame, anchorOffset })) })
    assert.ok(rowTop !== null && rowTop !== undefined && rowTop < 0, `The held row must be cut by the viewport top: ${diagnostics}`)
    assert.deepEqual(samples.filter(sample => sample.frame >= 1 && (sample.anchorOffset === null || Math.abs(sample.anchorOffset - rowTop) > 2)), [], diagnostics)
    assert.ok(Math.abs(held - 100) <= 2, diagnostics)
  }, { name: "list" })
})

test("a viewport resize clamps an alignment only while it lasts", async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    await traceAnchor(page, "row-110")
    // 530 px stays partly visible in the shrunk viewport: a row entirely outside it
    // can be unmounted by Virtua, and a lost element ends the hold.
    const samples = await pump(page, 30, `if (frame === 0) window.fixture.align('row-110', 530)
      if (frame === 10) document.getElementById('root').style.height = '560px'
      if (frame === 15) window.clamped = document.querySelector('.message-stream').clientHeight - 48
      if (frame === 20) document.getElementById('root').style.height = '700px'`)
    const clamped = await page.evaluate(() => (window as any).clamped)
    const at = (frame: number) => samples.find(sample => sample.frame === frame)?.anchorOffset
    const diagnostics = JSON.stringify({ clamped, samples: samples.map(({ frame, anchorOffset }) => ({ frame, anchorOffset })) })
    assert.ok(clamped < 525 && Math.abs(at(8)! - 530) <= 2 && Math.abs(at(17)! - clamped) <= 2 && Math.abs(at(27)! - 530) <= 2, diagnostics)
  }, { name: "list" })
})

// A send keeps its intent through the turn; navigation that loads another window
// while that intent is pending must still land (MessageSection deduplicates the token).
test("a First jump during a pending send still lands on the first message", async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.delayPrompt())
    const prompt = page.locator("textarea:visible").first()
    await prompt.fill("Pending send keeps its intent")
    await prompt.press("Enter")
    await page.waitForFunction(() => (window as any).fixture.admitted())
    await frames(page, 120)
    await page.locator(".message-scroll-controls").hover()
    await page.getByRole("button", { name: "Scroll to first message", exact: true }).click()
    // The fixture serves this window from its newest records; what matters is that
    // the loaded window replaces the latest one and is then entered at its top.
    await page.waitForFunction(() => (window as any).fixture.snapshot().window.kind !== "latest")
    await frames(page, 60)
    const state = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".message-stream")!, bounds = el.getBoundingClientRect(), key = (window as any).fixture.snapshot().ids[0]
      const first = el.querySelector(`[data-virtual-follow-key="${key}"]`)
      return { key, scrollTop: el.scrollTop, mode: el.dataset.followMode, firstTop: first ? Math.round(first.getBoundingClientRect().top - bounds.top) : null }
    })
    assert.ok(state.scrollTop <= 2 && state.mode === "escaped" && state.firstTop !== null && Math.abs(state.firstTop) <= 2, JSON.stringify(state))
    await page.evaluate(() => (window as any).fixture.acceptPrompt())
  }, { history: 620 })
})

const AT_BOTTOM = { scrollTop: 0, atBottom: true, followModeType: "following" }

test("an at-bottom restoration that loses follow without a gesture reports cancellation and stops restoring", async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    await page.evaluate(target => { const w = window as any; w.restoreTarget = target; w.cb = [] }, AT_BOTTOM)
    await pump(page, 40, `if (frame === 0) window.fixture.restore(window.restoreTarget, { onApplied: () => window.cb.push("applied"), onCancelled: () => window.cb.push("cancelled") })
      if (frame % 2 === 1) window.fixture.append()
      if (frame === 4) window.fixture.setAutoScroll(false)`)
    await frames(page, 20)
    assert.deepEqual(await page.evaluate(() => (window as any).cb), ["cancelled"])
    // No sticky restoring state: following growth pins again.
    await page.evaluate(() => { (window as any).fixture.setAutoScroll(true); (window as any).fixture.append() })
    await frames(page, 20)
    const gap = await page.locator(".message-stream").evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
    assert.ok(gap <= 1, `gap=${gap}`)
  }, { name: "list" })
})

test("leaving follow cancels an explicit pin and its intent exactly once", async () => {
  await open(async page => {
    const trace = collectScrollTrace(page)
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    await trace.enable()
    await pump(page, 40, "if (frame === 0) window.fixture.pin('p', 1000); if (frame % 3 === 1) window.fixture.append(); if (frame === 6) window.fixture.setAutoScroll(false)")
    await frames(page, 10)
    const escape = trace.entries.findIndex(entry => entry.kind === "mode" && entry.to === "escaped" && entry.source === "set-follow")
    const pins = trace.entries.slice(escape).filter(entry => entry.kind === "write" && entry.reason === "explicit-pin")
    const mode = await page.locator(".message-stream").getAttribute("data-follow-mode")
    assert.deepEqual({ escaped: escape >= 0, pins: pins.length, mode, cancelled: await page.evaluate(() => (window as any).fixture.pinCancelled()) }, { escaped: true, pins: 0, mode: "escaped", cancelled: 1 })
  }, { name: "list" })
})

test("a cleared intent ends only its own pin, never a list-owned settlement", async () => {
  await open(async page => {
    const trace = collectScrollTrace(page)
    await page.evaluate(() => (window as any).fixture.pin("old", 0))
    await frames(page)
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    await pump(page, 60, `${SETTLE_STEP} if (frame === 2) window.fixture.unpin(); if (frame % 3 === 1 && frame < 30) window.fixture.resizeRow('row-199', 48 + frame * 30)`)
    await frames(page, 10)
    assert.equal((await page.evaluate(() => (window as any).settlement))?.s, "settled")
    // A cleared intent does end its own pin.
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    await page.evaluate(() => (window as any).fixture.pin("own", 1000))
    await frames(page, 4)
    await trace.enable()
    await page.evaluate(() => (window as any).fixture.unpin())
    await pump(page, 20, "if (frame % 3 === 1) window.fixture.append()")
    assert.deepEqual(trace.entries.filter(entry => entry.kind === "write" && entry.reason === "explicit-pin"), [])
  }, { name: "list" })
})

test("a replaced restoration is cancelled and the replacement lands", async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.nearTail())
    await frames(page)
    const result = await page.evaluate(() => new Promise<{ cb: string[]; anchorOffset: number | null }>(resolve => {
      const w = window as any, cb: string[] = []
      const target = (key: string, offset: number) => ({ scrollTop: 0, atBottom: false, followModeType: "escaped", anchorKey: key, anchorOffset: offset })
      w.fixture.restore(target("row-100", -10), { onApplied: () => cb.push("A-applied"), onCancelled: () => cb.push("A-cancelled") })
      requestAnimationFrame(() => w.fixture.restore(target("row-30", -20), { onApplied: () => cb.push("B-applied"), onCancelled: () => cb.push("B-cancelled") }))
      let count = 90
      const next = () => {
        if (--count) return requestAnimationFrame(next)
        const el = document.querySelector(".message-stream")!, row = el.querySelector('[data-virtual-follow-key="row-30"]')
        resolve({ cb, anchorOffset: row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null })
      }
      requestAnimationFrame(next)
    }))
    assert.deepEqual(result.cb, ["A-cancelled", "B-applied"], JSON.stringify(result))
    assert.ok(result.anchorOffset !== null && Math.abs(result.anchorOffset + 20) <= 2, JSON.stringify(result))
  }, { name: "list" })
})

// A first send in a session without a snapshot starts its initial restoration
// inside the send pin; restoring to the bottom joins that pin.
test("an at-bottom restoration during a send pin keeps the pin's row count", async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    await page.evaluate(target => { const w = window as any; w.restoreTarget = target; w.applied = null; w.sendCount = w.fixture.itemCount() + 3 }, AT_BOTTOM)
    await pump(page, 60, `if (frame === 0) window.fixture.pin('send', window.sendCount)
      if (frame === 2) window.fixture.restore(window.restoreTarget, { onApplied: () => { window.applied = { frame, items: window.fixture.itemCount() } } })
      if (frame === 20 || frame === 25 || frame === 30) window.fixture.append()`)
    await frames(page, 20)
    const result = await page.evaluate(() => { const w = window as any, el = document.querySelector<HTMLElement>(".message-stream")!; return { applied: w.applied, sendCount: w.sendCount, gap: el.scrollHeight - el.clientHeight - el.scrollTop, mode: el.dataset.followMode, cancelled: w.fixture.pinCancelled() } })
    assert.ok(result.applied && result.applied.items === result.sendCount && result.gap <= 1 && result.mode === "following" && result.cancelled === 0, JSON.stringify(result))
  }, { name: "list" })
})

test("a settled explicit pin keeps following through growth right after it settles", async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).fixture.middle())
    await frames(page)
    await page.evaluate(() => { const w = window as any; w.sendCount = w.fixture.itemCount() + 6 })
    const samples = await pump(page, 70, `if (frame === 0) window.fixture.pin('a', window.sendCount)
      if (frame % 5 === 2 && window.fixture.itemCount() < window.sendCount) window.fixture.append()
      if (frame >= 30 && frame < 36) window.fixture.resizeRow('row-' + (window.sendCount - 1), 48 + (frame - 29) * 60)`)
    const reached = samples.findIndex(sample => sample.gap <= 2)
    const off = samples.slice(reached).filter(sample => sample.gap > 2)
    assert.ok(reached >= 0 && off.length === 0, JSON.stringify(samples.map(({ frame, gap, mode }) => ({ frame, gap, mode }))))
  }, { name: "list" })
})
