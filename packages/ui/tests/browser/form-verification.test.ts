import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
const captures = fileURLToPath(new URL("../../../../.tmp/s12-form-verification/captures/", import.meta.url))
before(async () => {
  ;({ url } = await borrowFixture({ name: "form-verification", routes: [{ path: "/verify", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/multiserver-interruptions.tsx"></script></body></html>' }] }))
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  await mkdir(captures, { recursive: true })
})
after(async () => { await browser?.close() })
async function setup(rtl = false, theme = "light") {
  const page = await browser.newPage({ viewport: { width: 320, height: 900 }, deviceScaleFactor: 2 })
  const errors: string[] = [], forbidden: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/storage/config/server") return route.fulfill({ json: { opencodeServers: ["A", "B"].map(id => ({ id, kind: "explicit", label: "Same server" })) } })
    if (/pending-requests|permission-receipts|\/rpc\/|\/permission\/|\/form\//.test(path)) forbidden.push(path)
    return route.fulfill({ json: {} })
  })
  await page.goto(`${url}?verification=1${rtl ? "&rtl=1" : ""}`)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  await page.evaluate(theme => (window as any).fixture.theme(theme), theme)
  await page.waitForFunction(theme => document.documentElement.getAttribute("data-theme") === theme, theme)
  const a = page.locator('[data-owner="A"]'), b = page.locator('[data-owner="B"]')
  await page.evaluate(() => { (window as any).fixture.disconnect("A"); (window as any).fixture.reconnect("A"); (window as any).fixture.disconnect("B"); (window as any).fixture.reconnect("B"); (window as any).fixture.dismissNotices() })
  const input = a.getByRole("textbox", { name: "Answer" }), check = a.locator("button[aria-busy]")
  return { page, a, b, input, check, errors, forbidden }
}
test("one explicit check admits only its Form; editable draft, caret/DOM, separate manual reply and no discovery", async () => {
  const f = await setup()
  try {
    await f.input.fill("Keep original draft")
    await f.input.evaluate(element => { (window as any).savedInput = element; (element as HTMLInputElement).setSelectionRange(2, 7) })
    await f.page.evaluate(() => (window as any).fixture.readHold())
    await f.check.press("Enter")
    assert.equal(await f.check.getAttribute("aria-busy"), "true")
    assert.equal(await f.check.isDisabled(), true)
    assert.equal(await f.input.isEnabled(), true)
    await f.input.fill("Editable during check")
    await f.input.focus()
    await f.input.evaluate(element => (element as HTMLInputElement).setSelectionRange(2, 7))
    await f.page.evaluate(() => (window as any).fixture.readRelease())
    await f.page.waitForFunction(() => !(document.querySelector('[data-owner="A"] button[type="submit"]') as HTMLButtonElement).disabled)
    assert.equal(await f.input.evaluate(element => element === (window as any).savedInput && document.activeElement === element && (element as HTMLInputElement).selectionStart === 2 && (element as HTMLInputElement).selectionEnd === 7), true)
    assert.equal(await f.input.inputValue(), "Editable during check")
    assert.equal(await f.b.locator('button[type="submit"]').isDisabled(), true)
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.calls.map((call: any) => [call.id, call.method])), [["A", "get"]])
    await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.calls.length === 2)
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.calls.map((call: any) => [call.id, call.method])), [["A", "get"], ["A", "reply"]])
    assert.deepEqual(f.errors, []); assert.deepEqual(f.forbidden, [])
  } finally { await f.page.close() }
})
for (const state of ["answered", "cancelled", "indeterminate"]) test(`${state} is one polite neutral result, keeps editable draft and other-target focus; retry is explicit`, async () => {
  const f = await setup()
  try {
    await f.input.fill("Retained source draft")
    await f.page.evaluate(state => { (window as any).fixture.readHold(); if (state === "indeterminate") (window as any).fixture.readFail(true); else (window as any).fixture.readStatus(state) }, state)
    await f.check.press("Enter")
    const target = f.b.getByRole("textbox", { name: "Answer" })
    await target.fill("B focus"); await target.focus()
    await f.page.evaluate(() => (window as any).fixture.readRelease())
    await f.page.waitForFunction(() => document.querySelector('[data-owner="A"] button[aria-busy]')?.getAttribute("aria-busy") === "false")
    assert.equal(await target.evaluate(element => document.activeElement === element), true)
    assert.equal(await f.input.inputValue(), "Retained source draft")
    assert.equal(await f.input.isEnabled(), true)
    assert.equal(await f.a.locator('button[type="submit"]').isDisabled(), true)
    assert.equal(await f.a.locator('p[role="status"][aria-live="polite"]').count(), 1)
    assert.equal(await f.a.locator('[role="alert"]').count(), 0)
    assert.equal(await f.page.getByRole("dialog").count(), 0)
    assert(!await f.page.locator("body").innerText().then(text => text.includes("PRIVATE-SENTINEL")))
    assert.equal((await f.page.evaluate(() => (window as any).fixture.snapshot())).find((item: any) => item.id === "A").forms, 1)
    assert.equal(await f.page.evaluate(() => (window as any).fixture.calls.length), 1)
    await f.page.evaluate(() => { (window as any).fixture.readFail(false); (window as any).fixture.readStatus("pending") })
    await f.check.press("Enter")
    await f.page.waitForFunction(() => !(document.querySelector('[data-owner="A"] button[type="submit"]') as HTMLButtonElement).disabled)
    assert.equal(await f.page.evaluate(() => (window as any).fixture.calls.length), 2)
    assert.deepEqual(f.errors, []); assert.deepEqual(f.forbidden, [])
  } finally { await f.page.close() }
})
test("new same-payload native event supersedes an older GET and permissions expose no check", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => { (window as any).fixture.readHold(); (window as any).fixture.readStatus("answered") })
    await f.check.press("Enter")
    await f.page.evaluate(() => { (window as any).fixture.ask("A"); (window as any).fixture.readRelease() })
    await f.page.waitForFunction(() => !(document.querySelector('[data-owner="A"] button[type="submit"]') as HTMLButtonElement).disabled)
    assert.equal(await f.a.locator("button[aria-busy]").count(), 0)
    await f.page.evaluate(() => (window as any).fixture.permission("B"))
    await f.b.getByRole("button", { name: "Previous request", exact: true }).press("Enter")
    assert.equal(await f.b.locator('.interruption-editor:visible button[aria-busy]').count(), 0)
    assert.equal(await f.page.evaluate(() => (window as any).fixture.calls.length), 1)
    assert.deepEqual(f.errors, []); assert.deepEqual(f.forbidden, [])
  } finally { await f.page.close() }
})
for (const rtl of [false, true]) for (const theme of ["light", "dark"]) test(`320 CSS DPR2 explicit check keyboard/status/fieldset ${rtl ? "he" : "en"} ${theme}`, async () => {
  const f = await setup(rtl, theme)
  try {
    await f.input.fill("Retained narrow draft")
    await f.a.scrollIntoViewIfNeeded()
    await f.page.screenshot({ path: `${captures}/check-${rtl ? "he" : "en"}-${theme}.png` })
    await f.a.locator("summary").press("Enter")
    await f.a.scrollIntoViewIfNeeded()
    await f.check.focus(); await f.page.keyboard.press("Tab")
    assert.equal(await f.input.evaluate(element => document.activeElement === element), false, "native tab follows the disclosure control")
    await f.check.press("Enter")
    await f.page.waitForFunction(() => !(document.querySelector('[data-owner="A"] button[type="submit"]') as HTMLButtonElement).disabled)
    await f.a.scrollIntoViewIfNeeded()
    const metrics = await f.a.evaluate(article => {
      const footer = article.querySelector(".window-footer")!.getBoundingClientRect(), status = article.querySelector('p[role="status"]')!.getBoundingClientRect()
      return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, direction: getComputedStyle(article).direction,
        overflow: document.documentElement.scrollWidth > innerWidth, footer: { left: footer.left, right: footer.right, top: footer.top, bottom: footer.bottom },
        status: { left: status.left, right: status.right }, fieldsetDisabled: (article.querySelector("fieldset") as HTMLFieldSetElement).disabled }
    })
    assert.equal(metrics.overflow, false); assert.equal(metrics.dpr, 2); assert.equal(metrics.fieldsetDisabled, false)
    assert(metrics.footer.left >= 0 && metrics.footer.right <= metrics.width && metrics.footer.top >= 0 && metrics.footer.bottom <= metrics.height)
    assert.equal(metrics.direction, rtl ? "rtl" : "ltr")
    const name = `${captures}/verified-${rtl ? "he" : "en"}-${theme}`
    await f.page.screenshot({ path: name + ".png" }); await writeFile(name + ".json", JSON.stringify(metrics, null, 2))
    await f.input.focus()
    await f.input.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    const focus = await f.input.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return { focused: document.activeElement === element, top: bounds.top, bottom: bounds.bottom, height: innerHeight,
        draft: (element as HTMLInputElement).value, disabled: (element.closest("fieldset") as HTMLFieldSetElement).disabled }
    })
    assert.equal(focus.focused, true); assert.equal(focus.disabled, false); assert.equal(focus.draft, "Retained narrow draft")
    assert(focus.top >= 0 && focus.bottom <= focus.height)
    await f.page.screenshot({ path: name + "-focus.png" }); await writeFile(name + "-focus.json", JSON.stringify(focus, null, 2))
    assert.deepEqual(f.errors, []); assert.deepEqual(f.forbidden, [])
  } finally { await f.page.close() }
})
