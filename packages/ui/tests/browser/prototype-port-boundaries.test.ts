import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  ;({ url } = await borrowFixture({ name: "prototype-port-boundaries", routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/prototype-port-boundaries.tsx"></script></body></html>' }] }))
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("moved plugin/integration owners retain remote status without host construction, binding demand or writes", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const remote = page.locator('[data-owner="remote"]')
    const local = page.locator('[data-owner="local-shared"]')
    assert.equal(await remote.getByRole("checkbox").isDisabled(), true)
    assert.equal(await remote.locator("[data-add] button, [data-actions] button").count(), 0)
    await remote.getByRole("checkbox").dispatchEvent("change")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls().filter((call: any) => call.instanceId === "remote").map((call: any) => call.method).sort()), ["integrations", "plugins"])
    assert.equal(await remote.locator('[data-module-sections="1"]').count(), 1)
    assert.equal(await remote.locator('[data-application-state="ok"]').count(), 1)
    assert.equal(await remote.locator('[data-conversation-action], [data-line="application"] .window-text-button').count(), 0)
    assert.equal(await local.getByRole("checkbox").isEnabled(), true)
    assert.equal(await local.locator("[data-add] button, [data-actions] button").count(), 2)
    await local.getByRole("checkbox").click()
    await page.waitForFunction(() => (window as any).fixture.calls().some((call: any) => call.instanceId === "local-shared" && call.method === "mutate"))
    const methods = await page.evaluate(() => (window as any).fixture.calls().map((call: any) => call.method))
    assert.ok(methods.includes("integrations") && methods.includes("plugins") && methods.includes("binding"), "local Status retains inventory and binding demand")
    assert.equal(await local.locator('[data-line="application"] .window-text-button').count(), 1, "local host installation remains available")
    await page.evaluate(() => (window as any).fixture.retireLocal())
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[data-owner="local-shared"] input')?.disabled)
    assert.equal(await local.locator("[data-add] button, [data-actions] button").count(), 0)
    await local.getByRole("checkbox").dispatchEvent("change")
    const retired = await page.evaluate(() => (window as any).fixture.calls().map((call: any) => call.method))
    assert.equal(retired.filter((method: string) => method === "mutate").length, 1)
    assert.ok(retired.includes("integrations-release") && retired.includes("plugins-release"))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
