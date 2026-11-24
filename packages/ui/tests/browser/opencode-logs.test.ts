import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "opencode-logs", routes: [{ path: "/settings", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/opencode-setup.tsx"></script></body></html>' }] })
  url = fixture.url + "?settings"
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})

test("deferred logs cannot publish after closing or changing executable", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  const held: (() => Promise<void>)[] = []
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname === "/api/opencode/logs") {
      held.push(() => route.fulfill({ json: { path: "/old", text: "OLD_LATE", truncated: false } }).catch(() => {}))
      return
    }
    return route.fulfill({ json: { state: "ready", serviceState: "ready", binaryPath: "opencode" } })
  })
  try {
    await page.goto(url)
    const trigger = page.getByRole("button", { name: "View OpenCode logs", exact: true })
    await trigger.click()
    await page.waitForFunction(() => Boolean(document.querySelector('.output-window [role="status"]')))
    await trigger.click()
    await page.locator(".output-window").waitFor({ state: "detached" })
    assert.equal(held.length, 1)
    await held[0]()
    assert.equal(await page.getByText("OLD_LATE", { exact: true }).count(), 0)
    await trigger.click()
    await page.locator('.output-window [role="status"]').waitFor()
    await page.evaluate(() => (window as any).fixture.selectBinary("other-opencode"))
    await page.locator(".output-window").waitFor({ state: "detached" })
    assert.equal(held.length, 2)
    await held[1]()
    assert.equal(await page.getByText("OLD_LATE", { exact: true }).count(), 0)
    assert.equal(await trigger.getAttribute("aria-expanded"), "false")
    assert.deepEqual(errors, [])
  } finally { for (const release of held) await release(); await page.close() }
})

test("real Shell output keeps A across navigation, is literal ANSI, movable and non-modal; Escape closes only the top layer", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  const errors: string[] = [], hostShellReads: string[] = []
  let hostLogsReads = 0
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => {
    if (route.request().url().includes("/shell/")) hostShellReads.push(route.request().url())
    if (new URL(route.request().url()).pathname === "/api/opencode/logs") {
      hostLogsReads++
      return route.fulfill({ json: { path: "/host/opencode.log", text: "HOST_SETTINGS_LOG", truncated: false } })
    }
    return route.fulfill({ json: { state: "ready", serviceState: "ready", binaryPath: "opencode" } })
  })
  try {
    await page.goto(url + "&shell")
    await page.getByRole("button", { name: "Open shell A", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.shellReads.length === 1)
    const dialog = page.locator(".output-window")
    await dialog.waitFor()
    await page.getByRole("button", { name: "Navigate B", exact: true }).click()
    assert.equal(await page.locator("[data-selected]").textContent(), "logsB~same")
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Navigate B")
    assert.equal(await dialog.isVisible(), true)
    assert.notEqual(await dialog.getAttribute("aria-modal"), "true")
    await page.evaluate(() => (window as any).fixture.releaseShell())
    await dialog.locator("pre").waitFor()
    assert.equal(await dialog.locator("pre").textContent(), "A <b>literal</b>\n")
    assert.equal(await dialog.locator("pre b").count(), 0)
    assert.ok(await dialog.locator("pre span").count() > 0)
    const reads = await page.evaluate(() => (window as any).fixture.shellReads)
    assert.ok(reads.every((read: any) => read.owner === "A" && read.url.includes("%2Frepo%2FA")), JSON.stringify(reads))
    assert.deepEqual(hostShellReads, [])
    const box = (await dialog.boundingBox())!, header = (await dialog.locator("header").boundingBox())!
    await page.mouse.move(header.x + 100, header.y + 10)
    await page.mouse.down(); await page.mouse.move(header.x + 160, header.y + 40); await page.mouse.up()
    assert.ok(Math.abs((await dialog.boundingBox())!.x - box.x) > 20)
    await page.evaluate(() => (window as any).fixture.replaceDialog("alert"))
    await page.getByRole("dialog", { name: "Fixture replacement", exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("dialog", { name: "Fixture replacement", exact: true }).waitFor({ state: "detached" })
    assert.equal(await dialog.isVisible(), true)
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })
    await page.getByRole("button", { name: "View OpenCode logs", exact: true }).click()
    await page.getByText("HOST_SETTINGS_LOG", { exact: true }).waitFor()
    assert.equal(hostLogsReads, 1, "host Settings remains explicit host administration while B is selected")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.shellReads.filter((read: any) => read.owner !== "A")), [])
    assert.deepEqual(errors, [])
  } finally { await page.evaluate(() => (window as any).fixture?.releaseShell()); await page.close() }
})
after(async () => { await browser?.close() })

test("logs are read only on demand in a movable non-modal window; refresh and errors are safe", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  let reads = 0, failed = false
  const text = 'role=server <script>window.leaked=true</script> <b>literal</b>\n'
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname === "/api/opencode/logs") {
      reads++
      return route.fulfill(failed ? { status: 502, json: { error: "opencode_logs_failed" } }
        : { json: { path: "/global/opencode/log/opencode.log", text, truncated: true } })
    }
    return route.fulfill({ json: { state: "ready", currentVersion: "2.2.5", latestVersion: "2.2.5", minimumVersion: "2.2.3",
      recommendedVersion: "2.2.5", canUpgrade: false, updateAvailable: false, binaryPath: "opencode", serviceState: "ready" } })
  })
  try {
    await page.goto(url)
    const trigger = page.getByRole("button", { name: "View OpenCode logs", exact: true })
    await trigger.waitFor()
    assert.equal(reads, 0)
    await trigger.click()
    const dialog = page.locator(".output-window")
    await dialog.locator("pre").waitFor()
    assert.notEqual(await dialog.getAttribute("aria-modal"), "true")
    assert.equal(await dialog.locator("pre").textContent(), text)
    assert.equal(await page.evaluate(() => (window as any).leaked), undefined)
    await page.getByRole("button", { name: "Check status and updates", exact: true }).click()
    assert.equal(await dialog.isVisible(), true, "using the rest of Settings keeps the output open")
    await page.locator('button[aria-label="OpenCode Log Level"]').click()
    await page.getByRole("option", { name: "Error", exact: true }).click()
    assert.equal(await dialog.isVisible(), true, "changing log level keeps the same executable's output open")
    const geometry = (await dialog.boundingBox())!
    const header = (await dialog.locator("header").boundingBox())!
    await page.mouse.move(header.x + 100, header.y + 10)
    await page.mouse.down(); await page.mouse.move(header.x + 170, header.y + 45); await page.mouse.up()
    assert.ok(Math.abs((await dialog.boundingBox())!.x - geometry.x) > 20)
    await trigger.click()
    await dialog.waitFor({ state: "detached" })
    await trigger.click()
    await dialog.locator("pre").waitFor()
    assert.equal(reads, 2)
    failed = true
    await dialog.getByRole("button", { name: "Refresh", exact: true }).click()
    await dialog.getByRole("alert").waitFor()
    failed = false
    await dialog.getByRole("button", { name: "Refresh", exact: true }).click()
    await dialog.locator("pre").waitFor()
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })
    assert.equal(await trigger.getAttribute("aria-expanded"), "false")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
