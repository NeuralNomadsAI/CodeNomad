import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error", cacheDir: cache.cacheDir, plugins: [shutdown.plugin, solid(), {
      name: "streaming-outline-fixture", configureServer(server) {
        server.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await server.transformIndexHtml("/fixture", '<html><body><div id="root" style="display:flex;height:850px;width:1200px"></div><script type="module" src="/tests/browser/fixtures/streaming-outline.tsx"></script></body></html>'))
        })
      }, async load(id) {
        if (id.replaceAll("\\", "/").endsWith("/src/components/message-timeline-projection.ts")) {
          // Count the rail's full-history visibility folds the same way.
          const source = await readFile(id, "utf8")
          const folded = source.replace("const representative = new Map<string, string>()",
            ";(globalThis as any).__timelineFolds = ((globalThis as any).__timelineFolds ?? 0) + 1; const representative = new Map<string, string>()")
          if (folded === source) throw new Error("timeline fold anchor missing")
          const counted = folded.replace("const runs = nativeTimelineRuns(record)",
            ";if (record.id !== 'msg_assistant') (globalThis as any).__historicalMarkerBuilds = ((globalThis as any).__historicalMarkerBuilds ?? 0) + 1; const runs = nativeTimelineRuns(record)")
          if (counted === folded) throw new Error("resident marker build anchor missing")
          return counted
        }
        if (!id.replaceAll("\\", "/").endsWith("/src/components/session-outline-projection.ts")) return
        const source = await readFile(id, "utf8")
        // Count the real full-history implementation, without changing inputs,
        // outputs, scheduling or the production interface.
        const counted = source.replace("const position =", ";(globalThis as any).__outlineWork ??= { calls: 0 }; (globalThis as any).__outlineWork.calls++; const position =")
        if (counted === source) throw new Error("full-history projection anchor missing")
        return counted
      },
    }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } }).catch(async error => { await cache.dispose(); throw error })
  shutdown.own(server)
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close() })

test("native deltas update a mounted marker's label without reprojecting a 16k outline", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: route.request().url().includes("events") ? "text/event-stream" : "application/json", body: "{}" }))
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 })
    await page.waitForFunction(() => Boolean((window as any).outlineFixture), {}, { timeout: 60000 })
    await page.waitForFunction(() => (window as any).outlineFixture.snapshot().reads >= 32 && (window as any).outlineFixture.snapshot().calls > 0)
    const initialCalls = await page.evaluate(() => (window as any).outlineFixture.snapshot().calls)
    await page.evaluate(() => { (window as any).outlineFixture.start(); (window as any).outlineFixture.delta("a") })
    await page.waitForFunction(before => (window as any).outlineFixture.snapshot().calls > before, initialCalls)
    await page.locator(".message-timeline").evaluate(element => { element.scrollTop = element.scrollHeight })
    const marker = await page.locator('.message-timeline-assistant[data-message-id="msg_assistant"]').elementHandle()
    await marker.focus()
    assert.equal(await marker.getAttribute("aria-label"), "a")
    const measurement = await page.evaluate(async () => {
      const fixture = (window as any).outlineFixture
      fixture.reset()
      for (let index = 0; index < 64; index++) { fixture.delta("a"); await new Promise(resolve => setTimeout(resolve, 5)) }
      fixture.delta("b".repeat(64))
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return fixture.snapshot()
    })
    const reply = "a".repeat(65) + "b".repeat(64)
    assert.equal(measurement.replyText, reply)
    assert.equal(measurement.calls, 0, "content-only deltas must not walk the entire outline")
    assert.equal(measurement.folds, 0, "content-only deltas must not refold the rail")
    assert.equal(measurement.historicalBuilds, 0, "only the edited resident message may rebuild its markers")
    assert.equal(await marker.getAttribute("aria-label"), reply, "the accessible excerpt still follows the live record")
    assert.equal(await marker.evaluate(element => element === document.activeElement), true, "focus stays on the original marker")
    await page.evaluate(() => (window as any).outlineFixture.locale("fr"))
    await page.waitForFunction(element => element.querySelector(".message-timeline-label-full")?.textContent === "Assistant", marker)
    assert.equal(await page.evaluate(() => (window as any).outlineFixture.snapshot().calls), 0, "locale changes update labels, not geometry")
    const finalText = "A" + reply.slice(1)
    await page.evaluate(text => (window as any).outlineFixture.finish(text), finalText)
    await page.waitForFunction(({ element, text }) => element.getAttribute("aria-label") === text, { element: marker, text: finalText })
    assert.equal(await page.evaluate(() => (window as any).outlineFixture.snapshot().calls), 0, "a same-shape final reply updates the original marker")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a reply streaming after a hidden tool does not refold the 16k rail per token", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: route.request().url().includes("events") ? "text/event-stream" : "application/json", body: "{}" }))
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 })
    await page.waitForFunction(() => Boolean((window as any).outlineFixture), {}, { timeout: 60000 })
    await page.waitForFunction(() => (window as any).outlineFixture.snapshot().reads >= 32 && (window as any).outlineFixture.snapshot().calls > 0)
    // Nothing hides the step's completed read tool, so the rail folds around it.
    await page.evaluate(() => (window as any).outlineFixture.preset("nothing"))
    await page.evaluate(() => (window as any).outlineFixture.startAfterTool("read"))
    await page.evaluate(() => (window as any).outlineFixture.delta("a"))
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.ok(await page.evaluate(() => (window as any).outlineFixture.snapshot().folds) > 0, "the fold counter observes the rail")
    const measurement = await page.evaluate(async () => {
      const fixture = (window as any).outlineFixture
      fixture.reset()
      for (let index = 0; index < 32; index++) { fixture.delta("a".repeat(32)); await new Promise(resolve => setTimeout(resolve, 5)) }
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return fixture.snapshot()
    })
    assert.equal(measurement.replyText, "a".repeat(1025))
    assert.equal(measurement.folds, 0, "text growth around a hidden tool must not refold the whole rail")
    assert.equal(measurement.calls, 0, "nor reproject the whole outline")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
