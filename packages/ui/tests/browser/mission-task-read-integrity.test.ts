import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { missionPanelPage } from "../../../server/src/missions/mission-panel-page"
import { contentDigest } from "../../../server/src/missions/content-digest"

let browser: Browser, url: string
const row = { taskPage: { order: contentDigest("[]"), offset: 0, end: 0, total: 0, counts: {}, reports: 0 }, tasks: [], reports: [] }
const answer = missionPanelPage({ source: "tasks", projectID: "project", missionID: "review", revision: 1,
  discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }, [row])
before(async () => {
  url = (await borrowFixture({ name: "mission-task-read-integrity", routes: [{ path: "/integrity", html: "<html><body>Task transport qualification</body></html>" }] })).url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("five real API calls retain only two secondary slots until streams cancel", async () => {
  const page = await browser.newPage()
  try {
    await page.addInitScript("window.__name=f=>f"); await page.goto(url)
    const result = await page.evaluate(async () => {
      const { serverApi } = await import("/src/lib/api-client.ts"), { backgroundReads } = await import("/src/lib/background-read-queue.ts")
      const original = globalThis.fetch, abort = new AbortController()
      let starts = 0, cancels = 0, entered!: () => void
      const ready = new Promise<void>(resolve => { entered = resolve })
      globalThis.fetch = async () => { if (++starts === 2) entered(); return new Response(new ReadableStream({ cancel() { cancels++ } })) }
      const calls = Array.from({ length: 5 }, (_, index) => serverApi.fetchMissionTasks(`instance${index}`, "review", { offset: 0 }, { projectID: "project", current: () => true, signal: abort.signal }))
      try {
        await ready
        // One event-loop boundary drains the immediately resolved header promises.
        await new Promise(resolve => setTimeout(resolve, 0))
        const beforeCancel = starts
        abort.abort(); const settled = await Promise.allSettled(calls)
        await backgroundReads.run(new AbortController().signal, async () => {}) // cancellation has actually released the slots
        return { beforeCancel, starts, cancels, rejected: settled.filter(value => value.status === "rejected").length }
      } finally { abort.abort(); await Promise.allSettled(calls); globalThis.fetch = original }
    })
    assert.deepEqual(result, { beforeCancel: 2, starts: 2, cancels: 2, rejected: 5 })
  } finally { await page.context().close() }
})

for (const mode of ["oversize", "http-error"] as const) test(`expired ${mode} cleanup releases real API slots before deferred cancellation settles`, async () => {
  const page = await browser.newPage(), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.addInitScript("window.__name=f=>f"); await page.goto(url)
    const result = await page.evaluate(async mode => {
      const { serverApi } = await import("/src/lib/api-client.ts"), { backgroundReads } = await import("/src/lib/background-read-queue.ts")
      const original = globalThis.fetch
      let rejectCancel!: (error: Error) => void, starts = 0, cancels = 0, released = false
      const cancellation = new Promise<void>((_, reject) => { rejectCancel = reject }), deadline = performance.now() + 200
      globalThis.fetch = async () => {
        starts++
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65_537)) },
          cancel() { cancels++; return cancellation } }), { status: mode === "http-error" ? 503 : 200 })
      }
      const calls = Array.from({ length: 3 }, () => serverApi.fetchMissionTasks("fixture", "review", { offset: 0 }, { projectID: "project", current: () => true, deadline }))
      let markerStarted = false, startedAfterDeadline = false, startedWhileDeferred = false
      const marker = backgroundReads.run(AbortSignal.timeout(1000), async () => {
        markerStarted = true; startedAfterDeadline = performance.now() >= deadline; startedWhileDeferred = !released
      }).then(() => true, () => false)
      try {
        const outcomes = await Promise.allSettled(calls), markerCompleted = await marker
        return { starts, cancels, markerStarted, markerCompleted, startedAfterDeadline, startedWhileDeferred,
          outcomes: outcomes.map(value => value.status === "rejected" ? value.reason.reason ?? value.reason.name : "published") }
      } finally {
        released = true; rejectCancel(new Error("late cancellation rejection"))
        await Promise.allSettled(calls); await marker
        await backgroundReads.run(new AbortController().signal, async () => {})
        globalThis.fetch = original
      }
    }, mode)
    assert.deepEqual(result, { starts: 2, cancels: 2, markerStarted: true, markerCompleted: true, startedAfterDeadline: true, startedWhileDeferred: true,
      outcomes: [mode === "oversize" ? "invalid" : "unavailable", mode === "oversize" ? "invalid" : "unavailable", "TimeoutError"] })
    // Observe the browser's late-rejection turn after teardown rejects the owned gates.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))
    assert.deepEqual(errors, [])
  } finally { await page.context().close() }
})

test("the real API rejects an unfinished final WebCrypto hash at its 30-second deadline", { timeout: 45_000 }, async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(36_000)
  try {
    await page.addInitScript("window.__name=f=>f"); await page.goto(url)
    await page.evaluate(answer => {
      void (async () => {
        const { serverApi } = await import("/src/lib/api-client.ts")
        const originalFetch = globalThis.fetch, originalHash = crypto.subtle.digest.bind(crypto.subtle)
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve }), state = (window as any).taskDeadline = { started: false, result: undefined, release: () => release(), work: undefined }
        globalThis.fetch = async () => new Response(JSON.stringify(answer))
        crypto.subtle.digest = (...args) => { state.started = true; return state.work = gate.then(() => originalHash(...args)) }
        const start = performance.now()
        try {
          await serverApi.fetchMissionTasks("fixture", "review", { offset: 0 }, { projectID: "project", current: () => true })
          state.result = { accepted: true, elapsed: performance.now() - start }
        } catch (error) { state.result = { error: (error as Error).name, elapsed: performance.now() - start } }
        finally { globalThis.fetch = originalFetch; crypto.subtle.digest = originalHash }
      })()
    }, answer)
    await page.waitForFunction(() => (window as any).taskDeadline?.started)
    await page.waitForFunction(() => (window as any).taskDeadline?.result)
    const result = await page.evaluate(() => (window as any).taskDeadline.result)
    assert.equal(result.error, "TimeoutError"); assert.equal(result.accepted, undefined)
    assert.ok(result.elapsed >= 29_000 && result.elapsed < 35_000)
    await page.evaluate(async () => { const state = (window as any).taskDeadline; state.release(); await state.work })
  } finally {
    await page.evaluate(async () => { const state = (window as any).taskDeadline; state?.release(); await state?.work }).catch(() => {})
    await page.context().close()
  }
})

test("actual non-loopback HTTP origin validates UTF-16LE digests, emoji and lone surrogates without WebCrypto", async () => {
  const page = await browser.newPage(), origin = new URL(url).origin
  try {
    await page.addInitScript("window.__name=f=>f")
    await page.route("http://mission-http.invalid/**", async route => {
      const parsed = new URL(route.request().url())
      if (parsed.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<html><body>Supported HTTP host</body></html>" })
      const response = await fetch(origin + parsed.pathname + parsed.search)
      return route.fulfill({ status: response.status, contentType: response.headers.get("content-type") ?? "application/javascript", body: Buffer.from(await response.arrayBuffer()) })
    })
    await page.goto("http://mission-http.invalid/")
    const vectors = ["", "abc", "😀\u0000漢字", "\ud800", "\ud801", "\udc00"]
    const result = await page.evaluate(async ({ vectors, answer }) => {
      const { taskPageDigest, readMissionTaskPage } = await import("/src/lib/mission-task-page-read.ts")
      const hashes = await Promise.all(vectors.map(text => taskPageDigest(text)))
      const result = await readMissionTaskPage("review", { offset: 0 }, { projectID: "project", current: () => true, exchange: async () => new Response(JSON.stringify(answer)) })
      return { secure: isSecureContext, subtle: typeof crypto.subtle, hashes, available: result.available }
    }, { vectors, answer })
    assert.equal(result.secure, false); assert.equal(result.subtle, "undefined")
    assert.deepEqual(result.hashes, vectors.map(contentDigest)); assert.equal(result.available, true)
  } finally { await page.context().close() }
})
