import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "panel-resize", routes: [{ path: "/fixture",
    html: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/header-windows.tsx"></script></body></html>',
  }] })
  url = fixture.url + "?drawerWidth=1"
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function openPage(hasTouch = false) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, hasTouch })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return page
}

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
    await page.locator(".session-resize-handle--left").click({ button: "right" })
    assert.equal(await page.locator(".session-resize-handle--left").evaluate(element => element.classList.contains("is-resizing")), false)
  } finally { await page.close() }
})
