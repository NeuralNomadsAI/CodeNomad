import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"
import { fixtureEventStream } from "./fixture-event-stream"
import { observeHeaderFixture } from "./header-fixture-diagnostics"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>> | undefined
async function disposeFixture() {
  const owned = events
  events = undefined
  try { await browser?.close() } finally { await owned?.close() }
}
before(async () => {
  let ready = false
  await runWithDiagnosticCleanup({ run: async () => {
  const fixture = await borrowFixture({ name: "panel-resize", routes: [{ path: "/fixture",
    html: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/header-windows.tsx"></script></body></html>',
  }] })
  url = fixture.url + "?drawerWidth=1"
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  ready = true
  }, diagnose: async () => {}, cleanup: async () => { if (!ready) await disposeFixture() },
  onObservationError: () => console.error("panel-resize-setup-observation-failed"),
  onCleanupError: () => console.error("panel-resize-setup-cleanup-failed") })
})
after(disposeFixture)

async function openPage(hasTouch = false) {
  let page: Page | undefined, diagnostics: ReturnType<typeof observeHeaderFixture> | undefined, ready = false
  return runWithDiagnosticCleanup({ run: async () => {
    page = await browser.newPage({ viewport: { width: 1600, height: 900 }, hasTouch })
    diagnostics = observeHeaderFixture(page)
    await diagnostics.install()
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await events!.route(page)
    await page.route("**/workspaces/header-windows/yolo/sessions/session", route => route.request().method() === "GET"
      ? route.fulfill({ json: { enabled: false } }) : route.continue())
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    ready = true
    return page
  }, diagnose: async () => {
    const directory = await mkdtemp(join(process.env.CODENOMAD_TEST_TEMP || tmpdir(), "panel-resize-failure-"))
    let snapshot = ""
    await diagnostics?.diagnose(message => { snapshot = message })
    await writeFile(join(directory, "bootstrap.json"), snapshot)
    console.error("panel-resize-bootstrap-failed", directory)
  },
  cleanup: async () => { diagnostics?.detach(); if (!ready) await page?.close() },
  onObservationError: () => console.error("panel-resize-observation-failed"),
  onCleanupError: () => console.error("panel-resize-cleanup-failed") })
}

for (const stage of ["addInitScript", "goto", "waitForFunction"] as const) {
  for (const secondary of [false, true]) test(`panel setup closes after ${stage} failure (secondary=${secondary})`, async t => {
    const page = await browser.newPage(), primary = new Error("panel setup sentinel"), stack = primary.stack
    t.mock.method(browser, "newPage", async () => page)
    t.mock.method(page, stage, async () => { throw primary })
    const close = page.close.bind(page)
    t.mock.method(page, "close", async () => { await close(); if (secondary) throw new Error("cleanup sentinel") })
    t.mock.method(console, "error", () => { if (secondary) throw new Error("diagnostic sentinel") })
    await assert.rejects(openPage(), error => error === primary)
    assert.equal(primary.stack, stack)
    assert.equal(page.isClosed(), true)
    for (const event of ["console", "pageerror", "requestfailed", "response", "framenavigated"]) {
      assert.equal((page as any).listenerCount(event), 0, `observer detached ${event}`)
    }
  })
}

for (const release of [false, true]) test(`a held initial HTTP read ${release ? "publishes when released" : "retains the original readiness deadline"}`, async t => {
  const page = await browser.newPage(), route = page.route.bind(page), install = page.addInitScript.bind(page)
  const diagnostics: unknown[][] = []
  let releaseRead!: () => void, held = false
  const pending = new Promise<void>(resolve => { releaseRead = resolve })
  t.mock.method(browser, "newPage", async () => page)
  t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args) })
  t.mock.method(page, "route", async (pattern: Parameters<Page["route"]>[0], handler: Parameters<Page["route"]>[1]) => route(pattern, async (request, original) => {
    if (new URL(request.request().url()).pathname === "/api/storage/state/ui") { held = true; await pending }
    await handler(request, original)
  }))
  await page.exposeBinding("releasePanelRead", (_source, phase) => { if (release && phase === "preferences-before") releaseRead() })
  t.mock.method(page, "addInitScript", async (script: any) => {
    await install(script)
    await install(() => {
      const boot = (window as any).__headerFixtureBoot, mark = boot.mark
      boot.mark = (phase: string, detail: string) => { mark(phase, detail); void (window as any).releasePanelRead(phase) }
    })
  })
  try {
    if (release) {
      await openPage()
      assert.equal(await page.evaluate(() => Boolean((window as any).fixture)), true)
    } else {
      await assert.rejects(openPage(), /30000ms exceeded/)
      const directory = diagnostics.find(entry => entry[0] === "panel-resize-bootstrap-failed")![1] as string
      const report = JSON.parse(await readFile(join(directory, "bootstrap.json"), "utf8"))
      assert.equal(report.snapshot.fixture, "undefined")
      assert.equal(report.snapshot.boot.at(-1).phase, "preferences-before")
      assert.ok(report.snapshot.boot.some((entry: any) => entry.phase === "render-after"))
      assert.equal(page.isClosed(), true)
    }
    assert.equal(held, true, "the control holds the real initial HTTP read")
  } finally { releaseRead(); await page.close() }
})

async function startDrag(page: Page, side: "left" | "right") {
  const handle = page.locator(`.session-resize-handle--${side}`)
  await handle.evaluate(element => {
    const probe = (window as any).resizeProbe = { element, pointerId: -1, outsideMoves: 0 }
    element.addEventListener("pointerdown", event => { probe.pointerId = (event as PointerEvent).pointerId }, { once: true })
    document.querySelector("#outside")!.addEventListener("pointermove", () => { probe.outsideMoves++ })
  })
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2, y = box.y + 160
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y)
  await page.waitForFunction(() => {
    const { element, pointerId } = (window as any).resizeProbe
    return element.hasPointerCapture(pointerId) && element.classList.contains("is-resizing")
  })
  return { handle, x, y }
}

async function assertStopped(page: Page) {
  await page.waitForFunction(() => {
    const { element, pointerId } = (window as any).resizeProbe
    return !element.hasPointerCapture(pointerId) && (!element.isConnected || !element.classList.contains("is-resizing"))
  })
}

for (const locale of ["en", "he"] as const) {
  for (const side of ["left", "right"] as const) {
    test(`${locale} ${side} panel captures the pointer and stays highlighted beyond the handle`, async () => {
      const page = await openPage()
      try {
        await page.evaluate(locale => (window as any).fixture.setLocale(locale), locale)
        await page.waitForFunction(dir => document.documentElement.dir === dir, locale === "he" ? "rtl" : "ltr")
        const panel = page.locator(side === "left" ? ".session-sidebar-container" : ".session-right-panel")
        const startWidth = (await panel.boundingBox())!.width
        const { handle, x, y } = await startDrag(page, side)
        const direction = (side === "left" ? 1 : -1) * (locale === "he" ? -1 : 1)
        await page.mouse.move(x + direction * 100, y, { steps: 8 })
        assert.ok(Math.abs((await panel.boundingBox())!.width - startWidth - 100) <= 1)

        // Moving vertically away keeps the chosen width and leaves the real handle's hit area.
        const outside = (await page.locator("#outside").boundingBox())!
        await page.mouse.move(x + direction * 100, outside.y + outside.height / 2)
        assert.deepEqual(await page.evaluate(() => {
          const { element, pointerId, outsideMoves } = (window as any).resizeProbe
          return { captured: element.hasPointerCapture(pointerId), active: element.classList.contains("is-resizing"),
            outsideHovered: document.querySelector("#outside")!.matches(":hover"), outsideMoves }
        }), { captured: true, active: true, outsideHovered: false, outsideMoves: 0 })
        await page.waitForFunction(() => getComputedStyle((window as any).resizeProbe.element).backgroundColor !== "rgba(0, 0, 0, 0)")
        await page.mouse.up()
        await assertStopped(page)
        await page.waitForFunction(() => getComputedStyle((window as any).resizeProbe.element).backgroundColor === "rgba(0, 0, 0, 0)")
        assert.equal(await handle.evaluate(element => element.classList.contains("is-resizing")), false)
        await page.mouse.move(x + direction * 100 + 1, outside.y + outside.height / 2)
        assert.ok(await page.evaluate(() => (window as any).resizeProbe.outsideMoves > 0))
      } finally { await page.close() }
    })

    test(`${locale} ${side} panel keeps resizing when the opposite panel closes`, async () => {
      const page = await openPage()
      try {
        await page.evaluate(locale => (window as any).fixture.setLocale(locale), locale)
        await page.waitForFunction(dir => document.documentElement.dir === dir, locale === "he" ? "rtl" : "ltr")
        const panel = page.locator(side === "left" ? ".session-sidebar-container" : ".session-right-panel")
        const startWidth = (await panel.boundingBox())!.width
        const { handle, x, y } = await startDrag(page, side)
        const direction = (side === "left" ? 1 : -1) * (locale === "he" ? -1 : 1)
        await page.mouse.move(x + direction * 40, y)
        assert.ok(Math.abs((await panel.boundingBox())!.width - startWidth - 40) <= 1)

        const oppositeSide = side === "left" ? "right" : "left"
        await page.evaluate(side => (window as any).fixture.viewAction(`view-${side}-panel`), oppositeSide)
        assert.equal(await page.locator(`.session-resize-handle--${oppositeSide}`).count(), 0)
        await page.mouse.move(x + direction * 80, y)
        assert.ok(Math.abs((await panel.boundingBox())!.width - startWidth - 80) <= 1)
        assert.deepEqual(await handle.evaluate(element => ({
          captured: element.hasPointerCapture((window as any).resizeProbe.pointerId),
          active: element.classList.contains("is-resizing"),
        })), { captured: true, active: true })
        await page.mouse.up()
        await assertStopped(page)
      } finally { await page.close() }
    })
  }
}

for (const reason of ["cancel", "lost capture", "removed handle"] as const) {
  test(`panel drag cleans up on ${reason}`, async () => {
    const page = await openPage()
    try {
      await startDrag(page, "left")
      await page.evaluate(reason => {
        const { element, pointerId } = (window as any).resizeProbe
        if (reason === "cancel") element.dispatchEvent(new PointerEvent("pointercancel", { pointerId, bubbles: true }))
        if (reason === "lost capture") element.releasePointerCapture(pointerId)
        if (reason === "removed handle") (window as any).fixture.viewAction("view-left-panel")
      }, reason)
      // Process a pending native capture transfer/removal.
      await page.mouse.move(600, 300)
      await assertStopped(page)
      await page.mouse.up()
      if (reason === "removed handle") {
        await page.evaluate(() => (window as any).fixture.viewAction("view-left-panel"))
        assert.equal(await page.locator(".session-resize-handle--left").evaluate(element => element.classList.contains("is-resizing")), false)
        await startDrag(page, "left")
        await page.mouse.up()
        await assertStopped(page)
      }
    } finally { await page.close() }
  })
}

test("touch resizing uses capture and clears it on cancellation", async () => {
  const page = await openPage(true)
  try {
    const handle = page.locator(".session-resize-handle--left")
    await handle.evaluate(element => {
      const probe = (window as any).resizeProbe = { element, pointerId: -1 }
      element.addEventListener("pointerdown", event => { probe.pointerId = (event as PointerEvent).pointerId }, { once: true })
    })
    const box = (await handle.boundingBox())!
    const cdp = await page.context().newCDPSession(page)
    const x = box.x + box.width / 2, y = box.y + 160
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 100, y }] })
    assert.equal(await handle.evaluate(element => element.classList.contains("is-resizing")), true)
    assert.ok(Math.abs((await page.locator(".session-sidebar-container").boundingBox())!.width - 440) <= 1)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
    await assertStopped(page)
  } finally { await page.close() }
})

test("secondary mouse button does not start resizing", async () => {
  const page = await openPage()
  try {
    const handle = page.locator(".session-resize-handle--left")
    const panel = page.locator(".session-sidebar-container")
    const startWidth = (await panel.boundingBox())!.width
    await handle.evaluate(element => {
      element.addEventListener("pointerdown", event => { (window as any).secondaryPointerId = (event as PointerEvent).pointerId }, { once: true })
    })
    const box = (await handle.boundingBox())!
    const x = box.x + box.width / 2, y = box.y + 160
    await page.mouse.move(x, y)
    await page.mouse.down({ button: "right" })
    await page.mouse.move(x + 100, y, { steps: 8 })
    assert.equal((await panel.boundingBox())!.width, startWidth)
    assert.deepEqual(await handle.evaluate(element => ({
      captured: element.hasPointerCapture((window as any).secondaryPointerId),
      active: element.classList.contains("is-resizing"),
    })), { captured: false, active: false })
    await page.mouse.up({ button: "right" })
  } finally { await page.close() }
})
