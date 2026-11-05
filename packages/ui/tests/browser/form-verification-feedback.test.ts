import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
const captures = fileURLToPath(new URL("../../../../.tmp/s12-form-fix/captures/", import.meta.url))
before(async () => {
  ;({ url } = await borrowFixture({ name: "form-verification-feedback", routes: [{ path: "/source", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/multiserver-interruptions.tsx"></script></body></html>' }] }))
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  await mkdir(captures, { recursive: true })
})
after(async () => { await browser?.close() })
async function checkSdkReads(page: import("playwright").Page) {
  const attempts: string[] = await page.evaluate(() => (window as any).fixture.forbidden.slice())
  // The strict synthetic client records SDK bootstrap attempts (session page,
  // project catalogue and default model included) before rejecting their mock
  // response. Naming these attempts here grants no upstream proxy capability.
  // Interruption/history/admin readers remain outside this closed list.
  const bootstrap = /\/api\/(?:session(?:\/(?:active|same-session(?:\/inbox)?))?|agent|command|model(?:\/default)?|project|provider|location|reference|skill|mcp|websearch\/provider)$/
  const forbidden = attempts.filter(path => !bootstrap.test(path))
  assert.deepEqual(forbidden, [])
  return { bootstrap: attempts.filter(path => bootstrap.test(path)), forbidden }
}
async function setup(rtl = false, theme = "light") {
  const page = await browser.newPage({ viewport: { width: 320, height: 900 }, deviceScaleFactor: 2 })
  const errors: string[] = [], forbidden: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue()
    forbidden.push("external network"); return route.abort()
  })
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (/pending-requests|permission-receipts|\/rpc\/|\/permission\/|\/form\//.test(path)) forbidden.push(path)
    return route.fulfill({ json: {} })
  })
  await page.goto(`${url}?verification=1${rtl ? "&rtl=1" : ""}`)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  await page.evaluate(theme => (window as any).fixture.theme(theme), theme)
  await page.waitForFunction(theme => document.documentElement.getAttribute("data-theme") === theme, theme)
  const a = page.locator('[data-owner="A"]'), b = page.locator('[data-owner="B"]')
  return { page, a, b, input: a.getByRole("textbox", { name: "Answer" }), check: a.locator("button[aria-busy]"), errors, forbidden }
}
for (const state of ["pending", "answered", "cancelled", "indeterminate"]) test(`keyboard check retains useful source focus through ${state}, with no repeat dispatch`, async () => {
  const f = await setup()
  try {
    await f.page.evaluate(state => {
      (window as any).fixture.disconnect("A"); (window as any).fixture.reconnect("A"); (window as any).fixture.dismissNotices()
      ;(window as any).fixture.readHold(); (window as any).fixture.readStatus(state); (window as any).fixture.readFail(state === "indeterminate")
    }, state)
    await f.input.fill("Keyboard source draft")
    await f.input.evaluate(element => { (window as any).savedInput = element; (element as HTMLInputElement).setSelectionRange(2, 7) })
    await f.check.focus(); await f.check.press("Enter")
    assert.equal(await f.check.evaluate(element => document.activeElement === element), true)
    assert.equal(await f.check.getAttribute("aria-disabled"), "true")
    await f.check.press("Enter") // aria-disabled stays focusable but its action is guarded.
    assert.equal(await f.page.evaluate(() => (window as any).fixture.calls.length), 1)
    await f.page.evaluate(() => (window as any).fixture.readRelease())
    await f.page.waitForFunction(() => document.querySelector('[data-owner="A"] button[aria-busy]')?.getAttribute("aria-busy") === "false")
    assert.equal(await f.check.evaluate(element => document.activeElement === element), true)
    assert.equal(await f.input.evaluate(element => element === (window as any).savedInput && (element as HTMLInputElement).selectionStart === 2 && (element as HTMLInputElement).selectionEnd === 7), true)
    assert.equal(await f.input.inputValue(), "Keyboard source draft")
    assert.equal(await f.input.isEnabled(), true)
    assert.equal(await f.a.locator('button[type="submit"]').isDisabled(), state !== "pending")
    assert.equal(await f.a.locator('[role="status"][aria-live="polite"]').count(), 1)
    if (state === "pending") { await f.check.press("Enter"); assert.equal(await f.page.evaluate(() => (window as any).fixture.calls.length), 1) }
    await f.a.scrollIntoViewIfNeeded(); await f.page.screenshot({ path: `${captures}/keyboard-${state}.png` })
    await checkSdkReads(f.page)
    assert.deepEqual(f.errors, []); assert.deepEqual(f.forbidden, [])
  } finally { await f.page.close() }
})
for (const rtl of [false, true]) for (const theme of ["light", "dark"]) test(`uncertainty and verification compose once, preserve B focus, ${rtl ? "he" : "en"} ${theme}`, async () => {
  const f = await setup(rtl, theme)
  try {
    await f.input.fill("Retained ambiguous draft")
    await f.page.evaluate(() => (window as any).fixture.hold()); await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.calls.length === 1)
    await f.page.evaluate(() => { (window as any).fixture.rotate("A"); (window as any).fixture.ask("A"); (window as any).fixture.release() })
    const feedback = f.a.locator('.form-request-error[role="status"]')
    await feedback.waitFor({ state: "attached" })
    const uncertain = (await feedback.textContent())!.trim()
    assert(uncertain.length > 40)
    await f.page.evaluate(() => { (window as any).fixture.disconnect("A"); (window as any).fixture.reconnect("A"); (window as any).fixture.dismissNotices(); (window as any).fixture.readHold() })
    assert((await feedback.textContent())!.includes(uncertain), "uncertainty remains explicit before the check")
    await f.check.press("Enter")
    const other = f.b.getByRole("textbox", { name: "Answer" })
    await other.fill("B owns focus"); await other.focus()
    await f.page.evaluate(() => (window as any).fixture.readRelease())
    await f.page.waitForFunction(() => !(document.querySelector('[data-owner="A"] button[type="submit"]') as HTMLButtonElement).disabled)
    const statuses = await f.a.locator('[role="status"][aria-live="polite"]').allTextContents()
    assert.equal(statuses.length, 1)
    assert(statuses[0].includes(uncertain), "pending does not erase or resolve the earlier uncertain attempt")
    assert.equal(await other.evaluate(element => document.activeElement === element), true)
    assert.equal(await f.input.inputValue(), "Retained ambiguous draft")
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.calls.map((call: any) => [call.id, call.method])), [["A", "reply"], ["A", "get"]])
    assert.equal(await f.a.locator('[role="alert"]').count(), 0)
    const name = `${captures}/composed-${rtl ? "he" : "en"}-${theme}`
    await f.b.scrollIntoViewIfNeeded()
    await f.page.screenshot({ path: name + "-source-B.png" })
    await f.a.scrollIntoViewIfNeeded()
    const metrics = await f.a.evaluate(article => {
      const rect = article.querySelector(".window-footer")!.getBoundingClientRect()
      return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, overflow: document.documentElement.scrollWidth > innerWidth,
        footer: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }
    })
    assert.equal(metrics.dpr, 2); assert.equal(metrics.overflow, false)
    assert(metrics.footer.left >= 0 && metrics.footer.right <= metrics.width && metrics.footer.top >= 0 && metrics.footer.bottom <= metrics.height)
    await f.page.screenshot({ path: name + ".png" }); await writeFile(name + ".json", JSON.stringify({ statuses, uncertain, metrics, sdkReads: await checkSdkReads(f.page), focusOwner: await other.evaluate(element => element === document.activeElement ? "B" : "other") }, null, 2))
    assert.deepEqual(f.errors, []); assert.deepEqual(f.forbidden, [])
  } finally { await f.page.close() }
})

for (const replacement of ["native-event", "close-reuse"]) test(`late old check after ${replacement} never takes B focus or publishes into the current editor`, async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => {
      (window as any).fixture.disconnect("A"); (window as any).fixture.reconnect("A"); (window as any).fixture.dismissNotices()
      ;(window as any).fixture.readStatus("answered"); (window as any).fixture.readHold()
    })
    await f.input.fill("Retained old source draft")
    await f.check.press("Enter")
    const other = f.b.getByRole("textbox", { name: "Answer" })
    await other.fill("B keeps focus"); await other.focus()
    if (replacement === "close-reuse") await f.page.evaluate(async () => {
      const state = await import("/src/stores/instances.ts" as string)
      const session = await import("/src/stores/session-state.ts" as string)
      const { sdkManager } = await import("/src/lib/sdk-manager.ts" as string)
      const { serverEvents } = await import("/src/lib/server-events.ts" as string)
      const saved = state.instances().get("A"), rows = session.sessions().get("A")
      state.removeInstance("A", { authoritative: false })
      session.setSessions(previous => { const next = new Map(previous); next.delete("A"); return next })
      sdkManager["clients"].set("A:/workspaces/A/instance", saved.client)
      state.addInstance(saved, serverEvents.captureTransportAuthority())
      session.setSessions(previous => new Map(previous).set("A", new Map(rows)))
    })
    await f.page.evaluate(() => {
      (window as any).fixture.reconnect("A"); (window as any).fixture.ask("A"); (window as any).fixture.dismissNotices(); (window as any).fixture.readRelease()
    })
    await f.page.waitForFunction(() => !(document.querySelector('[data-owner="A"] button[type="submit"]') as HTMLButtonElement).disabled)
    assert.equal(await other.evaluate(element => document.activeElement === element), true)
    assert.equal(await other.inputValue(), "B keeps focus")
    assert.equal(await f.a.locator('button[aria-busy]').count(), 0, "new native admission owns the editor, not the old GET result")
    assert.equal(await f.page.evaluate(() => (window as any).fixture.calls.length), 1)
    assert.equal(await f.a.locator('[role="status"][aria-live="polite"]').count(), 0)
    await checkSdkReads(f.page)
    assert.deepEqual(f.errors, []); assert.deepEqual(f.forbidden, [])
  } finally { await f.page.close() }
})
