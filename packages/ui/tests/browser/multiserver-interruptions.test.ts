import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
const captures = fileURLToPath(new URL("../../../../.tmp/s12-live-fix/captures/", import.meta.url))
before(async () => {
  ;({ url } = await borrowFixture({ name: "multiserver-interruptions", routes: [{ path: "/interruptions", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/multiserver-interruptions.tsx"></script></body></html>' }] }))
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  await mkdir(captures, { recursive: true })
})
after(async () => { await browser?.close() })
async function setup(rtl = false, theme = "light", homonyms = false) {
  const page = await browser.newPage({ viewport: { width: 320, height: 900 }, deviceScaleFactor: 2 })
  const errors: string[] = [], forbidden: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname === "/api/storage/config/server") return route.fulfill({ json: {
      opencodeServers: homonyms ? ["A", "B"].map(id => ({ id, kind: "explicit", label: "Same server" })) : [],
    } })
    if (/pending-requests|permission-receipts|\/rpc\/|\/permission\/|\/form\//.test(route.request().url())) forbidden.push(route.request().url())
    return route.fulfill({ json: {} })
  })
  await page.goto(url + (rtl ? "?rtl=1" : ""))
  await page.waitForFunction(() => Boolean((window as any).fixture))
  await page.evaluate(theme => (window as any).fixture.theme(theme), theme)
  await page.waitForFunction(theme => document.documentElement.getAttribute("data-theme") === theme, theme)
  const a = page.locator('[data-owner="A"]'), b = page.locator('[data-owner="B"]')
  return { page, a, b, errors, forbidden, input: a.locator('input[type="text"]:visible') }
}

test("real dock keeps field DOM, caret and hidden drafts through metadata, disconnect and backend restoration; stale handlers send nothing", async () => {
  const f = await setup()
  try {
    await f.input.fill("Keep A draft")
    await f.input.focus()
    await f.input.evaluate(element => { (window as any).savedInput = element; (element as HTMLInputElement).setSelectionRange(3, 7) })
    await f.page.evaluate(() => (window as any).fixture.ask("A", "Updated metadata"))
    assert.equal(await f.input.evaluate(element => element === (window as any).savedInput && document.activeElement === element
      && (element as HTMLInputElement).selectionStart === 3 && (element as HTMLInputElement).selectionEnd === 7), true)
    await f.a.locator('.interruption-toggle').press("Enter")
    await f.page.evaluate(() => { (window as any).fixture.disconnect("A"); (window as any).fixture.backendDisconnect(); (window as any).fixture.backendRestore() })
    // prototype-1236: unknown coverage refuses stale replies without any notice.
    await f.a.locator('.interruption-toggle').press("Enter")
    assert.equal(await f.input.inputValue(), "Keep A draft")
    await f.input.fill("Editable stale A draft")
    assert.equal(await f.a.locator('button[type="submit"]').isDisabled(), true)
    assert.equal(await f.a.locator('.form-request-actions button[type="button"]').isDisabled(), true)
    assert.deepEqual(await f.page.evaluate(async () => [(await (window as any).fixture.rawReply("A")), (await (window as any).fixture.rawCancel("A"))]), ["refused", "refused"])
    await f.input.press("Enter")
    assert.equal(await f.input.inputValue(), "Editable stale A draft")
    await f.b.getByRole("textbox", { name: "Answer" }).fill("Keep B draft")
    await f.page.evaluate(() => { (window as any).fixture.permission("A"); (window as any).fixture.disconnect("A") })
    assert.equal(await f.page.evaluate(() => (window as any).fixture.rawPermission("A")), "refused")
    assert.equal(await f.b.getByRole("textbox", { name: "Answer" }).inputValue(), "Keep B draft")
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.notifications()), [])
    assert.equal(await f.page.evaluate(() => (window as any).fixture.screenNotices.length), 0)
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.calls), [])
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.forbidden), [])
    assert.deepEqual(f.forbidden, [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("same-label targets keep their stable IDs in dock details without notifications or a reader", async () => {
  const f = await setup(false, "light", true)
  try {
    await f.page.evaluate(() => { (window as any).fixture.disconnect("A"); (window as any).fixture.disconnect("B") })
    const contexts = await Promise.all([f.a, f.b].map(article => article.locator('details bdi').allTextContents()))
    assert.equal(contexts[0][0], "Same server (A)")
    assert.equal(contexts[1][0], "Same server (B)")
    assert.equal(contexts[0][1], contexts[1][1], "native directory remains the same exact opaque value")
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.notifications()), [])
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.forbidden), [])
    assert.deepEqual(f.forbidden, [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("a current form captured before late matching metadata becomes answerable without replacing its draft, caret or field DOM", async () => {
  const f = await setup()
  try {
    await f.input.fill("Fresh request draft")
    await f.input.focus()
    await f.input.evaluate(element => { (window as any).savedInput = element; (element as HTMLInputElement).setSelectionRange(2, 8) })
    await f.page.evaluate(() => (window as any).fixture.rotateLate("A"))
    assert.equal(await f.a.locator('button[type="submit"]').isDisabled(), true)
    assert.equal(await f.input.inputValue(), "Fresh request draft")
    await f.page.evaluate(() => (window as any).fixture.metadata("A"))
    assert.equal(await f.a.locator('button[type="submit"]').isDisabled(), false)
    assert.equal(await f.input.evaluate(element => element === (window as any).savedInput && document.activeElement === element
      && (element as HTMLInputElement).selectionStart === 2 && (element as HTMLInputElement).selectionEnd === 8), true)
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.calls), [])
    await f.page.evaluate(() => (window as any).fixture.dismissNotices())
    await f.a.scrollIntoViewIfNeeded()
    await f.page.screenshot({ path: `${captures}/late-metadata-current-${Date.now()}.png` })
    await f.input.press("Enter")
    assert.equal((await f.page.evaluate(() => (window as any).fixture.calls)).length, 1)
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.forbidden), [])
    assert.deepEqual(f.forbidden, [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

for (const kind of ["form", "permission"] as const) for (const uncertain of [false, true]) test(`${kind} ${uncertain ? "uncertain acknowledgement stays polite" : "ordinary failure remains an alert"} without draft/focus loss`, async () => {
  const f = await setup()
  try {
    if (kind === "permission") {
      await f.page.evaluate(() => (window as any).fixture.permission("A"))
      await f.a.getByRole("button", { name: "Previous request", exact: true }).press("Enter")
    }
    const source = kind === "form" ? f.input : f.a.locator("textarea")
    await source.fill("Preserve source draft")
    await f.page.evaluate(uncertain => uncertain ? (window as any).fixture.hold() : (window as any).fixture.fail(), uncertain)
    if (kind === "form") await source.press("Enter")
    else await f.a.getByRole("button", { name: "Allow Once", exact: true }).press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.calls.length === 1)
    const target = f.b.getByRole("textbox", { name: "Answer" })
    await target.fill("Other target draft")
    await target.focus()
    if (uncertain) await f.page.evaluate(kind => {
      (window as any).fixture.rotate("A")
      if (kind === "form") (window as any).fixture.ask("A", "Current request")
      else (window as any).fixture.permission("A")
      ;(window as any).fixture.release()
    }, kind)
    const feedback = f.a.locator(kind === "form" ? ".form-request-error" : ".tool-call-permission-error")
    await feedback.waitFor({ state: "attached" })
    assert.equal(await feedback.count(), 1)
    assert.equal(await feedback.getAttribute("role"), uncertain ? "status" : "alert")
    assert.equal(await feedback.getAttribute("aria-live"), uncertain ? "polite" : null)
    assert.equal(await target.evaluate(element => document.activeElement === element), true)
    assert.equal(await source.inputValue(), "Preserve source draft")
    assert.equal(await target.inputValue(), "Other target draft")
    assert.equal((await f.page.evaluate(() => (window as any).fixture.calls)).length, 1)
    assert.equal(await f.page.getByRole("dialog").count(), 0)
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.forbidden), [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("same-ID local/A/B forms have unique labels and exact human header scope, without pending IO", async () => {
  const f = await setup()
  try {
    assert.equal(await f.page.locator('input[id]').evaluateAll(elements => new Set(elements.map(element => element.id)).size === elements.length), true)
    for (const id of ["local-shared", "A", "B"]) {
      const article = f.page.locator(`[data-owner="${id}"]`)
      await article.getByRole("textbox", { name: "Answer" }).fill(`Synthetic ${id}`)
      await article.getByRole("textbox", { name: "Answer" }).press("Enter")
    }
    const calls = await f.page.evaluate(() => (window as any).fixture.calls)
    assert.deepEqual(calls.map((call: any) => call.id), ["local-shared", "A", "B"])
    assert.equal(calls[0].options.headers["x-codenomad-human-answer"], "1", "synthetic browser input only qualifies the UI hint, not human consent")
    assert.equal(calls[1].options.headers["x-codenomad-human-answer"], undefined)
    assert.equal(calls[2].options.headers["x-codenomad-human-answer"], undefined)
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.forbidden), [])
    assert.deepEqual(f.forbidden, [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("an old acknowledgement leaves the refreshed request, hidden source draft and another target's focus intact", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).fixture.hold())
    await f.input.fill("Source draft during send")
    await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.calls.length === 1)
    const other = f.b.getByRole("textbox", { name: "Answer" })
    await other.fill("Unchanged B draft")
    await other.focus()
    await f.page.evaluate(() => {
      (window as any).fixture.rotate("A")
      ;(window as any).fixture.ask("A", "New live request")
      ;(window as any).fixture.release()
    })
    await f.a.locator('.form-request-error').waitFor({ state: "attached" })
    assert.equal(await other.inputValue(), "Unchanged B draft")
    assert.equal(await other.evaluate(element => document.activeElement === element), true)
    assert.equal(await f.input.inputValue(), "Source draft during send")
    assert.equal((await f.page.evaluate(() => (window as any).fixture.snapshot())).find((item: any) => item.id === "A").forms, 1)
    assert.equal((await f.page.evaluate(() => (window as any).fixture.calls)).length, 1)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("a binding replacement keeps the stale editor draft and its exact source instead of relabelling it as the new target", async () => {
  const f = await setup()
  try {
    await f.input.fill("Original A draft")
    await f.input.focus()
    await f.input.evaluate(element => { (window as any).savedInput = element })
    await f.page.evaluate(() => (window as any).fixture.rebind("A"))
    assert.equal(await f.input.evaluate(element => element === (window as any).savedInput && document.activeElement === element), true)
    assert.equal(await f.input.inputValue(), "Original A draft")
    assert.equal(await f.a.locator('button[type="submit"]').isDisabled(), true)
    assert.equal(await f.a.locator('details bdi').first().textContent(), "A")
    assert.equal(await f.page.evaluate(() => (window as any).fixture.rawReply("A")), "refused")
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.calls), [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

for (const rtl of [false, true]) for (const theme of ["light", "dark"]) test(`320 CSS / DPR2 stale dock keyboard/aria geometry ${rtl ? "he-RTL" : "en"} ${theme}`, async () => {
  const f = await setup(rtl, theme)
  try {
    await f.page.evaluate(() => (window as any).fixture.disconnect("A"))
    await f.input.fill("Preserved narrow draft")
    await f.input.focus()
    const described = await f.a.locator('button[type="submit"]').getAttribute("aria-describedby")
    assert(described)
    assert.equal(await f.a.locator(`[id="${described}"]`).count(), 1)
    await f.a.locator("summary").focus()
    await f.page.keyboard.press("Enter")
    assert.equal(await f.a.locator("details").getAttribute("open"), "")
    await f.page.evaluate(() => (window as any).fixture.dismissNotices())
    await f.a.evaluate(article => article.scrollIntoView({ block: "start" }))
    const metrics = await f.a.evaluate(article => {
      const footer = article.querySelector('.window-footer')!.getBoundingClientRect()
      return { noOverflow: document.documentElement.scrollWidth <= innerWidth, left: footer.left, right: footer.right, top: footer.top, bottom: footer.bottom,
        width: innerWidth, height: innerHeight, dpr: devicePixelRatio, direction: getComputedStyle(article).direction,
        theme: document.documentElement.getAttribute("data-theme"), background: getComputedStyle(article.querySelector('.interruption-dock')!).backgroundColor }
    })
    assert.equal(metrics.noOverflow, true)
    assert(metrics.left >= 0 && metrics.right <= metrics.width)
    assert(metrics.top >= 0 && metrics.bottom <= metrics.height, "fixed reply footer stays reachable")
    assert.equal(metrics.dpr, 2)
    assert.equal(metrics.theme, theme)
    assert.equal(metrics.direction, rtl ? "rtl" : "ltr")
    const name = `${captures}/stale-${rtl ? "he" : "en"}-${theme}-${Date.now()}`
    await f.page.screenshot({ path: `${name}.png` })
    await writeFile(`${name}.json`, JSON.stringify(metrics, null, 2))
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.calls), [])
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
