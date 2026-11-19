import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "environment-variables-editor", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/environment-variables-editor.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test("saved names are read-only and selectable while values and new names remain editable", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json:
    new URL(route.request().url()).pathname === "/api/storage/config/server"
      ? { environmentVariables: { FIXTURE_KEY: "original" }, secureEnvVars: [] } : {} }))
  try {
    await page.goto(url)
    const name = page.getByTitle("Variable name (read-only)", { exact: true }).first()
    await name.waitFor()
    assert.equal(await name.evaluate((input: HTMLInputElement) => input.readOnly), true)
    assert.equal(await name.isDisabled(), false)
    await name.focus()
    await page.keyboard.press("ControlOrMeta+a")
    assert.equal(await name.evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart!, input.selectionEnd!)), "FIXTURE_KEY")
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await page.keyboard.press("ControlOrMeta+c")
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "FIXTURE_KEY")
    await page.keyboard.type("RENAMED_KEY")
    assert.equal(await name.inputValue(), "FIXTURE_KEY")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.writes), [])

    await page.getByPlaceholder("Variable value", { exact: true }).first().fill("changed")
    await page.waitForFunction(() => (window as any).fixture.writes.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.writes), [{ environmentVariables: { FIXTURE_KEY: "changed" } }])
    await page.getByPlaceholder("Variable name", { exact: true }).last().fill("NEW_KEY")
    await page.getByPlaceholder("Variable value", { exact: true }).last().fill("new-value")
    await page.getByTitle("Add variable", { exact: true }).click()
    await page.getByRole("textbox", { name: "Variable name (read-only)", exact: true }).nth(1).waitFor()
    assert.equal(await page.getByRole("textbox", { name: "Variable name (read-only)", exact: true }).nth(1).inputValue(), "NEW_KEY")
    await page.waitForFunction(() => (window as any).fixture.writes.length >= 2)
    assert.deepEqual((await page.evaluate(() => (window as any).fixture.writes))[1], { environmentVariables: { FIXTURE_KEY: "changed", NEW_KEY: "new-value" } })

    await page.evaluate(() => (window as any).fixture.setDisabled(true))
    assert.equal(await name.isDisabled(), true)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
