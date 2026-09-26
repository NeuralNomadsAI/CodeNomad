import assert from "node:assert/strict"
import { test } from "node:test"
import { startProductFixture } from "./fixtures/product-fixture-server"

test("package actions address native target once across rows and retain pending ownership after hiding", async () => {
  const fixture = await startProductFixture("plugin-packages")
  const page = await fixture.browser.newPage({ viewport: { width: 380, height: 600 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(fixture.url)
    await page.getByRole("button", { name: "Check updates for fixture-plugin@latest" }).first().click()
    assert.equal(await page.locator("main button").count(), 2)
    await page.getByRole("button", { name: "Update fixture-plugin@latest", exact: true }).first().click()
    assert.equal(await page.locator("main button:disabled").count(), 2)
    await page.evaluate(() => (window as any).fixture.setActive(false))
    await page.evaluate(() => (window as any).fixture.setActive(true))
    assert.equal(await page.locator("main button:disabled").count(), 2)
    await page.evaluate(() => (window as any).fixture.reject())
    await page.waitForFunction(() => (window as any).fixture.invalidations() === 2)
    assert.equal(await page.locator("main button:disabled").count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.requests), [
      { action: "check", location: { directory: "/a" }, target: "fixture-plugin@latest" },
      { action: "update", location: { directory: "/a" }, targets: ["fixture-plugin@latest"] },
    ])
    assert.deepEqual(errors, [])
  } finally { await page.close(); await fixture.close() }
})
