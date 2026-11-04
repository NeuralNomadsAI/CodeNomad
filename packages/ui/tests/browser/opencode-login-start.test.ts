import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import type { LoginStartControl, LoginStartState } from "../../../server/src/api-types"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"
import { openCodeLoginStartMessages as en } from "../../src/lib/i18n/messages/en/opencode-login-start"

const locales = ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]
let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>> | undefined
async function closeEvents() {
  const owned = events
  events = undefined
  await owned?.close()
}
before(async () => {
  const fixture = await borrowFixture({ name: "opencode-login-start", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/opencode-login-start.tsx"></script></body></html>' }] })
  url = fixture.url
  let ready = false
  await runWithDiagnosticCleanup({ run: async () => {
    events = await fixtureEventStream(url)
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
    ready = true
  }, diagnose: async () => {}, cleanup: async () => {
    if (!ready) { try { await browser?.close() } finally { await closeEvents() } }
  }, onObservationError: () => console.error("login-start-startup-observation-failed"),
  onCleanupError: () => console.error("login-start-startup-cleanup-failed") })
})
after(async () => { try { await browser?.close() } finally { await closeEvents() } })

async function setup(page: Page, initial: LoginStartState = "off") {
  let state = initial, readFailure = false, writeFailure: { status: number; error: string } | undefined
  const writes: LoginStartControl[] = [], errors: string[] = []
  let reads = 0
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", async route => {
    const request = route.request(), parsed = new URL(request.url())
    if (parsed.pathname !== "/api/opencode/login-start") return route.fulfill({ json: {} })
    if (request.method() === "GET") {
      reads++
      return readFailure ? route.fulfill({ status: 500, json: { error: "login-start-failed" } }) : route.fulfill({ json: { state } })
    }
    const input = request.postDataJSON() as LoginStartControl
    writes.push(input)
    if (writeFailure) return route.fulfill({ status: writeFailure.status, json: { error: writeFailure.error } })
    state = input.enabled ? "on" : "off"
    return route.fulfill({ json: { state } })
  })
  await events!.route(page)
  return { writes, errors, reads: () => reads, state: (next: LoginStartState) => { state = next },
    readFailure: (value: boolean) => { readFailure = value }, writeFailure: (value?: { status: number; error: string }) => { writeFailure = value } }
}
const row = (page: Page) => page.locator("#opencode-login-start")
async function capture(page: Page, name: string) {
  const directory = process.env.CODENOMAD_LOGIN_START_CAPTURE
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await row(page).screenshot({ path: path.join(directory, `login-start-${name}.png`) })
}
const visibleText = async (page: Page) => (await row(page).innerText()).replace(/\s+/g, " ").trim()

test("off by default; the switch alone changes it; the row shows only its label", async () => {
  const page = await browser.newPage({ viewport: { width: 760, height: 400 } })
  const fixture = await setup(page)
  try {
    await page.goto(url)
    const toggle = page.getByRole("switch", { name: en["settings.loginStart.title"], exact: true })
    await page.waitForFunction(() => !(document.querySelector("#opencode-login-start input[role=switch]") as HTMLInputElement)?.disabled)
    assert.equal(await toggle.isChecked(), false)
    assert.equal(await visibleText(page), en["settings.loginStart.title"])
    assert.deepEqual(fixture.writes, [], "reading never installs")
    await capture(page, "en-off")
    await toggle.click()
    await page.waitForFunction(() => (document.querySelector("#opencode-login-start input[role=switch]") as HTMLInputElement)?.checked)
    await page.waitForFunction(() => !(document.querySelector("#opencode-login-start input[role=switch]") as HTMLInputElement)?.disabled)
    assert.equal(await visibleText(page), en["settings.loginStart.title"])
    await capture(page, "en-on")
    await toggle.click()
    await page.waitForFunction(() => !(document.querySelector("#opencode-login-start input[role=switch]") as HTMLInputElement)?.checked)
    assert.deepEqual(fixture.writes, [{ enabled: true }, { enabled: false }])
    await page.evaluate(() => (window as any).fixture.mount(false))
    await page.evaluate(() => (window as any).fixture.mount(true))
    await page.waitForFunction(() => !(document.querySelector("#opencode-login-start input[role=switch]") as HTMLInputElement)?.disabled)
    assert.equal(fixture.writes.length, 2, "remounting never changes the setting")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("the explanation is one sentence behind the info tip", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 500 } })
  await setup(page)
  try {
    await page.goto(url)
    const info = en["settings.loginStart.info"]
    assert.equal(await page.getByText(info).count(), 0)
    await page.keyboard.press("Tab")
    const tooltip = page.getByRole("tooltip")
    await tooltip.waitFor()
    assert.equal(await tooltip.innerText(), info)
  } finally { await page.close() }
})

test("a refused change shows an actionable error and the state the OS keeps", async () => {
  const page = await browser.newPage({ viewport: { width: 760, height: 400 } })
  const fixture = await setup(page)
  try {
    await page.goto(url)
    const toggle = page.getByRole("switch")
    await page.waitForFunction(() => !(document.querySelector("#opencode-login-start input[role=switch]") as HTMLInputElement)?.disabled)
    fixture.writeFailure({ status: 500, error: "login-start-failed" })
    await toggle.click()
    await page.getByRole("alert").getByText(en["settings.loginStart.error.failed"], { exact: true }).waitFor()
    assert.equal(await toggle.isChecked(), false)
    assert.equal(await page.getByRole("button", { name: en["settings.loginStart.retry"] }).count(), 0, "the switch itself retries a change")
    await capture(page, "en-error")
    fixture.writeFailure({ status: 422, error: "login-start-unsupported-binary" })
    await toggle.click()
    await page.getByRole("alert").getByText(en["settings.loginStart.error.unsupported-binary"], { exact: true }).waitFor()
    fixture.readFailure(true)
    await toggle.click()
    await page.getByRole("alert").getByText(en["settings.loginStart.error.read"], { exact: true }).waitFor()
    await page.getByRole("button", { name: en["settings.loginStart.retry"], exact: true }).waitFor()
    assert.equal(await page.getByText(en["settings.loginStart.error.unsupported-binary"]).count(), 0, "an unreadable state keeps its own error")
    fixture.readFailure(false)
    fixture.writeFailure()
    await page.getByRole("button", { name: en["settings.loginStart.retry"], exact: true }).click()
    await page.getByRole("alert").waitFor({ state: "detached" })
    await toggle.click()
    await page.waitForFunction(() => (document.querySelector("#opencode-login-start input[role=switch]") as HTMLInputElement)?.checked)
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.deepEqual(fixture.writes, [{ enabled: true }, { enabled: true }, { enabled: true }, { enabled: true }])
  } finally { await page.close() }
})

test("a failed read offers Try again; an unavailable system disables the switch", async () => {
  const page = await browser.newPage({ viewport: { width: 760, height: 400 } })
  const fixture = await setup(page)
  try {
    fixture.readFailure(true)
    await page.goto(url)
    await page.getByRole("alert").getByText(en["settings.loginStart.error.read"], { exact: true }).waitFor()
    assert.equal(await page.getByRole("switch").isDisabled(), true)
    fixture.readFailure(false)
    fixture.state("unavailable")
    await page.getByRole("button", { name: en["settings.loginStart.retry"], exact: true }).click()
    await page.getByText(en["settings.loginStart.unavailable"], { exact: true }).waitFor()
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.equal(await page.getByRole("switch").isDisabled(), true)
    fixture.state("on")
    await page.evaluate(() => (window as any).fixture.reconnect())
    await page.waitForFunction(() => (document.querySelector("#opencode-login-start input[role=switch]") as HTMLInputElement)?.checked)
    assert.deepEqual(fixture.writes, [])
  } finally { await page.close() }
})

test("every locale names the row, keeps the tip to one sentence and leaks no key", async () => {
  for (const locale of locales) {
    const { openCodeLoginStartMessages: messages } = await import(`../../src/lib/i18n/messages/${locale}/opencode-login-start.ts`)
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort(), locale)
    const sentences = (messages["settings.loginStart.info"] as string).split(/[.!?。।]/).filter(part => part.trim()).length
    assert.equal(sentences, 1, `${locale} tip is one sentence`)
    const page = await browser.newPage({ viewport: { width: 760, height: 400 } })
    const fixture = await setup(page)
    try {
      await page.goto(`${url}?locale=${locale}`)
      await page.getByRole("switch", { name: messages["settings.loginStart.title"], exact: true }).waitFor()
      await page.waitForFunction(() => !(document.querySelector("#opencode-login-start input[role=switch]") as HTMLInputElement)?.disabled)
      assert.equal(await visibleText(page), messages["settings.loginStart.title"])
      if (locale === "fr") {
        await capture(page, "fr-off")
        await page.getByRole("switch").click()
        await page.waitForFunction(() => (document.querySelector("#opencode-login-start input[role=switch]") as HTMLInputElement)?.checked)
        await page.waitForFunction(() => !(document.querySelector("#opencode-login-start input[role=switch]") as HTMLInputElement)?.disabled)
        await capture(page, "fr-on")
        fixture.writeFailure({ status: 500, error: "login-start-failed" })
        await page.getByRole("switch").click()
        await page.getByRole("alert").getByText(messages["settings.loginStart.error.failed"], { exact: true }).waitFor()
        await capture(page, "fr-error")
      }
      assert.equal((await page.locator("main").innerText()).includes("settings.loginStart."), false)
    } finally { await page.close() }
  }
})
