import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
async function fixturePage(run: (page: Page) => Promise<void>, initialPublicMarkdown = false) {
  const fixture = await borrowFixture({ name: "backend-media-security", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-media-security.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  try {
    const context = await browser.newContext()
    const page = await context.newPage(), errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.addInitScript({ content: 'window.EventSource = class extends EventTarget { close() {} }' })
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    if (initialPublicMarkdown) await page.route("https://public.example.invalid/image.png", async route => route.fulfill({
      contentType: "image/png", body: Buffer.from(await page.evaluate(() => (window as any).security.png)),
    }))
    await page.goto(fixture.url + (initialPublicMarkdown ? "?public-markdown=1" : ""))
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("[data-owner] img")].filter(image => image.naturalWidth === 8).length === 6)
    await page.evaluate(() => localStorage.setItem("reviewer-executed", "unchanged"))
    await openPublished(page, await page.evaluate(() => (window as any).security.created))
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
}

// Deliberately navigate every published URL even for a rejected case. With the
// vulnerable implementation this reaches script execution, rather than timing out.
async function openPublished(page: Page, entries: { url: string; type: string }[]) {
  for (const entry of entries) {
    const opened = await page.context().newPage()
    try {
      await opened.goto(entry.url)
      assert.equal(await page.evaluate(() => localStorage.getItem("reviewer-executed")), "unchanged", "remote document wrote UI localStorage")
      assert.equal(await opened.evaluate(() => localStorage.getItem("reviewer-executed")), "unchanged", "opened image retains an inert UI-origin document")
      assert.equal(await opened.locator("script").count(), 0)
    } finally { await opened.close() }
  }
}

async function guardedGestures(page: Page, selector: string) {
  const image = page.locator(selector)
  await image.scrollIntoViewIfNeeded()
  const box = await image.boundingBox()
  assert.ok(box)
  for (const [event, button] of [["contextmenu", "right"], ["auxclick", "middle"]] as const) {
    await page.evaluate(event => {
      (window as any).gesture = null
      document.addEventListener(event, e => { (window as any).gesture = e }, { capture: true, once: true })
    }, event)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button })
    assert.deepEqual(await page.evaluate(() => {
      const e = (window as any).gesture as Event
      return { trusted: e.isTrusted, prevented: e.defaultPrevented, image: e.target instanceof HTMLImageElement }
    }), { trusted: true, prevented: true, image: false }, selector + " " + event)
  }
}

test("remote active, unknown and inline documents never publish a navigable blob in any consumer", async () => fixturePage(async page => {
  const script = 'localStorage.setItem("reviewer-executed",location.origin)'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>${script}</script></svg>`
  for (const [payload, type] of [[svg, "image/svg+xml"], [svg, "image/png"], [`<html><script>${script}</script>`, "image/png"],
    [svg, "application/octet-stream"], ["unknown", "image/png"], ["%PDF-1.7", "application/pdf"]]) {
    const before = await page.evaluate(() => (window as any).security.created.length)
    await page.evaluate(({ payload, type }) => (window as any).security.configure(payload, type), { payload, type })
    await page.waitForFunction(() => (window as any).security.transferred === 3)
    await settle(page)
    const created = await page.evaluate(before => (window as any).security.created.slice(before), before)
    await openPublished(page, created)
    assert.deepEqual(created, [], "untrusted bytes must never acquire a UI-origin blob URL")
    assert.equal(await page.locator('[data-owner="remote"] img[src]').count(), 0)
    assert.equal(await page.locator('[data-owner="remote"] a[href^="blob:"]').count(), 0)
  }
  for (const inline of ["data:image/svg+xml," + encodeURIComponent(svg), "data:text/html," + encodeURIComponent(`<script>${script}</script>`),
    "data:image/png;base64," + Buffer.from(svg).toString("base64"),
    "data:image/png;base64," + Buffer.from(`<html><script>${script}</script>`).toString("base64"),
    await page.evaluate(svg => URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), svg)]) {
    const before = await page.evaluate(() => (window as any).security.created.length)
    await page.evaluate(inline => (window as any).security.configure("", "image/png", inline), inline)
    await settle(page)
    assert.equal(await page.locator('[data-owner="remote"] img[src]').count(), 0, "remote data/blob inputs are rejected")
    assert.equal(await page.evaluate(() => (window as any).security.created.length), before)
  }
}))

test("spoofed passive bytes get canonical MIME and stay inert when every consumer blob is opened in a same-context tab", async () => fixturePage(async page => {
  const before = await page.evaluate(() => (window as any).security.created.length)
  await page.evaluate(() => (window as any).security.configure((window as any).security.png, "text/html"))
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-owner="remote"] img')].filter(image => image.naturalWidth === 8).length === 3)
  const created = await page.evaluate(before => (window as any).security.created.slice(before), before)
  assert.equal(created.length, 3)
  assert.ok(created.every((entry: any) => entry.type === "image/png"))
  await openPublished(page, created)
  for (const kind of ["tool", "markdown", "attachment"]) {
    const image = page.locator(`[data-owner="remote"] [data-consumer="${kind}"] img`)
    assert.equal(await image.evaluate(image => getComputedStyle(image).pointerEvents), "none")
    assert.equal(await image.getAttribute("draggable"), "false")
    const parent = image.locator("..")
    for (const event of ["contextmenu", "auxclick"]) assert.equal(await parent.evaluate((element, event) =>
      element.dispatchEvent(new MouseEvent(event, { bubbles: true, cancelable: true, button: event === "auxclick" ? 1 : 2 })), event), false)
    const local = page.locator(`[data-owner="local"] [data-consumer="${kind}"] img`)
    assert.equal(await local.getAttribute("src"), await page.evaluate(() => (window as any).security.data))
    assert.equal(await local.getAttribute("style"), null)
    assert.equal(await local.getAttribute("draggable"), null)
    assert.equal(await local.evaluate(image => image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), true)
  }
  assert.equal(await page.locator('[data-owner="remote"] [data-consumer="markdown"] a[href]').count(), 0)
  assert.equal(await page.locator('[data-owner="local"] [data-consumer="markdown"] a').getAttribute("href"), "https://example.invalid/open")
  await page.locator('[data-owner="remote"] .attachment-chip').hover()
  const preview = page.locator(".attachment-image-popover img")
  await preview.waitFor()
  assert.equal(await preview.evaluate(image => getComputedStyle(image).pointerEvents), "none")
  assert.equal(await preview.locator("..").evaluate(element => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))), false)
  const external = "https://public.example.invalid/image.png"
  await page.route(external, async route => route.fulfill({ contentType: "image/png", body: Buffer.from(await page.evaluate(() => (window as any).security.png)) }))
  await page.evaluate(external => (window as any).security.configure("", "image/png", external), external)
  await page.waitForFunction(external => [...document.querySelectorAll<HTMLImageElement>('[data-owner="remote"] img')].filter(image => image.getAttribute("src") === external && image.naturalWidth === 8).length === 3, external)
  assert.equal(await page.locator('[data-owner="remote"] [data-consumer="markdown"] a').getAttribute("href"), "https://example.invalid/open")
  for (const image of await page.locator('[data-owner="remote"] img').all()) {
    assert.equal(await image.getAttribute("style"), null, "public HTTP sources retain ordinary interactions")
    assert.equal(await image.getAttribute("draggable"), null)
  }
}))

test("production resolver restricts an existing public Markdown image when a backend blob replaces its source", async () => fixturePage(async page => {
  const selector = '[data-owner="remote"] [data-consumer="markdown"] img'
  assert.equal(await page.locator(selector).getAttribute("src"), "https://public.example.invalid/image.png")
  assert.equal(await page.locator(selector).getAttribute("style"), null)
  assert.equal(await page.locator(selector).getAttribute("draggable"), null)
  assert.equal(await page.locator('[data-owner="remote"] [data-consumer="markdown"] a').getAttribute("href"), "https://example.invalid/open")
  await page.evaluate(() => {
    (window as any).previousImage = document.querySelector('[data-owner="remote"] [data-consumer="markdown"] img')
    // Feed the production resolver an already verified, still-live tool blob.
    ;(window as any).security.resolveExisting()
  })
  await page.waitForFunction(selector => { const image = document.querySelector<HTMLImageElement>(selector); return image?.src.startsWith("blob:") && image.naturalWidth === 8 }, selector)
  assert.equal(await page.evaluate(selector => (window as any).previousImage === document.querySelector(selector), selector), true)
  assert.equal(await page.locator(selector).evaluate(image => getComputedStyle(image).pointerEvents), "none")
  assert.equal(await page.locator(selector).getAttribute("draggable"), "false")
  assert.equal(await page.locator('[data-owner="remote"] [data-consumer="markdown"] a[href]').count(), 0)
  await guardedGestures(page, selector)
}, true))

test("remote passive data images use unauthenticated byte verification across tool, Markdown and attachments", async () => fixturePage(async page => {
  const before = await page.evaluate(() => ({ created: (window as any).security.created.length, calls: (window as any).security.backendCalls }))
  await page.evaluate(() => (window as any).security.configure("", "image/png", (window as any).security.data))
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-owner="remote"] img')].filter(image => image.src.startsWith("blob:") && image.naturalWidth === 8).length === 3)
  const created = await page.evaluate(before => (window as any).security.created.slice(before), before.created)
  assert.equal(created.length, 3)
  assert.ok(created.every((entry: any) => entry.type === "image/png"))
  assert.equal(await page.evaluate(() => (window as any).security.backendCalls), before.calls)
  assert.deepEqual(await page.evaluate(() => (window as any).security.dataCalls), Array(3).fill({ credentials: "omit" }))
  assert.equal(await page.locator('[data-owner="remote"] [data-consumer="markdown"] a[href]').count(), 0)
  for (const kind of ["tool", "markdown", "attachment"]) await guardedGestures(page, `[data-owner="remote"] [data-consumer="${kind}"] img`)
  await openPublished(page, created)
}))

test("every allowed signature is published with its canonical passive MIME even with active trailing bytes", async () => fixturePage(async page => {
  const png = await page.evaluate(() => (window as any).security.png as number[])
  const text = (value: string) => [...Buffer.from(value)]
  const bmp = new Array(26).fill(0); bmp.splice(0, 2, ...text("BM"))
  const ico = new Array(22).fill(0); ico.splice(0, 6, 0, 0, 1, 0, 1, 0)
  const avif = [0, 0, 0, 16, ...text("ftypavif"), 0, 0, 0, 0]
  const script = text('<html><script>localStorage.setItem("reviewer-executed",location.origin)</script><svg xmlns="http://www.w3.org/2000/svg"><script>localStorage.setItem("reviewer-executed",location.origin)</script></svg>')
  for (const [bytes, type] of [[png, "image/png"], [[255, 216, 255], "image/jpeg"], [text("GIF89a"), "image/gif"],
    [text("RIFFxxxxWEBP"), "image/webp"], [bmp, "image/bmp"], [ico, "image/x-icon"], [avif, "image/avif"]] as const) {
    const before = await page.evaluate(() => (window as any).security.created.length)
    await page.evaluate(bytes => (window as any).security.configure(bytes, "text/html"), [...bytes, ...script])
    await page.waitForFunction(() => (window as any).security.transferred === 3)
    await settle(page)
    const created = await page.evaluate(before => (window as any).security.created.slice(before), before)
    assert.equal(created.length, 3)
    assert.ok(created.every((entry: any) => entry.type === type))
    await openPublished(page, created)
  }
}))

test("detach during byte verification fences publication after the additional body await", async () => fixturePage(async page => {
  const before = await page.evaluate(() => (window as any).security.created.length)
  await page.evaluate(() => { (window as any).security.hold(); (window as any).security.configure((window as any).security.png, "image/png") })
  await page.waitForFunction(() => (window as any).security.pending === 3)
  await page.evaluate(() => { (window as any).security.detach(); (window as any).security.release() })
  await settle(page)
  assert.equal(await page.evaluate(() => (window as any).security.created.length), before)
  assert.equal(await page.locator('[data-owner="remote"] img[src]').count(), 0)
}))
