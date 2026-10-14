import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
let cacheDirectory: string | undefined
before(async () => {
  // Concurrent browser fixtures must not replace this run's optimized modules.
  cacheDirectory = await mkdtemp(join(tmpdir(), "codenomad-render-vite-"))
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cacheDirectory,
    plugins: [solid(), { name: "render-cost-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (req, res) => {
        res.setHeader("Content-Type", "text/html")
        const name = req.url?.includes("mode=timeline") ? "render-cost-timeline" : "render-cost"
        res.end(await s.transformIndexHtml("/fixture", `<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/${name}.tsx"></script></body></html>`))
      })
    }, async load(id) {
      // Optional audit-only A/B source override; never changes the checkout.
      if (process.env.CODENOMAD_RENDER_TASK_BASELINE && id.replaceAll("\\", "/").endsWith("/src/components/tool-call/renderers/task.tsx")) {
        return readFile(process.env.CODENOMAD_RENDER_TASK_BASELINE, "utf8")
      }
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => {
  await browser?.close()
  await server?.close()
  if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true })
})

async function open(query: string, run: (page: Page) => Promise<void>) {
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
    await page.goto(`${url}?${query}`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => {
      const events: unknown[] = []
      ;(window as any).renderCostFailureEvents = events
      for (const kind of ["pointerdown", "pointerup", "pointermove", "gotpointercapture", "lostpointercapture", "mouseover", "mouseout", "focusin", "focusout", "keydown", "keyup"]) {
        document.addEventListener(kind, event => {
          if (event instanceof KeyboardEvent && event.key !== "Escape") return
          const pointer = event instanceof PointerEvent ? event : undefined
          const mouse = event instanceof MouseEvent ? event : undefined
          events.push({ kind, at: performance.now(), prevented: event.defaultPrevented, trusted: event.isTrusted,
            x: mouse?.clientX, y: mouse?.clientY, buttons: mouse?.buttons, button: mouse?.button, pointerId: pointer?.pointerId,
            path: event.composedPath().filter(node => node instanceof Element).slice(0, 5).map(node => {
              const element = node as Element
              return { tag: element.tagName, classes: (element.getAttribute("class") ?? "").slice(0, 160),
                hover: element.matches(":hover"), focusWithin: element.matches(":focus-within"),
                captured: pointer ? element.hasPointerCapture(pointer.pointerId) : undefined }
            }) })
          if (events.length > 64) events.shift()
        }, { passive: true })
      }
    }).catch(() => {})
    await run(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const snapshot = await Promise.race([page.evaluate(() => {
        const tool = document.querySelector<HTMLElement>('.tool-call[data-part-id="step-0"]') ?? document.querySelector<HTMLElement>(".tool-call")
        const header = tool?.querySelector<HTMLElement>(":scope > .tool-call-header")
        const copy = header?.querySelector<HTMLButtonElement>(".tool-call-header-copy:not(.action-overflow-trigger)")
        const stream = document.querySelector<HTMLElement>(".message-stream")
        const rect = copy?.getBoundingClientRect()
        const x = rect ? rect.x + rect.width / 2 : undefined, y = rect ? rect.y + rect.height / 2 : undefined
        const hit = x !== undefined && y !== undefined ? document.elementFromPoint(x, y) : null
        const hitPath: unknown[] = []
        for (let node = hit; node && hitPath.length < 5; node = node.parentElement) {
          hitPath.push({ tag: node.tagName, classes: (node.getAttribute("class") ?? "").slice(0, 160) })
        }
        const events = ((window as any).renderCostFailureEvents ?? []) as Array<{ pointerId?: number }>
        const pointerIds = [...new Set(events.map(event => event.pointerId).filter(id => id !== undefined))].slice(-8)
        return { observedAtFailure: performance.now(), fonts: document.fonts.status, focused: document.hasFocus(), visibility: document.visibilityState,
          viewport: { width: innerWidth, height: innerHeight }, desktopPointer: matchMedia("(hover: hover) and (pointer: fine)").matches,
          selection: tool?.getAttribute("data-part-id") === "step-0" ? "step-0" : tool ? "first-tool" : "absent",
          activeElement: { tag: document.activeElement?.tagName, classes: (document.activeElement?.getAttribute("class") ?? "").slice(0, 160) },
          header: { hover: header?.matches(":hover"), focusWithin: header?.matches(":focus-within"),
            contentOverflow: header?.dataset.contentOverflow, actionOverflow: header?.dataset.actionOverflow },
          copyCenter: { x, y, inViewport: x !== undefined && y !== undefined && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight }, hitPath,
          elements: [tool, header, copy, stream, document.body, document.documentElement].map(element => {
            if (!element) return null
            const style = getComputedStyle(element), bounds = element.getBoundingClientRect()
            return { tag: element.tagName, classes: (element.getAttribute("class") ?? "").slice(0, 160),
              rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
              opacity: style.opacity, pointerEvents: style.pointerEvents, visibility: style.visibility, display: style.display, cursor: style.cursor,
              inert: element.inert, inertAncestor: Boolean(element.closest("[inert]")), disabled: element.matches(":disabled"), scrollTop: element.scrollTop,
              capturedPointers: pointerIds.filter(id => element.hasPointerCapture(id!)) }
          }),
          originalStepSame: Boolean(tool && tool === (window as any).originalStep),
          originalScrollerSame: Boolean(tool?.querySelector(".tool-call-markdown") && tool.querySelector(".tool-call-markdown") === (window as any).originalScroller),
          outputScrollTop: tool?.querySelector(".tool-call-markdown")?.scrollTop, routingCursor: stream?.style.cursor, events }
      }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Failure diagnostic unavailable")), 2000) })])
      const record = { source: "render-cost.open", originalError: { name: error instanceof Error ? error.name.slice(0, 128) : typeof error,
        message: error instanceof Error ? error.message.split("\n", 1)[0].slice(0, 1024) : "Non-Error failure" }, snapshot, omittedEvents: 0 }
      while (Buffer.byteLength(JSON.stringify(record), "utf8") > 32 * 1024 && snapshot.events.length) { snapshot.events.shift(); record.omittedEvents++ }
      if (Buffer.byteLength(JSON.stringify(record), "utf8") > 32 * 1024) throw new Error("Failure diagnostic exceeded bound")
      console.error("render-cost-failure", JSON.stringify(record))
    } catch (diagnosticError) {
      try {
        console.error("render-cost-failure", JSON.stringify({ source: "render-cost.open", originalError: {
          name: error instanceof Error ? error.name.slice(0, 128) : typeof error,
          message: error instanceof Error ? error.message.split("\n", 1)[0].slice(0, 1024) : "Non-Error failure" },
          diagnosticError: diagnosticError instanceof Error ? diagnosticError.name.slice(0, 128) : typeof diagnosticError }))
      } catch {}
    } finally { if (timer) clearTimeout(timer) }
    throw error
  } finally { await page.close() }
}
const step = (page: Page, index = 0) => page.locator(`.tool-call[data-part-id="step-${index}"]`)
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

test("unrelated child text keeps mounted task steps, disclosure, scroller and copies", async () => open("mode=task&count=12", async page => {
  const tool = step(page)
  await tool.waitFor()
  await page.evaluate(() => (window as any).fixture.startText())
  await frames(page)
  await tool.locator(":scope > .tool-call-header > .tool-call-header-toggle").click()
  await tool.locator("pre code").waitFor()
  await frames(page)
  await tool.evaluate(element => { (window as any).originalStep = element })
  await page.evaluate(() => (window as any).fixture.reproject())
  assert.equal(await tool.evaluate(element => element === (window as any).originalStep), true, "authoritative reprojection must not recreate the tool shell")
  const output = tool.locator(".tool-call-markdown")
  const box = (await output.boundingBox())!
  await page.mouse.move(box.x + 30, box.y + 60)
  await page.mouse.down({ button: "middle" })
  try {
    await output.evaluate(element => { (window as any).originalScroller = element; element.scrollTop = 240 })
    await page.evaluate(() => { (window as any).fixture.hold(); (window as any).fixture.reset(); (window as any).fixture.delta() })
    await page.waitForFunction(() => (window as any).fixture.snapshot().held > 0)
    assert.equal(await tool.evaluate(element => element === (window as any).originalStep), true, "pending display refresh must retain mounted steps")
    await page.evaluate(() => (window as any).fixture.release())
    await frames(page)
    const state = await page.evaluate(() => (window as any).fixture.snapshot())
    console.log("unrelated-update", { snapshots: state.snapshots, childRevision: state.childRevision, added: state.added, removed: state.removed })
    assert.equal(await tool.evaluate(element => element === (window as any).originalStep), true, "unrelated text must not remount a completed tool")
    assert.equal(await tool.locator(":scope > .tool-call-header > .tool-call-header-toggle").getAttribute("aria-expanded"), "true")
    assert.equal(await output.evaluate(element => element === (window as any).originalScroller), true)
    assert.equal(await output.evaluate(element => element.scrollTop), 240)
    assert.equal(state.added + state.removed, 0)
  } finally { await page.mouse.up({ button: "middle" }) }
  await tool.locator(":scope > .tool-call-header > .tool-call-header-copy").first().click()
  const state = await page.evaluate(() => (window as any).fixture.snapshot())
  assert.equal(state.clipboard[0], state.output)
  await page.evaluate(() => (window as any).fixture.toolUpdate(0, "Changed native output"))
  await page.waitForFunction(() => document.querySelector('.tool-call[data-part-id="step-0"]')?.textContent?.includes("Changed native output"))
  assert.equal(await tool.evaluate(element => element === (window as any).originalStep), true)
  await tool.locator(":scope > .tool-call-header > .tool-call-header-copy").first().click()
  assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).clipboard.at(-1), "Changed native output")
  await page.evaluate(() => (window as any).fixture.mutateTool())
  await page.waitForFunction(() => document.querySelector('.tool-call[data-part-id="step-0"]')?.textContent?.includes("Versioned in-place output"))
  assert.equal(await tool.evaluate(element => element === (window as any).originalStep), true)
  await page.evaluate(() => (window as any).fixture.failTool(0))
  await tool.locator(".tool-call-error-content").waitFor()
  assert.match((await tool.textContent())!, /Deterministic failure/)
  await page.evaluate(() => (window as any).fixture.removeTool(0))
  await tool.waitFor({ state: "detached" })
  await page.evaluate(() => (window as any).fixture.clearChild())
  assert.equal(await page.locator('.tool-call[data-part-id^="step-"]').count(), 0, "authoritative empty pages must clear stale displayed steps")
}))

test("a failed child refresh keeps the last display snapshot with an explicit retry error", async () => open("mode=task&count=12", async page => {
  const tool = step(page)
  await tool.waitFor()
  await page.evaluate(() => (window as any).fixture.startText())
  await frames(page)
  await tool.locator(":scope > .tool-call-header > .tool-call-header-toggle").click()
  await tool.locator("pre code").waitFor()
  await tool.evaluate(element => { (window as any).originalStep = element })
  await page.evaluate(() => (window as any).fixture.failRead())
  await page.getByRole("alert").filter({ hasText: "Deterministic read failure" }).waitFor()
  assert.equal(await tool.evaluate(element => element === (window as any).originalStep), true)
  assert.equal(await tool.locator(":scope > .tool-call-header > .tool-call-header-toggle").getAttribute("aria-expanded"), "true")
  await page.getByRole("alert").getByRole("button").click()
  await page.getByRole("alert").waitFor({ state: "detached" })
  assert.equal(await tool.evaluate(element => element === (window as any).originalStep), true)
}))

test("native page output must not reuse zero-revision Markdown when a tool is reopened", async () => open("mode=task&count=1", async page => {
  const tool = step(page), toggle = tool.locator(":scope > .tool-call-header > .tool-call-header-toggle")
  await tool.waitFor()
  await toggle.click()
  await tool.locator("pre code").waitFor()
  await page.evaluate(() => (window as any).fixture.toolUpdate(0, "Replacement native page output"))
  await page.waitForFunction(() => (window as any).fixture.toolOutput() === "Replacement native page output")
  await frames(page)
  // The old renderer closes on reprojection. Reopen it to distinguish a stale
  // render-cache hit from the separately asserted disclosure/remount defect.
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click()
  await tool.locator("pre code").waitFor()
  await frames(page)
  assert.equal((await tool.locator("pre code").textContent())?.trim() === "Replacement native page output", true,
    "the native record changed but the displayed Markdown is stale")
  await tool.locator(":scope > .tool-call-header > .tool-call-header-copy").first().click()
  assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).clipboard.at(-1), "Replacement native page output")
}))

test("changing an indexed task key does not transfer a removed tool's disclosure", async () => open("mode=task&count=200", async page => {
  const first = step(page)
  await first.waitFor()
  await first.locator(":scope > .tool-call-header > .tool-call-header-toggle").click()
  await first.locator("pre code").waitFor()
  await page.evaluate(() => (window as any).fixture.appendTool())
  await first.waitFor({ state: "detached" })
  assert.equal(await step(page, 1).locator(":scope > .tool-call-header > .tool-call-header-toggle").getAttribute("aria-expanded"), "false")
  assert.equal(await page.locator('.tool-call[data-part-id="appended-step"]').count(), 1)
}))

for (const retainedIndex of [0, 1]) {
  test(`authoritative task membership 2->1->2 preserves retained step-${retainedIndex}`, async () => open("mode=task&count=2", async page => {
    const retained = step(page, retainedIndex)
    const counter = page.locator('.tool-call[data-part-id="parent-task"] .tool-call-task-section-meta').filter({ hasText: /^\d+ steps$/ })
    await retained.waitFor()
    assert.equal(await counter.textContent(), "2 steps")
    await retained.locator(":scope > .tool-call-header > .tool-call-header-toggle").click()
    const output = retained.locator(".tool-call-markdown")
    await retained.locator("pre code").waitFor()
    await frames(page)
    await retained.evaluate(element => { (window as any).retainedShell = element })
    await output.evaluate(element => { (window as any).retainedScroller = element; element.scrollTop = 240 })

    await page.evaluate(index => (window as any).fixture.replaceChildTools([index]), retainedIndex)
    await frames(page)
    assert.equal(await page.locator('.tool-call[data-part-id^="step-"]').count(), 1)
    assert.equal(await counter.textContent(), "1 steps", "removed parts must also leave the membership counter")
    await page.evaluate(index => (window as any).fixture.replaceChildTools([index, 2]), retainedIndex)
    await frames(page)
    assert.equal(await counter.textContent(), "2 steps")
    assert.equal(await step(page, 2).count(), 1, "new identity at the former cardinality must appear exactly once")
    assert.equal(await retained.evaluate(element => element === (window as any).retainedShell), true)
    assert.equal(await retained.locator(":scope > .tool-call-header > .tool-call-header-toggle").getAttribute("aria-expanded"), "true")
    assert.equal(await output.evaluate(element => element === (window as any).retainedScroller), true)
    assert.equal(await output.evaluate(element => element.scrollTop), 240)
  }))
}

test("authoritative task membership replaces and reorders equal-cardinality identities", async () => open("mode=task&count=2", async page => {
  const retained = step(page, 0)
  const counter = page.locator('.tool-call[data-part-id="parent-task"] .tool-call-task-section-meta').filter({ hasText: /^\d+ steps$/ })
  await retained.waitFor()
  await retained.locator(":scope > .tool-call-header > .tool-call-header-toggle").click()
  await retained.locator("pre code").waitFor()
  await retained.evaluate(element => { (window as any).retainedShell = element })
  await page.evaluate(() => (window as any).fixture.replaceChildTools([2, 0]))
  await frames(page)
  assert.equal(await counter.textContent(), "2 steps")
  assert.deepEqual(await page.locator('.tool-call[data-part-id^="step-"]').evaluateAll(elements => elements.map(element => element.getAttribute("data-part-id"))), ["step-2", "step-0"])
  assert.equal(await step(page, 1).count(), 0)
  assert.equal(await retained.evaluate(element => element === (window as any).retainedShell), true)
  assert.equal(await retained.locator(":scope > .tool-call-header > .tool-call-header-toggle").getAttribute("aria-expanded"), "true")
}))

test("authoritative task membership drops a tool changed to text under the same part id", async () => open("mode=task&count=2", async page => {
  await step(page, 1).waitFor()
  await page.evaluate(() => (window as any).fixture.replaceChildTools([0, 1], [1]))
  await frames(page)
  const counter = page.locator('.tool-call[data-part-id="parent-task"] .tool-call-task-section-meta').filter({ hasText: /^\d+ steps$/ })
  assert.equal(await counter.textContent(), "1 steps")
  assert.equal(await step(page, 1).count(), 0)
  assert.equal(await step(page, 0).count(), 1)
}))

test("authoritative task membership keeps the 200-step bound and clears stale truncation after shrink", async () => open("mode=task&count=201", async page => {
  await step(page, 200).waitFor()
  const counter = page.locator('.tool-call[data-part-id="parent-task"] .tool-call-task-section-meta').filter({ hasText: /^\d+\+? steps$/ })
  assert.equal(await counter.textContent(), "200+ steps")
  assert.equal(await page.locator('.tool-call[data-part-id^="step-"]').count(), 200)
  await page.evaluate(() => (window as any).fixture.replaceChildTools(Array.from({ length: 199 }, (_, index) => index + 2)))
  await frames(page)
  assert.equal(await counter.textContent(), "199 steps")
  assert.equal(await page.locator('.tool-call[data-part-id^="step-"]').count(), 199)
  assert.equal(await page.locator('.tool-call[data-part-id="parent-task"] .tool-call-diagnostic-message').count(), 0)
}))

for (const { count, legacy } of [{ count: 2, legacy: false }, { count: 201, legacy: false }, { count: 201, legacy: true }]) {
  test(`native batched child deletion clears task membership (count=${count}, legacy=${legacy})`, async () => open(`mode=task&count=${count}${legacy ? "&legacy=1" : ""}`, async page => {
    const parent = page.locator('.tool-call[data-part-id="parent-task"]')
    const counter = parent.locator(".tool-call-task-section-meta").filter({ hasText: /^\d+\+? steps$/ })
    await step(page, count - 1).waitFor()
    assert.equal(await counter.textContent(), `${count > 200 ? "200+" : count} steps`)
    assert.equal(await page.locator('.tool-call[data-part-id^="step-"]').count(), Math.min(count, 200))
    assert.equal(await parent.locator('[data-task-id="legacy-step"]').count(), 0, "native steps supersede the parent's legacy summary")
    await parent.evaluate(element => { (window as any).originalParentTask = element })
    await page.evaluate(() => (window as any).fixture.deleteChild())
    await frames(page)
    const state = await page.evaluate(() => (window as any).fixture.snapshot())
    assert.deepEqual(state.childMessageIds, [])
    assert.equal(state.childLoaded, false)
    assert.equal(state.childExists, false)
    assert.equal(state.parentChildId, "child", "native child deletion must not need a parent metadata update")
    assert.equal(state.loaded, 1, "parent transcript remains resident")
    assert.equal(await parent.evaluate(element => element === (window as any).originalParentTask), true)
    assert.equal(await page.locator('.tool-call[data-part-id^="step-"]').count(), 0)
    assert.equal(await parent.locator(".tool-call-diagnostic-message").count(), 0, "deleted native membership must clear its truncation state")
    if (legacy) {
      assert.equal(await counter.textContent(), "1 steps", "fallback count must use the parent's legacy summary, not deleted native keys")
      assert.equal(await parent.locator('[data-task-id="legacy-step"]').textContent().then(text => text?.includes("Parent legacy summary")), true)
    } else {
      assert.equal(await counter.count(), 0, "a deleted child without legacy steps must not retain a ghost count")
      assert.equal(await parent.getByText("Steps", { exact: true }).count(), 0)
    }
  }))
}

test("audit sample: deterministic native child deltas (timings are observations, not a CI threshold)", async () => open(`mode=task&count=80&instrument=${process.env.CODENOMAD_RENDER_INSTRUMENT ?? "on"}`, async page => {
  await step(page, 79).waitFor()
  await page.evaluate(() => (window as any).fixture.startText())
  await frames(page)
  await page.evaluate(() => (window as any).fixture.measure(3))
  await frames(page)
  const samples = []
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  const metrics = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics")
    const ms = (name: string) => metrics.find(metric => metric.name === name)!.value * 1000
    return { scriptMs: ms("ScriptDuration"), taskMs: ms("TaskDuration"), layoutMs: ms("LayoutDuration"), styleMs: ms("RecalcStyleDuration") }
  }
  for (let index = 0; index < 10; index++) {
    const before = await metrics()
    const sync = await page.evaluate(() => { const f = (window as any).fixture; f.reset(); return f.measure(1) })
    await frames(page)
    const state = await page.evaluate(() => (window as any).fixture.snapshot())
    const after = await metrics()
    samples.push({ syncMs: sync.ms, scriptMs: after.scriptMs - before.scriptMs, taskMs: after.taskMs - before.taskMs,
      layoutMs: after.layoutMs - before.layoutMs, styleMs: after.styleMs - before.styleMs,
      snapshots: state.snapshots, added: state.added, removed: state.removed })
  }
  console.log("render-cost-native-deltas", JSON.stringify({ variant: process.env.CODENOMAD_RENDER_TASK_BASELINE ? "baseline" : "fixed",
    browser: browser.version(), instrumented: process.env.CODENOMAD_RENDER_INSTRUMENT !== "off", samples }))
  if (!process.env.CODENOMAD_RENDER_TASK_BASELINE && process.env.CODENOMAD_RENDER_INSTRUMENT !== "off") {
    assert.ok(samples.every(sample => sample.added === 0 && sample.removed === 0), "structural rescans must not remount unchanged task shells")
  }
  assert.equal(await page.locator('.tool-call[data-part-id^="step-"]').count(), 80)
}))

test("large tool output bounds rendered text but preserves full clipboard source", async () => open("mode=task&count=1&size=2000000", async page => {
  const tool = step(page)
  await tool.waitFor()
  assert.equal(await tool.locator(".tool-call-details").count(), 0, "collapsed steps must not mount their bodies")
  const start = await page.evaluate(() => performance.now())
  await tool.locator(":scope > .tool-call-header > .tool-call-header-toggle").click()
  await tool.locator("pre code").waitFor()
  const content = await tool.locator("pre code").textContent()
  assert.ok(content && content.length <= 10_000)
  assert.ok((await tool.textContent())!.includes("Output truncated"))
  console.log("large-output", { renderedCharacters: content!.length, ...await page.evaluate(start => ({ msToObservedRender: performance.now() - start, nodes: document.querySelectorAll("*").length }), start) })
  await tool.locator(":scope > .tool-call-header > .tool-call-header-copy").first().click()
  const state = await page.evaluate(() => (window as any).fixture.snapshot())
  assert.equal(state.clipboard[0], state.output)
  assert.equal(state.output.length, 2_000_000)
}))

test("transcript loads one bounded history page and mounts only virtual rows", async () => open("mode=transcript&count=1000", async page => {
  await page.waitForFunction(() => document.querySelector(".message-stream")?.textContent?.includes("History 999"))
  await frames(page)
  const state = await page.evaluate(() => (window as any).fixture.snapshot())
  const rows = await page.locator("[data-virtual-follow-key]").count()
  const markers = await page.locator(".timeline-virtual-row").count()
  console.log("transcript-bounds", { loaded: state.loaded, rows, markers, requests: state.requests })
  assert.equal(state.loaded, 200)
  assert.ok(rows < 40)
  assert.ok(markers < 80)
}))

test("timeline exact extent, bounded DOM and active highlight updates do not mount messages", async () => open("mode=timeline&count=10000", async page => {
  await page.locator('.message-timeline-segment[data-message-id="message-0"]').first().waitFor()
  await frames(page)
  const samples = []
  for (let index = 0; index < 10; index++) {
    samples.push(await page.evaluate(() => (window as any).fixture.measure(30)))
    await frames(page)
  }
  console.log("timeline-active-updates", JSON.stringify({ samples, snapshot: await page.evaluate(() => (window as any).fixture.snapshot()) }))
  const geometry = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".timeline-virtual-content")!
    const marker = document.querySelector<HTMLElement>(".timeline-measure button")!
    const gap = document.querySelector<HTMLElement>(".timeline-measure div")!
    const markerHeight = parseFloat(getComputedStyle(marker).height), gapHeight = parseFloat(getComputedStyle(gap).height)
    // Each 3-marker group has a double gap before its tool and following user.
    let units = 0
    for (let index = 1; index < 10000; index++) units += index % 3 === 2 ? 1 : 2
    return { extent: parseFloat(content.style.height), expected: markerHeight * 10000 + gapHeight * units, mounted: document.querySelectorAll(".timeline-virtual-row").length }
  })
  console.log("timeline-geometry", geometry)
  // CSS serialization and native scroll extents round at this magnitude.
  assert.ok(Math.abs(geometry.extent - geometry.expected) < 1)
  assert.ok(geometry.mounted < 80)
  assert.equal(await page.locator(".tool-call, [data-view=message-item]").count(), 0)
  await page.locator('.message-timeline-segment[data-message-id="message-0"]').first().hover()
  await page.getByRole("tooltip").locator("strong").waitFor()
  assert.ok((await page.getByRole("tooltip").textContent())!.length <= 4096)
  await page.locator('.message-timeline-segment[data-message-id="message-0"]').first().click()
  assert.equal((await page.evaluate(() => (window as any).fixture.snapshot())).selected, "marker-0")
}))

test("failure-only diagnostics retain the originating error and close the page even when the snapshot fails", async () => {
  const originalConsoleError = console.error
  const records: string[] = []
  console.error = (...args) => { if (args[0] === "render-cost-failure") records.push(String(args[1])); else originalConsoleError(...args) }
  try {
    for (const closed of [false, true]) {
      const originatingError = new Error("Owned diagnostic failure check")
      let ownedPage: Page | undefined
      await assert.rejects(open("mode=task&count=1", async page => {
        ownedPage = page
        if (closed) await page.close()
        throw originatingError
      }), error => error === originatingError)
      assert.equal(ownedPage!.isClosed(), true)
      const record = JSON.parse(records.at(-1)!)
      assert.equal(record.originalError.message, originatingError.message)
      assert.ok(Buffer.byteLength(records.at(-1)!, "utf8") <= 32 * 1024)
      if (closed) assert.equal(record.diagnosticError, "Error")
      else {
        assert.match(record.snapshot.selection, /^(step-0|first-tool)$/)
        assert.ok(Array.isArray(record.snapshot.events) && record.snapshot.events.length <= 64)
      }
    }
    assert.equal(records.length, 2)
  } finally { console.error = originalConsoleError }
})
