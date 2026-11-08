import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
const longPath = `/srv/${"very-long-folder/".repeat(24)}project`
before(async () => {
  const fixture = await borrowFixture({ name: "remote-server-ux", routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/remote-server-ux.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function prepare(page: Page, locale: string, error?: string) {
  let state: Record<string, unknown> = {}
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/state/ui")) {
      if (route.request().method() === "PATCH") state = { ...state, ...route.request().postDataJSON() }
      return route.fulfill({ json: state })
    }
    if (path.endsWith("/connect")) return route.fulfill({ status: 409, json: { error } })
    if (path.endsWith("/browse")) return route.fulfill(error
      ? { status: 409, json: { error } }
      : { json: { listing: { metadata: { currentPath: longPath, displayPath: longPath, pathKind: "absolute" }, entries: [{ name: "app", path: `${longPath}/app` }] }, recents: [{ path: longPath, projectName: "Recent project" }] } })
    if (path.endsWith("/probe")) return route.fulfill({ json: error?.startsWith("pairing_")
      ? { ok: true, normalizedUrl: "https://box.opentunnel.xyz", skipTlsVerify: false }
      : { ok: false, error: "English technical diagnostic", errorCode: error ?? "unreachable" } })
    return route.fulfill({ json: path.endsWith("/config/ui") ? { settings: { locale } } : {} })
  })
}

for (const [locale, separateWindow, offline, tls] of [
  ["fr", "Ouvrir dans une fenêtre séparée", "Serveur inaccessible.", "Échec de la vérification du certificat."],
  ["de", "In separatem Fenster öffnen", "Server nicht erreichbar.", "Zertifikatsprüfung fehlgeschlagen."],
]) {
  test(`${locale}: the editable path opens a folder; folder rows only navigate; a long path fits 480px`, async () => {
    const page = await browser.newPage({ viewport: { width: 480, height: 800 } })
    try {
      await prepare(page, locale)
      await page.goto(url)
      await page.getByRole("button", { name: "app", exact: true }).waitFor()
      assert.match(await page.locator(".remote-server-navigation").innerText(), /Box/)
      const field = page.locator(".remote-server-path input")
      assert.equal(await field.inputValue(), longPath)
      // Recent projects live in the Recent tabs column, never inside the folder browser.
      assert.equal(await page.getByText("Recent project").count(), 0)
      assert.equal(await page.locator(".remote-server-path .settings-info-tip").count(), 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.getByRole("button", { name: "app", exact: true }).click()
      assert.equal(await page.locator("output").innerText(), "")
      await field.fill("/srv/typed")
      await field.press("Enter")
      assert.equal(await page.locator("output").innerText(), "/srv/typed")
      await field.fill(longPath)
      // This web fixture cannot embed remote tabs, so the arrow names the separate window it opens.
      const arrow = page.locator(".remote-server-path").getByRole("button")
      assert.equal(await arrow.getAttribute("aria-label"), separateWindow)
      await arrow.click()
      assert.equal(await page.locator("output").innerText(), longPath)
    } finally { await page.close() }
  })
  for (const [code, message] of [["tls_error", tls], ["unreachable", offline]]) test(`${locale}: ${code} is short and localized with opt-in diagnostics`, async () => {
    const page = await browser.newPage()
    try {
      await prepare(page, locale, code)
      await page.goto(`${url}?add`)
      await page.locator("[data-server-add-field]").fill("https://box.example")
      await page.locator("[data-server-add-field]").press("Enter")
      await page.getByRole("alert").getByText(message, { exact: true }).waitFor()
      assert.equal(await page.getByRole("tooltip").count(), 0)
      await page.locator(".server-add-field-error .settings-info-tip").focus()
      await page.getByRole("tooltip").getByText("English technical diagnostic", { exact: true }).waitFor()
    } finally { await page.close() }
  })
}

test("password form names its server and labels; a tunnel offers targeted pairing instead", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page, "en", "needs_credentials")
    await page.goto(url)
    await page.locator('input[type="password"]').waitFor()
    assert.match(await page.locator(".remote-server-navigation").innerText(), /Box/)
    assert.equal(await page.locator(".remote-server-label").count(), 2)
    await page.goto(`${url}?tunnel`)
    await page.getByRole("textbox", { name: "New pairing link" }).waitFor()
    assert.equal(await page.locator('input[type="password"]').count(), 0)
    assert.match(await page.getByRole("alert").innerText(), /Box.*paste a new pairing link/)
  } finally { await page.close() }
})

test("a refused pairing names the saved server and clears the one-use link", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page, "en", "pairing_expired")
    await page.goto(`${url}?add`)
    const field = page.locator("[data-server-add-field]")
    await field.fill(`https://box.opentunnel.xyz/remote-pair#${"x".repeat(32)}`)
    await field.press("Enter")
    await page.getByRole("alert").getByText("Pairing link invalid or expired.", { exact: true }).waitFor()
    assert.match(await page.getByRole("alert").innerText(), /box.opentunnel.xyz/)
    assert.equal(await field.inputValue(), "")
  } finally { await page.close() }
})

test("edit dialog keeps URL help and certificate consequences behind keyboard-openable info", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page, "en")
    await page.goto(`${url}?dialog`)
    const dialog = page.getByRole("dialog")
    await dialog.waitFor()
    assert.equal(await dialog.locator(".window-header").count(), 1)
    assert.equal(await dialog.locator(".window-footer").count(), 1)
    assert.equal(await dialog.locator(".settings-info-tip").count(), 2)
    assert.equal(await page.getByRole("tooltip").count(), 0)
    await dialog.locator(".settings-info-tip").first().focus()
    await page.locator('[role="tooltip"]').getByText("A server address, or a Remote Control pairing link created on that computer.", { exact: true }).waitFor()
  } finally { await page.close() }
})

test("edit validation keeps missing URL actionable before submitting", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page, "en")
    await page.goto(`${url}?dialog`)
    await page.getByRole("textbox", { name: "URL", exact: true }).fill("")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByRole("alert").getByText("Server URL is required.", { exact: true }).waitFor()
    assert.equal(await page.getByRole("alert").getByText("Server unreachable.").count(), 0)
  } finally { await page.close() }
})

for (const credentials of [false, true]) test(`delayed ${credentials ? "authentication" : "folder"} response respects focus moved to another surface`, async () => {
  const page = await browser.newPage()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await prepare(page, "en")
    await page.route("**/api/remote-servers/box/browse", async route => {
      await held
      await route.fulfill(credentials ? { status: 409, json: { error: "needs_credentials" } }
        : { json: { listing: { metadata: { currentPath: "/", displayPath: "/", pathKind: "absolute" }, entries: [{ name: "app", path: "/app" }] }, recents: [] } })
    })
    const request = page.waitForRequest("**/api/remote-servers/box/browse")
    await page.goto(url)
    await request
    const other = page.getByRole("textbox", { name: "Other surface", exact: true })
    await other.focus()
    release()
    await (credentials ? page.locator('input[type="password"]') : page.getByRole("button", { name: "app", exact: true })).waitFor()
    assert.equal(await other.evaluate(input => input === document.activeElement), true)
  } finally { release(); await page.close() }
})

for (const moved of [false, true]) test(`failed password submission ${moved ? "preserves another control's focus" : "returns focus to the password"}`, async () => {
  const page = await browser.newPage()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await prepare(page, "en", "needs_credentials")
    await page.route("**/api/remote-servers/box/connect", async route => { await held; await route.fulfill({ status: 409, json: { error: "auth" } }) })
    await page.goto(url)
    const password = page.locator('input[type="password"]')
    await password.fill("wrong-password")
    const request = page.waitForRequest("**/api/remote-servers/box/connect")
    await password.press("Enter")
    await request
    const other = page.getByRole("textbox", { name: "Other surface", exact: true })
    if (moved) await other.focus()
    release()
    await page.getByRole("alert").getByText("The username or password is incorrect.", { exact: true }).waitFor()
    const expected = moved ? other : password
    await expected.evaluate(input => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    assert.equal(await expected.evaluate(input => input === document.activeElement), true)
  } finally { release(); await page.close() }
})

test("pairing completion preserves focus moved during its exchange", async () => {
  const page = await browser.newPage()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await prepare(page, "en", "needs_credentials")
    await page.route("**/api/remote-servers/probe", route => route.fulfill({ json: { ok: true, normalizedUrl: "https://box.opentunnel.xyz", skipTlsVerify: false } }))
    await page.route("**/api/remote-servers/*/connect", async route => { await held; await route.fulfill({ json: { ok: true } }) })
    await page.goto(`${url}?tunnel`)
    const field = page.getByRole("textbox", { name: "New pairing link", exact: true })
    await field.fill(`https://box.opentunnel.xyz/remote-pair#${"x".repeat(32)}`)
    const request = page.waitForRequest("**/api/remote-servers/*/connect")
    await field.press("Enter")
    await request
    const other = page.getByRole("textbox", { name: "Other surface", exact: true })
    await other.focus()
    const browse = page.waitForResponse("**/api/remote-servers/box/browse")
    release()
    await browse
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    assert.equal(await other.evaluate(input => input === document.activeElement), true)
  } finally { release(); await page.close() }
})
