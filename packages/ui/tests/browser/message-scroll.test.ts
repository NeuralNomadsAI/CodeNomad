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
  let held = false
  for (let i = 0; i < 200 && !held; i++) {
    await page.evaluate(() => (window as any).fixture.delta("A", "Long streamed paragraph for the hold.\n\n".repeat(2)))
    await frames(page, 2)
    held = (await page.evaluate(() => (window as any).fixture.snapshot().scroll.followModeType)) === "escaped"
  }
  assert.ok(held, "A long streamed reply must engage the hold")
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

// Documents a pre-existing displacement (also on the pre-#967 base). The scroll
// trace shows no transcript write in that frame: an `unowned` move where Virtua's
// one-time default-size estimate (armed per Virtualizer instance, fired once newly
// measured rows exceed the viewport, i.e. as the reply outgrows it like the hold)
// shrinks never-measured history rows. The browser clamps to the new maximum and
// Virtua's jump compensation is applied on top, landing around msg_0030_A.
test("the long-reply hold keeps the streaming reply in view when it escapes", { todo: "hold escape displaces the reader to older history (follow-up)" }, async () => {
  const scope = '[data-session-id="A"]'
  await open(async page => {
    const topRows = await streamUntilHold(page, scope)
    const displaced = topRows.filter(key => key && key !== "stream-A" && !/^msg_005[5-9]_A$/.test(key))
    assert.deepEqual(displaced, [], `The hold escape moved the reader away from the streaming tail: ${JSON.stringify(topRows)}`)
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
