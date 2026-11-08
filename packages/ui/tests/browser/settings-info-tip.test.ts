import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string, events: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({ name: "settings-info-tip", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/settings-info-tip.tsx"></script></body></html>' }] })
  url = fixture.url
  events = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await events?.close() } })

async function setup(page: Page, host = "web", context = "remote") {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `
    const w = window
    const host = ${JSON.stringify(host)}, context = ${JSON.stringify(context)}
    w.__CODENOMAD_RUNTIME_HOST__ = host
    w.__CODENOMAD_WINDOW_CONTEXT__ = context
    w.opened = []
    w.attempts = 0
    w.failOpen = false
    window.open = (...args) => { w.attempts++; if (w.failOpen) throw new Error("opener failure"); w.opened.push(args); return null }
    w.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === "open_external_url") {
        w.attempts++
        if (w.failOpen) throw new Error("opener failure")
        w.opened.push([command, args])
      }
    } }
  ` })
  await page.route("**/api/**", route => route.fulfill({ json: new URL(route.request().url()).pathname === "/api/opencode/login-start" ? { state: "off" } : {} }))
  await events.route(page)
  await page.goto(url)
  await page.locator(".settings-choice-row [role=link]").waitFor()
  return errors
}
async function opened(page: Page) {
  return page.evaluate(() => (window as any).opened.map((entry: any[]) => entry[0] === "open_external_url" ? entry[1].url : entry[0]))
}
const base = "https://neuralnomadsai.github.io/CodeNomad/"

for (const [host, context] of [["web", "remote"], ["electron", "local"], ["tauri", "local"], ["tauri", "preferences"], ["tauri", "remote"]]) {
  test(`${host}/${context}: hover, focus and link activation keep labels, disclosures and renderer intact`, async () => {
    const page = await browser.newPage({ viewport: { width: 820, height: 800 } })
    const errors = await setup(page, host, context)
    try {
      const tip = page.locator(".settings-choice-row [role=link]")
      await tip.hover()
      await page.getByRole("tooltip").waitFor()
      assert.equal(await page.getByRole("tooltip").innerText(), await tip.getAttribute("aria-label"))
      await tip.click()
      await tip.focus()
      await page.keyboard.press("Enter")
      await page.waitForFunction(() => (window as any).opened.length === 2)
      assert.deepEqual(await opened(page), [0, 1].map(() => `${base}en/settings.html#keep-computer-awake`))
      assert.equal(await page.locator(".settings-choice-row input").isChecked(), false)
      assert.deepEqual(await page.evaluate(() => [(window as any).fixture.changed(), (window as any).fixture.leaked()]), [0, 0])
      await page.locator("summary [role=link]").click()
      assert.equal(await page.locator("details").getAttribute("open"), null)
      assert.equal((await opened(page)).at(-1), `${base}en/opencode.html#session-environment`)
      assert.equal(page.url(), url)
      assert.equal(await page.getByRole("dialog").count(), 0, "noopener null is success")
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("touch opens help once and preserves tooltip-only tap behavior inside a label", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true })
  const errors = await setup(page)
  try {
    await page.locator(".settings-choice-row [role=link]").tap()
    assert.deepEqual(await opened(page), [`${base}en/settings.html#keep-computer-awake`])
    assert.equal(await page.locator(".settings-choice-row input").isChecked(), false)
    const diagnostic = page.locator("[data-only-tip] [role=img]")
    await diagnostic.tap()
    await page.getByRole("tooltip").waitFor()
    assert.equal(await page.getByRole("tooltip").innerText(), "Live diagnostic explanation")
    await diagnostic.tap()
    await page.getByRole("tooltip").waitFor({ state: "hidden" })
    assert.equal(await page.locator("[data-only-tip] input").isChecked(), false)
    assert.equal((await opened(page)).length, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("live locales including zh-Hans select real help sections; failed open shows a localized alert without replay", async () => {
  const page = await browser.newPage({ viewport: { width: 820, height: 800 } })
  const errors = await setup(page, "tauri", "local")
  try {
    for (const locale of ["fr", "zh-Hans", "he"]) {
      await page.evaluate(locale => (window as any).fixture.locale(locale), locale)
      await page.waitForFunction(locale => document.documentElement.lang === locale, locale)
      await page.locator("#opencode-login-start [role=link]").click()
      await page.waitForFunction(count => (window as any).opened.length === count, ["fr", "zh-Hans", "he"].indexOf(locale) + 1)
      assert.equal((await opened(page)).at(-1), `${base}${locale}/opencode.html#login-start`)
    }
    await page.evaluate(() => { (window as any).failOpen = true })
    await page.locator("#opencode-login-start [role=link]").click()
    const dialog = page.getByRole("dialog")
    await dialog.waitFor()
    assert.ok((await dialog.innerText()).includes("פתיחת עזרה"))
    assert.equal(await page.evaluate(() => (window as any).attempts), 4)
    assert.equal((await opened(page)).length, 3)
    await page.keyboard.press("Escape")
    assert.equal(await page.locator("#opencode-login-start input").isChecked(), false)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("core Status info icons link to their specific help; capture the real components", async () => {
  const page = await browser.newPage({ viewport: { width: 820, height: 800 } })
  const errors = await setup(page)
  try {
    const links = page.locator("[data-status-tips] [role=link]")
    for (const link of await links.all()) await link.click()
    assert.deepEqual(await opened(page), ["providers.html#usage", "permissions.html#yolo-mode", "providers.html#usage", "index.html#monitor-work", "integrations.html#mcp", "integrations.html#plugins"].map(path => `${base}en/${path}`))
    if (process.env.CODENOMAD_HELP_CAPTURE) {
      await mkdir(process.env.CODENOMAD_HELP_CAPTURE, { recursive: true })
      await page.locator("#opencode-login-start [role=link]").hover()
      await page.getByRole("tooltip").waitFor()
      await page.screenshot({ path: path.join(process.env.CODENOMAD_HELP_CAPTURE, "contextual-help.png") })
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
