import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  url = (await borrowFixture({ name: "opencode-first-click", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/opencode-setup.tsx"></script></body></html>' }] })).url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

for (const mode of ["activation", "troubleshooting", "failed preflight"] as const) test(`${mode}: one restart click during a focus refresh keeps fresh admission`, async () => {
  const page = await browser.newPage()
  let hold = false, restarts = 0, checks = 0
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const checking = new Promise<void>(resolve => { entered = resolve })
  let finishPreflight!: () => void
  const preflightGate = new Promise<void>(resolve => { finishPreflight = resolve })
  await page.route("**/api/**", async route => {
    if (route.request().url().endsWith("/api/opencode/service")) {
      assert.equal(route.request().postDataJSON().restart, true)
      restarts++
    } else if (hold && route.request().url().endsWith("/api/opencode/update")) {
      if (++checks === 1) {
        entered()
        await gate
      } else {
        await preflightGate
        if (mode === "failed preflight") return route.fulfill({ status: 503, json: { error: "service_check_failed" } })
      }
    }
    await route.fulfill({ json: { state: "ready", currentVersion: "2.2.7", latestVersion: "2.2.7",
      minimumVersion: "2.2.3", recommendedVersion: "2.2.7", binaryPath: "opencode2", target: "host",
      canUpgrade: false, canRestart: true, updateAvailable: false,
      daemonVersion: restarts ? "2.2.7" : "2.2.6", serviceState: restarts ? "ready" : "restart_available" } })
  })
  try {
    await page.goto(`${url}?settings`, { waitUntil: "domcontentloaded" })
    if (mode === "troubleshooting") await page.getByText("Troubleshooting", { exact: true }).click()
    const restart = page.getByRole("button", { name: mode === "troubleshooting" ? "Restart OpenCode service" : "Restart shared service", exact: true })
    await restart.waitFor()
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'))
    await restart.scrollIntoViewIfNeeded()
    const bounds = await restart.boundingBox()
    assert.ok(bounds)
    hold = true
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await checking
    const preflight = page.waitForRequest(request => request.url().endsWith("/api/opencode/update"))
    // Raw pointer input deliberately does not wait for the refresh to enable the button.
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    if (mode === "troubleshooting") {
      await page.getByRole("dialog", { name: "Restart OpenCode service", exact: true }).getByRole("button", { name: "Restart OpenCode service", exact: true }).click()
    }
    await preflight
    assert.equal(await restart.isDisabled(), true, "an admitted action still excludes duplicate clicks")
    assert.equal(restarts, 0, "the service must wait for fresh admission")
    finishPreflight()
    release()
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'))
    assert.equal(checks, 2, "one click must perform a new pre-action status read, independent of the older focus read")
    assert.equal(restarts, mode === "failed preflight" ? 0 : 1, "only a successful fresh check may admit the single restart")
  } finally {
    release()
    finishPreflight()
    await page.close()
  }
})
