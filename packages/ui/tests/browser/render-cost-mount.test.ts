import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

// Switching to a long session must keep the main thread responsive. The
// structural guards assert the load-bearing mechanisms directly — code
// highlighting deferred to idle callbacks, expanded tool bodies mounted
// across animation frames — both of which are zero on the unoptimized
// baseline that ran everything inside the mounting task. Wall-clock longtask
// times are logged as observations with loose backstops, following the
// render-cost convention: a busy host slows a throttled measurement far more
// than CI does. Measured in the page on the real MessageSection/transcript
// pipeline at 4x CPU throttling, with the fixture's warm-up session having
// loaded every renderer module and Shiki language first, so a switch pays
// exactly the mount cost under test.

/** CPU throttling rate applied through CDP for every measured switch. */
const THROTTLE_RATE = 4
/**
 * Timing backstop for opening a long session from a short one (ms): measured
 * about 1.0s on an idle machine at this throttle rate (unoptimized baseline:
 * about 5s) and up to about 3.9s while the host itself is busy. The primary
 * guards are the structural scheduler assertions below; this bound only
 * backstops gross regressions and stays quiet on a loaded dev machine.
 */
const FIRST_OPEN_LONGTASK_MS = 4_000
/**
 * Timing backstop for switching between two long sessions (ms). Today's worst
 * single longtask there measures 3.6-4.1s idle (store hydration, shell mount
 * and scroll settling each still run as one task; follow-up work), up to
 * about 7s on a busy host.
 */
const SUBSEQUENT_SWITCH_LONGTASK_MS = 9_000
/** A switch counts as settled once no longtask occurred for this long (ms). */
const QUIET_MS = 1_200

let browser: Browser, closeFixture: () => Promise<void>, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "render-cost-mount", routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/render-cost-mount.tsx"></script></body></html>' }] })
  url = fixture.url
  closeFixture = fixture.close
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => {
  await browser?.close()
  await closeFixture?.()
})

test("a throttled switch to a 120-message session keeps every longtask bounded", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => { errors.push(error.message); console.error("fixture-error", error.message) })
  await page.route("**/*", route => {
    const request = new URL(route.request().url())
    if (request.origin !== new URL(url).origin) return route.abort("blockedbyclient")
    if (request.pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" })
    return route.continue()
  })
  try {
    await page.goto(url, { timeout: 120_000 })
    await page.waitForFunction("Boolean(window.fixture)", null, { timeout: 120_000 })
    // The highlighter and every Shiki language the sessions use must be warm
    // before any measurement window opens, so a switch pays exactly the mount
    // cost under test (never first-use language loading).
    await page.waitForFunction("window.fixture.languagesReady()", null, { timeout: 120_000 })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE_RATE })

    const sessions = await page.evaluate<string[]>("window.fixture.mountSessions")
    const small = await page.evaluate<string[]>("window.fixture.smallSessions")
    // Long, small, long: two samples of opening a long session from a short
    // one (mount-0, mount-2) around one big-to-big switch (mount-1). A busy
    // machine varies run to run, so the first-open bound takes the better of
    // its two samples and every switch shares the ratchet.
    const plan: Array<{ id: string; kind: "first-open" | "big-to-big" | "reset" }> = [
      { id: sessions[0]!, kind: "first-open" },
      { id: sessions[1] ?? sessions[0]!, kind: "big-to-big" },
      { id: small[1] ?? small[0]!, kind: "reset" },
      { id: sessions[2] ?? sessions[0]!, kind: "first-open" },
    ]
    const observations: Array<{ session: string; kind: string; max: number; count: number; total: number; rows: number; markers: number; toolCalls: number; idleCallbacks: number; bodyMountFrames: number }> = []
    for (const step of plan) {
      await page.evaluate("window.fixture.resetLongtasks()")
      await page.evaluate(`window.fixture.switchTo(${JSON.stringify(step.id)})`)
      const marker = JSON.stringify(`[${step.id}]`)
      await page.waitForFunction(`window.fixture.transcriptShows(${marker}) && window.fixture.quietSince() > ${QUIET_MS}`, null, { timeout: 120_000 })
      await page.waitForFunction("window.fixture.highlightPresent()", null, { timeout: 60_000 })
      const state = await page.evaluate(`(function () {
        const tasks = window.fixture.longtasks(), counts = window.fixture.counts(), schedulers = window.fixture.schedulerStats()
        return { max: tasks.max, count: tasks.count, total: tasks.total, rows: counts.rows, markers: counts.markers, toolCalls: counts.toolCalls,
          idleCallbacks: schedulers.idleCallbacks, bodyMountFrames: schedulers.bodyMountFrames }
      })()`)
      observations.push({ session: step.id, kind: step.kind, ...state })
      if (step.kind !== "reset") {
        assert.ok(state.rows >= 4 && state.rows <= 80, `the switch must mount a bounded virtual window, not ${state.rows} rows`)
        assert.ok(state.toolCalls >= 1, "the switch must mount tool output bodies")
        assert.equal(await page.evaluate(`window.fixture.transcriptShows(${marker})`), true, "the target session's transcript is shown")
      }
      // Give the next switch a clean start even if trailing small tasks exist.
      await page.evaluate("new Promise(resolve => setTimeout(resolve, 150))")
    }
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    const firstOpen = Math.min(...observations.filter(observation => observation.kind === "first-open").map(observation => observation.max))
    const worst = Math.max(...observations.map(observation => observation.max))
    console.log("mount-longtask", JSON.stringify({ throttle: THROTTLE_RATE, firstOpenBackstop: FIRST_OPEN_LONGTASK_MS, subsequentBackstop: SUBSEQUENT_SWITCH_LONGTASK_MS, firstOpen, worst, observations }))
    assert.ok(
      observations.every(observation => observation.count >= 1),
      "each measured switch must have observed longtasks (observer wiring)",
    )
    // The structural guards, load-independent: Shiki highlighting left the
    // mounting task (deferred passes render through idle callbacks, several
    // per callback when the deadline allows) and expanded tool bodies mount
    // through frame batches instead of all at once. Measured 4-5 idle
    // callbacks on a fast CI runner and 7-19 on a loaded host (a faster
    // machine drains more blocks per callback), with 8 body-mount frames
    // everywhere, against 0 and at most 1 on the unoptimized baseline, which
    // highlighted and mounted every body synchronously inside the mounting
    // task.
    for (const observation of observations.filter(entry => entry.kind === "first-open")) {
      assert.ok(observation.idleCallbacks >= 2,
        `a long-session open must defer its code highlighting to idle time (${observation.idleCallbacks} deferred callbacks for ${observation.session})`)
      assert.ok(observation.bodyMountFrames >= 3,
        `a long-session open must spread its tool bodies over animation frames (${observation.bodyMountFrames} mount frames for ${observation.session})`)
    }
    assert.ok(firstOpen < FIRST_OPEN_LONGTASK_MS,
      `opening a long session from a short one (${firstOpen}ms, better of two samples) must stay under the ${FIRST_OPEN_LONGTASK_MS}ms backstop at ${THROTTLE_RATE}x CPU throttle`)
    assert.ok(worst < SUBSEQUENT_SWITCH_LONGTASK_MS,
      `switching between long sessions (${worst}ms worst) must stay under the ${SUBSEQUENT_SWITCH_LONGTASK_MS}ms backstop at ${THROTTLE_RATE}x CPU throttle`)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
