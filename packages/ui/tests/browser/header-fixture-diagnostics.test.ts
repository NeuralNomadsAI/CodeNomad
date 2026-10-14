import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createServer, type Server } from "node:http"
import type { EventEmitter } from "node:events"
import { chromium, type Browser, type Page } from "playwright"
import { observeHeaderFixture } from "./header-fixture-diagnostics"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"

let browser: Browser, server: Server, url: string
before(async () => {
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url?.startsWith("/entry.js") ? "text/javascript" : "text/html")
    response.end(request.url?.startsWith("/entry.js") ? "window.fixture = {}" : '<div id="root"></div><script type="module" src="/entry.js?secret=do-not-log"></script>')
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())) })

const observedEvents = ["console", "pageerror", "requestfailed", "response", "framenavigated"] as const
// Playwright's real Page is an EventEmitter; its public Page interface omits this inspection method.
const listenerCounts = (page: Page) => observedEvents.map(event => (page as unknown as EventEmitter).listenerCount(event))
async function capture(run: () => Promise<unknown>) {
  try { return { result: await run() } } catch (error) { return { error } }
}

test("aborted real entry module is observed before navigation; diagnostic/cleanup failures preserve primary identity", async () => {
  const page = await browser.newPage(), baseline = listenerCounts(page)
  const observer = observeHeaderFixture(page), primary = new Error("readiness sentinel"), stack = primary.stack
  const emissionFailure = new Error("emission"), cleanupFailure = new Error("cleanup")
  const logs: string[] = [], secondary: unknown[] = []
  const result = await capture(() => runWithDiagnosticCleanup({
    run: async () => {
      await observer.install()
      await page.route("**/entry.js?*", route => route.abort("failed"))
      const failed = page.waitForEvent("requestfailed", request => request.url().includes("/entry.js"))
      await page.goto(url)
      await failed
      throw primary
    },
    diagnose: () => observer.diagnose(message => { logs.push(message); throw emissionFailure }),
    cleanup: async () => { observer.detach(); assert.deepEqual(listenerCounts(page), baseline); await page.close(); throw cleanupFailure },
    onObservationError: error => secondary.push(error),
    onCleanupError: error => secondary.push(error),
  }))
  assert.equal(result.error, primary)
  assert.equal(primary.stack, stack)
  assert.deepEqual(secondary, [emissionFailure, cleanupFailure])
  const report = JSON.parse(logs[0])
  assert.ok(report.events.some((event: any) => event.kind === "requestfailed" && event.url.endsWith("/entry.js")))
  assert.ok(report.events.some((event: any) => event.kind === "navigation"))
  assert.equal(report.snapshot.fixture, "undefined")
  assert.equal(report.snapshot.boot[0].phase, "document-init")
  assert.equal(report.snapshot.dom.textarea, false)
  assert.ok(!logs[0].includes("do-not-log"))
})

test("bounded rings, stage marks and detach use the real browser without asynchronous stage work", async () => {
  const page = await browser.newPage(), baseline = listenerCounts(page), observer = observeHeaderFixture(page)
  const logs: string[] = []
  try {
    await observer.install()
    await page.goto(url)
    const lastConsole = page.waitForEvent("console", message => message.text() === "last")
    await page.evaluate(() => {
      for (let i = 0; i < 100; i++) {
        (window as any).__headerFixtureBoot.mark("phase" + i, "x".repeat(1000))
        console.log("y".repeat(1000))
      }
      console.log("last")
    })
    await lastConsole
    await observer.diagnose(message => logs.push(message))
    const report = JSON.parse(logs[0])
    assert.equal(report.events.length, 48)
    assert.ok(report.dropped >= 53)
    assert.ok(report.events.every((event: any) => !event.text || event.text.length <= 256))
    assert.equal(report.snapshot.boot.length, 16)
    assert.equal(report.snapshot.boot.at(-1).phase, "phase99")
    assert.ok(report.snapshot.boot.every((entry: any) => entry.detail.length <= 256))
    assert.ok(logs[0].length < 40000)
    observer.detach()
    observer.detach()
    assert.deepEqual(listenerCounts(page), baseline)
    await page.evaluate(() => console.log("after detach"))
    await observer.diagnose(message => logs.push(message))
    assert.deepEqual(JSON.parse(logs[1]).events, report.events)
  } finally { observer.detach(); await page.close() }
})

test("destroyed execution context snapshot is best effort and cannot replace a primary error", async () => {
  const page = await browser.newPage(), observer = observeHeaderFixture(page), primary = new Error("primary")
  const logs: string[] = []
  const result = await capture(() => runWithDiagnosticCleanup({
    run: async () => { await page.close(); throw primary },
    diagnose: () => observer.diagnose(message => logs.push(message)),
    cleanup: async () => { observer.detach() },
    onObservationError: () => assert.fail("snapshot rejection must be recorded"),
    onCleanupError: () => assert.fail("unexpected cleanup error"),
  }))
  assert.equal(result.error, primary)
  assert.match(JSON.parse(logs[0]).observationError, /closed|destroyed/i)
})

test("real pending browser evaluation has a global 2s diagnostic deadline and cleanup still preserves primary", async (t) => {
  const page = await browser.newPage(), observer = observeHeaderFixture(page), primary = new Error("primary")
  const evaluate = page.evaluate.bind(page), logs: string[] = []
  // Replace only the snapshot call with an actual never-resolving renderer evaluation.
  t.mock.method(page, "evaluate", () => evaluate(() => new Promise(() => {})))
  const result = await capture(() => runWithDiagnosticCleanup({
    run: async () => { throw primary },
    diagnose: () => observer.diagnose(message => logs.push(message)),
    cleanup: async () => { observer.detach(); await page.close() },
    onObservationError: () => assert.fail("deadline must be recorded"),
    onCleanupError: () => assert.fail("unexpected cleanup error"),
  }))
  assert.equal(result.error, primary)
  assert.equal(JSON.parse(logs[0]).observationError, "header snapshot deadline (2000ms)")
})

test("successful run does not diagnose, detaches, and cleanup failure remains red", async () => {
  const page = await browser.newPage(), baseline = listenerCounts(page), observer = observeHeaderFixture(page)
  const cleanupFailure = new Error("cleanup after success")
  const result = await capture(() => runWithDiagnosticCleanup({
    run: async () => { await observer.install(); await page.goto(url); return "success" },
    diagnose: () => { assert.fail("no diagnostics after success") },
    cleanup: async () => { observer.detach(); assert.deepEqual(listenerCounts(page), baseline); await page.close(); throw cleanupFailure },
    onObservationError: () => assert.fail("no observation error"),
    onCleanupError: () => assert.fail("cleanup must propagate"),
  }))
  assert.equal(result.error, cleanupFailure)
})
