import assert from "node:assert/strict"
import { test } from "node:test"
import { startProductFixture } from "./fixtures/product-fixture-server"

test("service-wide usage dashboard declares scope, bounds requests, fences stale connection reads and stops when disposed", async () => {
  const fixture = await startProductFixture("service-usage"), page = await fixture.browser.newPage({ viewport: { width: 380, height: 1000 }, locale: "en-US" })
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(fixture.url)
    await page.locator(".usage-metrics").waitFor()
    await page.getByText(/Entire connected OpenCode service: all projects, independent clones and subsessions/).waitFor()
    assert.equal(await page.locator(".usage-metrics > div").filter({ has: page.getByText("Input tokens", { exact: true }) }).locator("dd").innerText(), "12,345")
    assert.equal(await page.getByRole("rowheader").innerText(), "fixture/synthetic · high")
    assert.equal(await page.locator("meter").count(), 2)
    assert.equal(await page.locator(".usage-dashboard").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await page.getByLabel("Period", { exact: true }).selectOption("7")
    await page.waitForFunction(() => (window as any).fixture.queries.length === 2)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.queries.map((q: any) => (q.to - q.from) / 86400000)), [30, 7])
    await page.evaluate(() => (window as any).fixture.fail())
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.equal(await page.locator(".usage-metrics").count(), 1)
    await page.evaluate(() => { (window as any).fixture.defer(); (window as any).fixture.refresh() })
    await page.evaluate(() => (window as any).fixture.setInstanceId("other"))
    const steps = page.locator(".usage-metrics > div").filter({ has: page.getByText("Steps", { exact: true }) }).locator("dd")
    await page.waitForFunction(() => [...document.querySelectorAll(".usage-metrics dt")].find(el => el.textContent === "Steps")?.nextElementSibling?.textContent === "7")
    await page.evaluate(() => (window as any).fixture.release())
    assert.equal(await steps.innerText(), "7")
    await page.evaluate(() => (window as any).fixture.setVisible(false))
    const queries = await page.evaluate(() => (window as any).fixture.queries.length)
    await page.evaluate(() => (window as any).fixture.refresh())
    assert.equal(await page.evaluate(() => (window as any).fixture.queries.length), queries)
    assert.deepEqual(errors, [])
  } finally { await page.close(); await fixture.close() }
})

test("Stats is reachable in the real preferences screen", async () => {
  const fixture = await startProductFixture("service-usage"), page = await fixture.browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(`${fixture.url}?parent`)
    await page.locator(".usage-metrics").waitFor()
    assert.equal(await page.getByRole("navigation").getByRole("button", { name: "Stats", exact: true }).getAttribute("aria-current"), "page")
    if (process.env.CODENOMAD_USAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_USAGE_CAPTURE, fullPage: true })
    assert.deepEqual(errors, [])
  } finally { await page.close(); await fixture.close() }
})
