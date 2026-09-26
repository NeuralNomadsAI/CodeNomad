import assert from "node:assert/strict"
import { test } from "node:test"
import { startProductFixture } from "./fixtures/product-fixture-server"
test("MCP source controls persist three states, reconcile failures and fence late location responses", async () => {
  const fixture = await startProductFixture("mcp-code-mode"), page = await fixture.browser.newPage({ viewport: { width: 380, height: 900 }, locale: "en-US" })
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(fixture.url)
    await page.getByText("MCP Code Mode", { exact: true }).click()
    const select = page.getByLabel("fixture · Global", { exact: true })
    for (const mode of ["off", "on", "default"]) {
      await select.selectOption(mode)
      await page.waitForFunction(() => !document.querySelector("select:disabled"))
      assert.equal(await select.inputValue(), mode)
    }
    await page.evaluate(() => (window as any).fixture.fail())
    await select.selectOption("off")
    await page.getByRole("alert").waitFor()
    assert.equal(await select.inputValue(), "default")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.writes.map((item: any) => item.mode)), [false, true, null, false])
    if (process.env.CODENOMAD_MCP_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_MCP_CAPTURE, fullPage: true })
    await page.evaluate(() => { (window as any).fixture.defer(); (window as any).fixture.refresh() })
    await page.evaluate(() => (window as any).fixture.setDirectory("/b"))
    await page.getByLabel("other · Global", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).fixture.release())
    assert.equal(await select.count(), 0)
    assert.deepEqual(errors, [])
  } finally { await page.close(); await fixture.close() }
})
